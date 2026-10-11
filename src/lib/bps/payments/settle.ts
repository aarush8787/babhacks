/**
 * The one entry point the rest of BPS calls to turn an APPROVED verdict
 * into an actual AUSD payout, via x402's facilitator settlement flow.
 *
 * Flow: Verdict -> (gate: authorizesSettlement) -> ERC-3009 authorization,
 * signed by BPS's settlement key -> wrapped as an x402 X-PAYMENT header ->
 * POSTed to the facilitator's /settle -> real tx hash or honest failure.
 */

import type { Verdict } from "../types";
import { authorizesSettlement } from "../evaluate";
import { getSettlementConfig } from "./config";
import { signTransferAuthorization, AUSD_EIP712_DOMAIN_NAME, AUSD_EIP712_DOMAIN_VERSION } from "./ausd";
import { buildPaymentHeader, settleViaFacilitator, type PaymentRequirements } from "./x402";

export interface SettleContractInput {
  contract: { contractId: string; reward: { amount: string; currency: "AUSD" } };
  verdict: Verdict;
  workerAddress: string;
  /** Defaults to `${contractId}:${verdict.evidenceHash}`. */
  idempotencyKey?: string;
}

// Each result variant also carries a permissive string-keyed index
// signature (value type `unknown`) purely so callers storing these as
// generic `Record<string, unknown> & { status: string }` records (e.g. an
// append-only contract ledger) can do so with a single `as` cast instead of
// a double assertion. It does not loosen the discriminated union itself --
// every field below is still concretely typed.

export interface SettledResult {
  [key: string]: unknown;
  status: "settled";
  txHash: string;
  explorerUrl: string;
}

export interface RefusedUnverifiedResult {
  [key: string]: unknown;
  status: "refused_unverified";
  reason: string;
  decision: Verdict["decision"];
}

export interface UnconfiguredResult {
  [key: string]: unknown;
  status: "unconfigured";
  missing: string[];
}

export interface FailedResult {
  [key: string]: unknown;
  status: "failed";
  error: string;
}

export type SettleContractResult =
  | SettledResult
  | RefusedUnverifiedResult
  | UnconfiguredResult
  | FailedResult;

/**
 * Idempotency for retries is NOT enforced in this module.
 *
 * It is enforced by the database: `reserveSettlement()` in `store.ts` inserts
 * a row keyed on `idempotencyKey` into the `settlements` table (primary key
 * `idempotency_key`), and a partial unique index allows at most one row with
 * `status = 'settled'` per contract. Whichever caller's INSERT lands first
 * owns the payout; every concurrent or retried caller -- on this instance,
 * another instance, or after a cold start -- gets `reserved: false` back
 * instead of a second attempt at this function. That guard holds across
 * serverless instances and process restarts, which a module-level `Map`
 * here never could. Callers of `settleContract()` are expected to call
 * `reserveSettlement()` first and only proceed on `reserved: true`.
 */

function defaultIdempotencyKey(contractId: string, evidenceHash: string): string {
  return `${contractId}:${evidenceHash}`;
}

/**
 * Compute atomic AUSD units (6 decimals, matching USDC/AUSD convention)
 * from a decimal-string reward amount like "12.50".
 */
function toAtomicUnits(decimalAmount: string): string {
  const [whole, frac = ""] = decimalAmount.split(".");
  const fracPadded = (frac + "000000").slice(0, 6);
  const atomic = BigInt(whole || "0") * BigInt(1_000_000) + BigInt(fracPadded || "0");
  return atomic.toString();
}

function randomNonce(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export async function settleContract(input: SettleContractInput): Promise<SettleContractResult> {
  const idempotencyKey =
    input.idempotencyKey ?? defaultIdempotencyKey(input.contract.contractId, input.verdict.evidenceHash);
  // idempotencyKey is still computed (and still part of the function's
  // contract) because callers use it as the key for reserveSettlement() /
  // recordSettlement() in store.ts, which is what actually enforces
  // idempotency now. See the module doc comment above.

  // Gate 1: only an APPROVED verdict, via the engine's single named
  // authorization function, may move funds. REJECTED and REVIEW both
  // fall through to this refusal.
  if (!authorizesSettlement(input.verdict)) {
    const result: RefusedUnverifiedResult = {
      status: "refused_unverified",
      reason:
        input.verdict.decision === "REVIEW"
          ? "Verdict is REVIEW, not APPROVED: policy was satisfied but evidence quality is below the authorization floor. No funds may move until a human reviews this."
          : "Verdict is REJECTED: policy was not satisfied. No funds may move.",
      decision: input.verdict.decision,
    };
    return result;
  }

  // Gate 2: refuse, don't throw, if we are not wired to a real signer/RPC/facilitator.
  const config = getSettlementConfig();
  if (config.status === "unconfigured") {
    // This is an environment fact, not a settlement outcome -- re-checked
    // on every call in case config becomes available before a retry.
    return { status: "unconfigured", missing: config.missing };
  }

  try {
    const now = Math.floor(Date.now() / 1000);

    // The payer ("from") is BPS's own treasury/escrow address, derived from
    // the configured settlement private key -- not the AUSD contract
    // address.
    const { privateKeyToAccount } = await import("viem/accounts");
    const payerAccount = privateKeyToAccount(config.privateKey);

    const authorizationInput = {
      from: payerAccount.address,
      to: input.workerAddress as `0x${string}`,
      value: toAtomicUnits(input.contract.reward.amount),
      validAfter: String(now - 60),
      validBefore: String(now + 3600),
      nonce: randomNonce(),
    };

    const signed = await signTransferAuthorization(authorizationInput);

    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: authorizationInput.value,
      asset: config.ausdAddress,
      payTo: input.workerAddress,
      resource: `bps://contract/${input.contract.contractId}`,
      description: `BPS payout for contract ${input.contract.contractId}`,
      maxTimeoutSeconds: 60,
      // MUST match the domain we actually sign with, byte for byte.
      //
      // The facilitator rebuilds the EIP-712 digest from these values to verify
      // our signature. When this said {"AUSD","2"} while ausd.ts signed with
      // {"Agora Dollar","1"}, the facilitator derived a different digest and
      // rejected every authorization with `invalid_exact_evm_signature`.
      // Importing the constants makes divergence impossible.
      extra: { name: AUSD_EIP712_DOMAIN_NAME, version: AUSD_EIP712_DOMAIN_VERSION },
    };

    const header = buildPaymentHeader(requirements, signed);
    const settlement = await settleViaFacilitator(header, requirements, config.facilitatorUrl);

    if (!settlement.success || !settlement.txHash) {
      const result: FailedResult = {
        status: "failed",
        error: settlement.error ?? "facilitator settlement failed with no error detail",
      };
      return result;
    }

    const result: SettledResult = {
      status: "settled",
      txHash: settlement.txHash,
      explorerUrl: `https://sepolia.basescan.org/tx/${settlement.txHash}`,
    };
    return result;
  } catch (err) {
    const result: FailedResult = { status: "failed", error: (err as Error).message };
    return result;
  }
}
