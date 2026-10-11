/**
 * x402 client/server primitives, scoped to the "exact" EVM scheme on
 * Base Sepolia.
 *
 * Shapes and endpoints below are taken from coinbase/x402,
 * specs/x402-specification-v1.md (fetched 2026-10-11), section numbers
 * referenced in comments. The spec's own example 402 body contains the
 * literal string `"X-PAYMENT header is required"`, which is how we confirm
 * the transport header is named `X-PAYMENT` (the spec body text does not
 * spell out the header's wire encoding beyond that; the base64-JSON framing
 * used below matches the client payload shown in section 5.2 and is the
 * widely-documented x402 HTTP transport convention -- flagged as assumed,
 * not independently confirmed from the fetched page, in README.md).
 */

import type { SignedTransferAuthorization } from "./ausd";

export interface PaymentRequirements {
  scheme: "exact";
  network: "base-sepolia";
  /** Atomic token units, decimal string. */
  maxAmountRequired: string;
  /** AUSD contract address. */
  asset: string;
  payTo: string;
  resource: string;
  description: string;
  mimeType?: string;
  outputSchema?: Record<string, unknown> | null;
  maxTimeoutSeconds: number;
  extra?: { name?: string; version?: string } & Record<string, unknown>;
}

export interface Erc3009Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface PaymentPayload {
  x402Version: 1;
  scheme: "exact";
  network: "base-sepolia";
  payload: {
    signature: string;
    authorization: Erc3009Authorization;
  };
}

export interface PaymentRequiredBody {
  x402Version: 1;
  error: string;
  accepts: PaymentRequirements[];
}

export interface SettlementResponse {
  success: boolean;
  errorReason?: string;
  transaction: string;
  network: string;
  payer: string;
}

/**
 * Produce a spec-shaped 402 body (section 5.1). This is the *server* half:
 * BPS's worker-payout endpoint calls this to tell a client what payment it
 * needs before it will release a contract's reward.
 */
export function createPaymentRequired(input: {
  payTo: string;
  asset: string;
  amountAtomic: string;
  resource: string;
  description: string;
  maxTimeoutSeconds?: number;
  extra?: PaymentRequirements["extra"];
}): PaymentRequiredBody {
  return {
    x402Version: 1,
    error: "X-PAYMENT header is required",
    accepts: [
      {
        scheme: "exact",
        network: "base-sepolia",
        maxAmountRequired: input.amountAtomic,
        asset: input.asset,
        payTo: input.payTo,
        resource: input.resource,
        description: input.description,
        maxTimeoutSeconds: input.maxTimeoutSeconds ?? 60,
        extra: input.extra,
      },
    ],
  };
}

/**
 * Parse a 402 JSON body (already decoded from the HTTP response) into its
 * first `PaymentRequirements` entry. Does not fetch -- callers pass in the
 * already-retrieved body so this module stays side-effect-free and testable.
 */
export function parsePaymentRequired(body: unknown): PaymentRequirements {
  if (typeof body !== "object" || body === null) {
    throw new Error("402 body is not an object");
  }
  const parsed = body as Partial<PaymentRequiredBody>;
  if (parsed.x402Version !== 1) {
    throw new Error(`unsupported x402Version: ${String(parsed.x402Version)}`);
  }
  if (!Array.isArray(parsed.accepts) || parsed.accepts.length === 0) {
    throw new Error("402 body has no `accepts` entries");
  }
  const requirements = parsed.accepts[0];
  if (
    requirements.scheme !== "exact" ||
    requirements.network !== "base-sepolia" ||
    typeof requirements.maxAmountRequired !== "string" ||
    typeof requirements.asset !== "string" ||
    typeof requirements.payTo !== "string"
  ) {
    throw new Error("402 body's accepts[0] is not a well-formed exact/base-sepolia PaymentRequirements");
  }
  return requirements as PaymentRequirements;
}

/**
 * Build the base64 `X-PAYMENT` header value from a signed ERC-3009
 * authorization, per section 5.2's `PaymentPayload` JSON shape.
 */
export function buildPaymentHeader(
  requirements: PaymentRequirements,
  authorization: SignedTransferAuthorization,
): string {
  const payload: PaymentPayload = {
    x402Version: 1,
    scheme: "exact",
    network: "base-sepolia",
    payload: {
      signature: authorization.signature,
      authorization: {
        from: authorization.typedData.message.from,
        to: authorization.typedData.message.to,
        value: authorization.typedData.message.value.toString(),
        validAfter: authorization.typedData.message.validAfter.toString(),
        validBefore: authorization.typedData.message.validBefore.toString(),
        nonce: authorization.typedData.message.nonce,
      },
    },
  };
  void requirements; // kept in the signature for symmetry with parsePaymentRequired; not needed to build the header itself
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

export interface FacilitatorSettleResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

/**
 * POST the X-PAYMENT header's decoded payload to the facilitator's
 * `/settle` endpoint (section 7.2) and report what it actually said.
 * Never fabricates success or a tx hash -- if the fetch fails, or the
 * facilitator's JSON doesn't parse, this returns `{ success: false, error }`.
 */
export async function settleViaFacilitator(
  header: string,
  requirements: PaymentRequirements,
  facilitatorUrl: string,
): Promise<FacilitatorSettleResult> {
  let paymentPayload: PaymentPayload;
  try {
    paymentPayload = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return { success: false, error: "X-PAYMENT header did not decode to valid JSON" };
  }

  let response: Response;
  try {
    response = await fetch(`${facilitatorUrl.replace(/\/$/, "")}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: 1,
        paymentPayload,
        paymentRequirements: requirements,
      }),
    });
  } catch (err) {
    return { success: false, error: `facilitator request failed: ${(err as Error).message}` };
  }

  let body: SettlementResponse;
  try {
    body = await response.json();
  } catch {
    return { success: false, error: `facilitator returned non-JSON response (status ${response.status})` };
  }

  if (!response.ok || !body.success) {
    return { success: false, error: body.errorReason ?? `facilitator settlement failed (status ${response.status})` };
  }

  if (!body.transaction) {
    return { success: false, error: "facilitator reported success but gave no transaction hash" };
  }

  return { success: true, txHash: body.transaction };
}
