import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { utf8ToBytes } from "@noble/hashes/utils";
import { challengePayload } from "./canonical";
import type {
  Challenge,
  EvidenceBundle,
  PredicateName,
  PredicateNode,
  PredicateOutcome,
  TrustTier,
} from "./types";

/** Everything a predicate is allowed to see. Predicates are pure over this. */
export interface EvalContext {
  evidence: EvidenceBundle;
  /** Challenges the server issued for this contract. The worker cannot mint these. */
  issuedChallenges: Challenge[];
  deadline: string;
  /** Artifact hashes seen on any *previous* contract. Drives replay detection. */
  priorArtifactHashes: ReadonlySet<string>;
}

export interface PredicateVerdict {
  outcome: PredicateOutcome;
  /** The tier this check actually achieved, which may be lower than its ceiling. */
  tier: TrustTier;
  reason: string;
  usedEvidence: string[];
}

/** The best tier a predicate can ever reach, even when it passes. */
const TIER_CEILING: Record<PredicateName, TrustTier> = {
  signature_valid: "CRYPTOGRAPHIC",
  challenge_fresh: "CRYPTOGRAPHIC",
  distinct_signers: "CRYPTOGRAPHIC",
  object_id_match: "INDEPENDENT",
  within_deadline: "INDEPENDENT",
  ordered_timestamps: "SELF_REPORTED",
  geo_within: "SELF_REPORTED",
  evidence_unique: "INDEPENDENT",
  ai_assertion: "INFERRED",
};

