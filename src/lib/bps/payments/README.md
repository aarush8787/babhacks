# BPS payments layer: AUSD settlement via x402

This directory is the only place in BPS that is allowed to move money. It
turns an engine `Verdict` into a real AUSD transfer on Base Sepolia, using
Coinbase's x402 protocol and AUSD's ERC-3009 gasless-transfer support.

## The flow

```
Verdict (from src/lib/bps/evaluate.ts)
  -> settleContract() checks authorizesSettlement(verdict)
     -> REJECTED / REVIEW: refused_unverified, nothing signed, nothing sent
     -> APPROVED: continue
  -> getSettlementConfig() checks env
     -> missing anything: unconfigured, nothing signed, nothing sent
     -> configured: continue
  -> ausd.ts builds + signs an EIP-712 TransferWithAuthorization
     (ERC-3009 `transferWithAuthorization`), signed by BPS's settlement
     key as the payer ("from"), with the worker's address as "to".
     This step costs no gas: it's an off-chain signature.
  -> x402.ts wraps that signature + authorization as a PaymentPayload and
     base64-encodes it into an X-PAYMENT-shaped header value.
  -> x402.ts POSTs that header's payload to the facilitator's /settle,
     which is the party that actually broadcasts `transferWithAuthorization`
     on-chain and pays the gas for it.
  -> settle.ts reports settled (with the facilitator's real tx hash) only
     if the facilitator's JSON response said success: true and gave a
     transaction hash. Any other outcome is `failed`, with the
     facilitator's own error reason, never a fabricated hash.
```

`settleContract()` in `settle.ts` is the single function the rest of the app
should call.

## Environment variables needed to go live

| Variable | Purpose |
| --- | --- |
| `BPS_SETTLEMENT_PRIVATE_KEY` | Hex private key (32 bytes) of BPS's treasury/escrow signer. This account is the `from` in every authorization — it must hold AUSD and never needs ETH for gas, since it only ever signs, never submits transactions. |
| `BPS_BASE_SEPOLIA_RPC_URL` | HTTPS RPC endpoint for Base Sepolia, used for read-only calls (`readAusdBalance`). |
| `BPS_AUSD_ADDRESS` | AUSD's ERC-20 contract address on Base Sepolia. Defaults to the address below if unset. |
| `BPS_X402_FACILITATOR_URL` | Base URL of an x402 facilitator exposing `POST /settle` (and ideally `/verify`, `/supported`). |

With none of these set, `getSettlementConfig()` returns
`{ status: "unconfigured", missing: [...] }` and `settleContract()` returns
`{ status: "unconfigured", missing }` — verified directly (see "Verification"
below): with every var unset it reports `missing: ["BPS_SETTLEMENT_PRIVATE_KEY", "BPS_BASE_SEPOLIA_RPC_URL", "BPS_X402_FACILITATOR_URL"]` (AUSD address is not
listed as missing because it has a default).

## What was CONFIRMED from docs vs. assumed

**Confirmed**, by fetching `https://docs.agora.finance/developer/contract-deployments.md`
on 2026-10-11:

- AUSD's address on Base Sepolia is listed as
  `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC` (also listed, identically, for
  Arbitrum Sepolia, Avalanche Fuji, Ethereum Sepolia, Katana testnet, Mantle
  testnet, Monad testnet, Optimism Sepolia, and Polygon Amoy — consistent
  with a deterministic/CREATE2 multi-chain deployment, but we did not
  independently verify the deployed bytecode or verify this on
  sepolia.basescan.org ourselves). This is the default baked into
  `config.ts`; `BPS_AUSD_ADDRESS` always overrides it.

**NOT confirmed** from the pages we could fetch:

- That AUSD's deployed contract actually implements ERC-3009
  (`transferWithAuthorization` / `receiveWithAuthorization`). Agora's
  `developer/advanced-erc-features.md` page describes ERC-3009 gasless
  transfers as a concept, but the fetched content never states, in the same
  breath, that AUSD implements it. The task brief asserts AUSD supports
  ERC-3009; we could not independently verify that claim from the page
  content retrieved via WebFetch. If the deployed AUSD contract does not
  implement `transferWithAuthorization`, every signed authorization this
  module produces will fail (revert) at facilitator-settlement time — it
  will NOT silently succeed, because `settleViaFacilitator` only reports
  `settled` on an explicit `success: true` + tx hash from the facilitator.
