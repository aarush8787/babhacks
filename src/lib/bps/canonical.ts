import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

/**
 * Deterministic JSON encoding: object keys sorted at every depth, no whitespace.
 *
 * Verdict reproducibility depends on this. Two structurally identical policies
 * written with keys in a different order must hash identically, or a policy
 * could be "changed" without changing its meaning and still pass the pin check.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cannot canonicalize non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "undefined") return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      // Drop undefined so an absent key and an explicitly-undefined key agree.
      .filter(([, v]) => typeof v !== "undefined")
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
  }
  throw new Error(`cannot canonicalize ${typeof value}`);
}

export function hashCanonical(value: unknown): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalize(value))));
}

export function hashBytes(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

/**
 * The exact bytes a counterparty is asked to sign.
 *
 * Binding the contract id and role into the signed payload is what stops a
 * signature harvested from one contract being replayed against another.
 */
export function challengePayload(input: {
  contractId: string;
  nonce: string;
  role: string;
}): string {
  return canonicalize({
    contractId: input.contractId,
    domain: "bps.challenge.v1",
    nonce: input.nonce,
    role: input.role,
  });
}