export function tierCeiling(predicate: PredicateName): TrustTier {
  return TIER_CEILING[predicate];
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Great-circle distance in metres. */
function haversineM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function verifyReceiptSignature(
  ctx: EvalContext,
  role: Challenge["role"],
): { ok: boolean; reason: string; used: string[] } {
  const receipt = ctx.evidence.receipts.find((r) => r.role === role);
  if (!receipt) return { ok: false, reason: `no ${role} receipt was submitted`, used: [] };

  const challenge = ctx.issuedChallenges.find(
    (c) => c.nonce === receipt.nonce && c.role === role,
  );
  if (!challenge) {
    return {
      ok: false,
      reason: `${role} receipt cites nonce ${receipt.nonce.slice(0, 10)}… which this contract never issued`,
      used: [receipt.nonce],
    };
  }

  const payload = challengePayload({
    contractId: ctx.evidence.contractId,
    nonce: receipt.nonce,
    role,
  });

  let ok = false;
  try {
    ok = secp.verify(receipt.signature, sha256(utf8ToBytes(payload)), receipt.signerPublicKey);
  } catch {
    // Malformed key or signature encoding is a failure, never a throw.
    return { ok: false, reason: `${role} signature is malformed`, used: [receipt.nonce] };
  }

  return {
    ok,
    reason: ok
      ? `${role} signature verifies against the issued nonce`
      : `${role} signature does not verify for key ${receipt.signerPublicKey.slice(0, 10)}…`,
    used: [receipt.nonce, receipt.signerPublicKey],
  };
}

type PredicateImpl = (node: PredicateNode, ctx: EvalContext) => PredicateVerdict;

const IMPLS: Record<PredicateName, PredicateImpl> = {
  /** A pinned counterparty signed the nonce we issued for this contract. */
  signature_valid: (node, ctx) => {
    const role = (str(node.args, "role") ?? "recipient") as Challenge["role"];
    const { ok, reason, used } = verifyReceiptSignature(ctx, role);
    return {
      outcome: ok ? "PASS" : "FAIL",
      tier: ok ? "CRYPTOGRAPHIC" : "SELF_REPORTED",
      reason,
      usedEvidence: used,
    };
  },

  /** The nonce exists, has not expired, and has not been spent before. */
  challenge_fresh: (node, ctx) => {
    const role = (str(node.args, "role") ?? "recipient") as Challenge["role"];
    const receipt = ctx.evidence.receipts.find((r) => r.role === role);
    if (!receipt) {
      return {
        outcome: "FAIL",
        tier: "SELF_REPORTED",
        reason: `no ${role} receipt to check freshness for`,
        usedEvidence: [],
      };
    }
    const challenge = ctx.issuedChallenges.find(
      (c) => c.nonce === receipt.nonce && c.role === role,
    );
    if (!challenge) {
      return {
        outcome: "FAIL",
        tier: "SELF_REPORTED",
        reason: `nonce was not issued for role ${role}`,
        usedEvidence: [receipt.nonce],
      };
    }
    const signedAt = Date.parse(receipt.signedAt);
    const expires = Date.parse(challenge.expiresAt);
    const issued = Date.parse(challenge.issuedAt);

    // A spent nonce is spent, full stop.
    //
    // An earlier version compared `consumedAt` against the receipt's `signedAt`
    // and only flagged a replay when consumption preceded the signature. That is
    // unsound: `signedAt` is worker-supplied, so backdating it defeated the check.
    // Freshness must not depend on a timestamp the adversary controls.
    if (challenge.consumedAt) {
      return {
        outcome: "FAIL",
        tier: "SELF_REPORTED",
        reason: `nonce was already consumed at ${challenge.consumedAt} — replay`,
        usedEvidence: [receipt.nonce],
      };
    }
    if (!Number.isFinite(signedAt)) {
      return {
        outcome: "FAIL",
        tier: "SELF_REPORTED",
        reason: "receipt carries an unparseable timestamp",
        usedEvidence: [receipt.nonce],
      };
    }
    if (signedAt > expires) {
      return {
        outcome: "FAIL",
        tier: "SELF_REPORTED",
        reason: `nonce expired at ${challenge.expiresAt}, signed at ${receipt.signedAt}`,
        usedEvidence: [receipt.nonce],
      };
    }
    if (signedAt < issued) {
      return {
        outcome: "FAIL",
        tier: "SELF_REPORTED",
        reason: "receipt is dated before the nonce was issued",
        usedEvidence: [receipt.nonce],
      };
    }
    return {
      outcome: "PASS",
      tier: "CRYPTOGRAPHIC",
      reason: "nonce is unspent and within its validity window",
      usedEvidence: [receipt.nonce],
    };
  },

  /**
   * At least n receipts from *different* keys.
   *
   * Independence is the whole point: one person signing both ends of a handoff
   * proves nothing, so colluding keys must be distinct to count.
   */
  distinct_signers: (node, ctx) => {
    const need = num(node.args, "n") ?? 2;
    const verified = new Set<string>();
    for (const receipt of ctx.evidence.receipts) {
      const { ok } = verifyReceiptSignature(ctx, receipt.role);
      if (ok) verified.add(receipt.signerPublicKey);
    }
    const ok = verified.size >= need;
    return {
      outcome: ok ? "PASS" : "FAIL",
      tier: ok ? "CRYPTOGRAPHIC" : "SELF_REPORTED",
      reason: `${verified.size} distinct key(s) produced a verifying signature; ${need} required`,
      usedEvidence: [...verified],
    };
  },

  /** The object handed over is the object that was asked for. */
  object_id_match: (node, ctx) => {
    const expected = str(node.args, "objectId");
    const declared = ctx.evidence.declaredObjectId;
    if (!expected) {
      return {
        outcome: "INDETERMINATE",
        tier: "SELF_REPORTED",
        reason: "contract did not pin an object identifier",
        usedEvidence: [],
      };
    }
    if (!declared) {
      return {
        outcome: "FAIL",
        tier: "SELF_REPORTED",
        reason: "no object identifier was submitted",
        usedEvidence: [],
      };
    }
    const ok = declared.trim().toLowerCase() === expected.trim().toLowerCase();
    return {
      outcome: ok ? "PASS" : "FAIL",
      // Only independent because both ends signed over the same contract id.
      tier: ok ? "INDEPENDENT" : "SELF_REPORTED",
      reason: ok
        ? `submitted object id matches the contract (${expected})`
        : `expected object ${expected}, got ${declared}`,
      usedEvidence: [declared],
    };
  },

  /** Work finished before the contract's deadline. Server clock, not worker clock. */
  within_deadline: (node, ctx) => {
    const submitted = Date.parse(ctx.evidence.submittedAt);
    const due = Date.parse(ctx.deadline);
    if (!Number.isFinite(submitted) || !Number.isFinite(due)) {
      return {
        outcome: "INDETERMINATE",
        tier: "SELF_REPORTED",
        reason: "deadline or submission time is unparseable",
        usedEvidence: [],
      };
    }
    const ok = submitted <= due;
    return {
      outcome: ok ? "PASS" : "FAIL",
      tier: ok ? "INDEPENDENT" : "SELF_REPORTED",
      reason: ok
        ? `submitted ${Math.round((due - submitted) / 60000)} min before deadline`
        : `submitted ${Math.round((submitted - due) / 60000)} min after deadline`,
      usedEvidence: [ctx.evidence.submittedAt],
    };
  },

  /** Pickup really did precede delivery. Worker-controlled clocks, hence low tier. */
  ordered_timestamps: (node, ctx) => {
    const first = (str(node.args, "before") ?? "pickup") as Challenge["role"];
    const second = (str(node.args, "after") ?? "recipient") as Challenge["role"];
    const a = ctx.evidence.receipts.find((r) => r.role === first);
    const b = ctx.evidence.receipts.find((r) => r.role === second);
    if (!a || !b) {
      return {
        outcome: "FAIL",
        tier: "SELF_REPORTED",
        reason: `need both ${first} and ${second} receipts to order them`,
        usedEvidence: [],
      };
    }
    const ok = Date.parse(a.signedAt) <= Date.parse(b.signedAt);
    return {
      outcome: ok ? "PASS" : "FAIL",
      tier: "SELF_REPORTED",
      reason: ok
        ? `${first} signed before ${second}`
        : `${second} signed before ${first} — impossible ordering`,
      usedEvidence: [a.signedAt, b.signedAt],
    };
  },

  /**
   * Reported position is near the target.
   *
   * Capped at SELF_REPORTED on purpose. Device GPS is trivially spoofed, so this
   * can corroborate a story but must never be load-bearing.
   */
  geo_within: (node, ctx) => {
    const lat = num(node.args, "lat");
    const lon = num(node.args, "lon");
    const radius = num(node.args, "radiusM") ?? 100;
    if (lat === undefined || lon === undefined) {
      return {
        outcome: "INDETERMINATE",
        tier: "SELF_REPORTED",
        reason: "contract did not pin a target coordinate",
        usedEvidence: [],
      };
    }
    if (ctx.evidence.geo.length === 0) {
      return {
        outcome: "FAIL",
        tier: "SELF_REPORTED",
        reason: "no location samples were submitted",
        usedEvidence: [],
      };
    }
    const best = ctx.evidence.geo
      .map((g) => ({ g, d: haversineM(g, { lat, lon }) }))
      .sort((x, y) => x.d - y.d)[0];
    const ok = best.d <= radius;
    return {
      outcome: ok ? "PASS" : "FAIL",
      tier: "SELF_REPORTED",
      reason: ok
        ? `closest sample was ${Math.round(best.d)} m from target (limit ${radius} m)`
        : `closest sample was ${Math.round(best.d)} m from target, outside the ${radius} m limit`,
      usedEvidence: [best.g.capturedAt],
    };
  },

  /** No submitted artifact has been used to claim a previous contract. */
  evidence_unique: (node, ctx) => {
    const reused = ctx.evidence.artifactHashes.filter((h) => ctx.priorArtifactHashes.has(h));
    if (ctx.evidence.artifactHashes.length === 0) {
      return {
        outcome: "INDETERMINATE",
        tier: "SELF_REPORTED",
        reason: "no artifacts were submitted to check for reuse",
        usedEvidence: [],
      };
    }
    const ok = reused.length === 0;
    return {
      outcome: ok ? "PASS" : "FAIL",
      tier: ok ? "INDEPENDENT" : "SELF_REPORTED",
      reason: ok
        ? `all ${ctx.evidence.artifactHashes.length} artifact(s) are previously unseen`
        : `artifact ${reused[0].slice(0, 12)}… was already submitted for an earlier contract`,
      usedEvidence: reused.length ? reused : ctx.evidence.artifactHashes,
    };
  },

  /**
   * A model's reading of the evidence.
   *
   * Hard-capped at INFERRED no matter what confidence the model reports. A model
   * cannot witness the physical world; it can only describe pixels it was handed.
   */
  ai_assertion: (node, ctx) => {
    const threshold = num(node.args, "minConfidence") ?? 0.75;
    const claim = str(node.args, "claim") ?? node.id;
    const assertion = ctx.evidence.aiAssertions.find((a) => a.claim === claim);
    if (!assertion) {
      return {
        outcome: "INDETERMINATE",
        tier: "INFERRED",
        reason: `no model assertion was recorded for "${claim}"`,
        usedEvidence: [],
      };
    }
    if (assertion.over.length === 0) {
      return {
        outcome: "FAIL",
        tier: "INFERRED",
        reason: "model reported a conclusion without citing any artifact",
        usedEvidence: [],
      };
    }
    const ok = assertion.holds && assertion.confidence >= threshold;
    return {
      outcome: ok ? "PASS" : "FAIL",
      tier: "INFERRED",
      reason: ok
        ? `${assertion.model} affirms "${claim}" at ${assertion.confidence.toFixed(2)} confidence (inferred, not proof)`
        : `${assertion.model} did not affirm "${claim}" above ${threshold} (got ${assertion.confidence.toFixed(2)})`,
      usedEvidence: assertion.over,
    };
  },
};

export function runPredicate(node: PredicateNode, ctx: EvalContext): PredicateVerdict {
  const impl = IMPLS[node.predicate];
  if (!impl) {
    // An unknown predicate must never read as satisfied.
    return {
      outcome: "FAIL",
      tier: "SELF_REPORTED",
      reason: `engine has no implementation for predicate "${node.predicate}"`,
      usedEvidence: [],
    };
  }
  return impl(node, ctx);
}

export const SUPPORTED_PREDICATES = Object.keys(IMPLS) as PredicateName[];