- AUSD's exact EIP-712 domain `name`/`version` (`DOMAIN_SEPARATOR` inputs).
  We use `"AUSD"` / `"2"` in `ausd.ts`, matching the convention ERC-3009
  tokens commonly use (and mirroring the `"USDC"`/`"2"` example in x402's
  own spec). If AUSD's real domain differs, every signature here will fail
  EIP-712 verification on-chain. This is the single highest-risk assumption
  in this module and is called out at its definition
  (`AUSD_EIP712_DOMAIN_NAME` / `AUSD_EIP712_DOMAIN_VERSION` in `ausd.ts`).

From `https://github.com/coinbase/x402`,
`specs/x402-specification-v1.md` (fetched directly, 2026-10-11) — **confirmed
by direct quote**:

- The 402 body shape (`x402Version`, `error`, `accepts: PaymentRequirements[]`)
  and that the spec's own example error string is literally
  `"X-PAYMENT header is required"` — which is how we confirm the transport
  header is named `X-PAYMENT`, even though this particular markdown file
  never states the header's base64-JSON wire encoding explicitly in the text
  we read.
- `PaymentPayload`'s shape: `{ x402Version, scheme, network, payload: { signature, authorization } }`,
  and `authorization`'s fields (`from, to, value, validAfter, validBefore, nonce`).
- The EIP-712 `TransferWithAuthorization` type layout (quoted verbatim in
  `ausd.ts`).
- The facilitator's `/verify` and `/settle` request shape
  (`{ x402Version, paymentPayload, paymentRequirements }`) and `/settle`'s
  response shape (`{ success, errorReason?, transaction, network, payer }`).

**Assumed, not independently confirmed from the fetched markdown text**:

- That the `X-PAYMENT` header's value is the base64 encoding of the
  `PaymentPayload` JSON object (as opposed to some other header-specific
  framing). This is the widely-documented x402 HTTP-transport convention
  and is what `buildPaymentHeader` / `settleViaFacilitator` implement, but
  the one spec file we fetched describes the JSON shapes without spelling
  out "base64-encode this JSON into this header" in the sentences we
  retrieved.

## Limitations (read before treating this as production-ready)

1. **In-memory idempotency only.** `settle.ts`'s `settlementLedger` is a
   plain `Map` in process memory. It deduplicates retries that land on the
   same warm process, but a serverless cold start (Vercel functions
   included) gets a fresh, empty map — a retry after a cold start, or on a
   different instance, will NOT be caught by this guard and could pay
   twice. Going to production requires a persistent idempotency store
   (e.g., a database row for the idempotency key, written atomically with
   the payout).
2. **EIP-712 domain is assumed, not confirmed** (see above). Wrong domain
   name/version means every signature fails on-chain verification. This
   would surface as a `failed` result from the facilitator, not a false
   success — but it does mean the happy path may not work against the real
   contract until this is checked against AUSD's actual
   `eip712Domain()`/`DOMAIN_SEPARATOR` output.
3. **ERC-3009 support on AUSD is asserted by the hackathon brief, not
   verified by us from docs.** See above.
4. **No `/verify` call before `/settle`.** The x402 spec describes verify
   as a separate, cheaper pre-check. `settle.ts` goes straight to `/settle`
   for simplicity; a production integration should call `/verify` first and
   surface `invalidReason` before ever attempting settlement.
5. **No on-chain balance pre-check.** `readAusdBalance` exists and works
   but `settleContract` does not call it before signing — it relies on the
   facilitator's own balance check (per spec step 2 of `/verify`/`/settle`)
   to reject insufficient-funds cases.
6. **AUSD atomic units assumed to be 6 decimals** (the USDC/AUSD stablecoin
   convention), not read from the contract's `decimals()`. If AUSD uses a
   different decimal count, `toAtomicUnits` in `settle.ts` will compute the
   wrong transfer amount.
7. **No automated test suite.** Verification here was manual: `tsc --noEmit`
   (zero errors) and a compiled-and-run check of `getSettlementConfig()`
   with no env vars set, confirming it returns
   `{ status: "unconfigured", missing: [...] }` rather than throwing.

## Files

- `config.ts` — reads env, returns the configured/unconfigured discriminated
  union. Never logs the private key.
- `ausd.ts` — ERC-3009 `TransferWithAuthorization` typed-data construction,
  signing (gasless), and a real `balanceOf` read over the configured RPC.
- `x402.ts` — 402 body construction (server side), 402 parsing and
  `X-PAYMENT` header construction (client side), and the facilitator
  `/settle` call.
- `settle.ts` — `settleContract()`, the only entry point. Enforces the
  `authorizesSettlement` gate, the unconfigured refusal, in-process
  idempotency, and returns a `settled | refused_unverified | unconfigured | failed`
  discriminated union.
