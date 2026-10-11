import { hashCanonical } from "./canonical";
import { runPredicate, type EvalContext } from "./predicates";
import {
  TRUST_TIERS,
  type Contract,
  type Decision,
  type PredicateResult,
  type ProofPolicy,
  type TrustTier,
  type Verdict,
} from "./types";

export const ENGINE_VERSION = "bps-engine/0.1.0";

/** Tier ordering, strongest first. Index doubles as "how good is this". */
const TIER_RANK: Record<TrustTier, number> = {
  CRYPTOGRAPHIC: 0,
  INDEPENDENT: 1,
  INFERRED: 2,
  SELF_REPORTED: 3,
};

interface TreeEval {
  satisfied: boolean;
  /** Ids of predicates that both ran and passed. */
  contributing: string[];
}

/**
 * Walk the policy tree, recording every leaf result.
 *
 * INDETERMINATE is treated as not-satisfied for boolean purposes: an unanswerable
 * check is never allowed to count in a worker's favour.
 */
function evalTree(
  policy: ProofPolicy,
  ctx: EvalContext,
  sink: Map<string, PredicateResult>,
): TreeEval {
  if (policy.op === "PRED") {
    // A policy may reference the same predicate id once only; first write wins.
    const existing = sink.get(policy.id);
    if (existing) {
      return { satisfied: existing.outcome === "PASS", contributing: existing.outcome === "PASS" ? [policy.id] : [] };
    }
    const verdict = runPredicate(policy, ctx);
    sink.set(policy.id, {
      id: policy.id,
      predicate: policy.predicate,
      label: policy.label,
      outcome: verdict.outcome,
      tier: verdict.tier,
      reason: verdict.reason,
      usedEvidence: verdict.usedEvidence,
    });
    const pass = verdict.outcome === "PASS";
    return { satisfied: pass, contributing: pass ? [policy.id] : [] };
  }

  if (policy.op === "NOT") {
    const inner = evalTree(policy.of, ctx, sink);
    // A negation contributes no positive evidence, so `contributing` stays empty.
    return { satisfied: !inner.satisfied, contributing: [] };
  }

  const children = policy.of.map((child) => evalTree(child, ctx, sink));

  if (policy.op === "ALL") {
    const satisfied = children.every((c) => c.satisfied);
    return {
      satisfied,
      contributing: satisfied ? children.flatMap((c) => c.contributing) : [],
    };
  }

  if (policy.op === "ANY") {
    const met = children.filter((c) => c.satisfied);
    return { satisfied: met.length > 0, contributing: met.flatMap((c) => c.contributing) };
  }

  // ATLEAST
  const met = children.filter((c) => c.satisfied);
  const satisfied = met.length >= policy.n;
  return { satisfied, contributing: satisfied ? met.flatMap((c) => c.contributing) : [] };
}

/**
 * Evaluate an evidence bundle against a funded contract.
 *
 * Determinism guarantee: for a fixed (contract, evidence, issuedChallenges,
 * priorArtifactHashes) this returns an identical verdict, including its hashes.
 * `evaluatedAt` is the sole exception and is excluded from `evidenceHash`.
 */
export function evaluate(contract: Contract, ctx: EvalContext): Verdict {
  const evidenceHash = hashCanonical(ctx.evidence);

  const base = {
    contractId: contract.contractId,
    policyHash: contract.policyHash,
    evidenceHash,
    evaluatedAt: new Date().toISOString(),
    engine: ENGINE_VERSION,
  };

  const emptyCounts = Object.fromEntries(TRUST_TIERS.map((t) => [t, 0])) as Record<TrustTier, number>;

  // Refuse to evaluate evidence that was gathered against a different policy.
  // Without this pin, a policy could be relaxed after the worker committed.
  if (ctx.evidence.policyHash !== contract.policyHash) {
    return {
      ...base,
      decision: "REJECTED",
      policySatisfied: false,
      authorizationNotes: [
        `Evidence cites policy ${ctx.evidence.policyHash.slice(0, 12)}… but the funded contract pins ${contract.policyHash.slice(0, 12)}…. The policy changed after the work was accepted.`,
      ],
      results: [],
      satisfiedTierCounts: emptyCounts,
    };
  }

  if (ctx.evidence.contractId !== contract.contractId) {
    return {
      ...base,
      decision: "REJECTED",
      policySatisfied: false,
      authorizationNotes: [
        `Evidence is addressed to contract ${ctx.evidence.contractId}, not ${contract.contractId}.`,
      ],
      results: [],
      satisfiedTierCounts: emptyCounts,
    };
  }

  const sink = new Map<string, PredicateResult>();
  const tree = evalTree(contract.policy, ctx, sink);
  const results = [...sink.values()];

  // Count tiers only across predicates that actually carried the satisfying set.
  // A passing check on an unused branch must not buy authorization.
  const contributing = new Set(tree.contributing);
  const counts = { ...emptyCounts };
  for (const r of results) {
    if (r.outcome === "PASS" && contributing.has(r.id)) counts[r.tier] += 1;
  }

  const notes: string[] = [];
  const floor = contract.authorizationFloor;

  const cryptographic = counts.CRYPTOGRAPHIC;
  const independent = counts.CRYPTOGRAPHIC + counts.INDEPENDENT;

  let decision: Decision;

  if (!tree.satisfied) {
    decision = "REJECTED";
    const failed = results.filter((r) => r.outcome === "FAIL");
    const unknown = results.filter((r) => r.outcome === "INDETERMINATE");
    if (failed.length) {
      notes.push(`Policy not satisfied. Failed: ${failed.map((f) => f.label).join("; ")}.`);
    }
    if (unknown.length) {
      notes.push(
        `Could not be determined from the evidence: ${unknown.map((f) => f.label).join("; ")}.`,
      );
    }
  } else {
    // The tree says yes. Now ask whether the *quality* of evidence justifies money.
    const shortfalls: string[] = [];
    if (cryptographic < floor.minCryptographic) {
      shortfalls.push(
        `needs ${floor.minCryptographic} cryptographically verified check(s), has ${cryptographic}`,
      );
    }
    if (independent < floor.minIndependent) {
      shortfalls.push(
        `needs ${floor.minIndependent} independent check(s), has ${independent}`,
      );
    }
    const inferredOnly = cryptographic === 0 && counts.INDEPENDENT === 0 && counts.INFERRED > 0;
    if (floor.rejectInferredOnly && inferredOnly) {
      shortfalls.push(
        "the satisfying set rests entirely on model inference, which cannot witness physical events",
      );
    }

    if (shortfalls.length === 0) {
      decision = "APPROVED";
      notes.push(
        `Policy satisfied with ${cryptographic} cryptographic and ${counts.INDEPENDENT} independent check(s). Cleared for settlement.`,
      );
    } else {
      // Deliberately REVIEW, not APPROVED: the work may well be done, but the
      // evidence is too weak to move funds automatically.
      decision = "REVIEW";
      notes.push(
        `Policy satisfied but evidence is below the authorization floor — ${shortfalls.join("; ")}. Held for human review; no payout authorized.`,
      );
    }
  }

  return { ...base, decision, policySatisfied: tree.satisfied, authorizationNotes: notes, results, satisfiedTierCounts: counts };
}

/**
 * The single gate the payments layer is allowed to consult.
 *
 * Keeping this a named function rather than an inline `=== "APPROVED"` means
 * there is exactly one place in the codebase that can authorize money movement.
 */
export function authorizesSettlement(verdict: Verdict): boolean {
  return verdict.decision === "APPROVED";
}

export { TIER_RANK };
