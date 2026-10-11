/**
 * BPS core domain types.
 *
 * These types are the contract between the four subsystems:
 *   compiler  (natural language -> ProofPolicy)
 *   engine    (ProofPolicy + Evidence -> Verdict)
 *   payments  (Verdict -> x402/AUSD settlement)
 *   ui        (renders policy + verdict trace)
 *
 * Nothing here may depend on React, Next, or any network client.
 */

/**
 * How much a given piece of evidence can actually be trusted.
 *
 * This distinction is the heart of BPS: an LLM saying "the photo looks right"
 * is NOT the same class of claim as a counterparty signing a one-time nonce.
 * The engine enforces that difference (see `authorizationFloor`).
 */
export type TrustTier =
  /** Verified by cryptography. A key we pinned signed a payload we chose. */
  | "CRYPTOGRAPHIC"
  /** Asserted by a party with no incentive to help the worker cheat. */
  | "INDEPENDENT"
  /** Inferred by a model. Probabilistic. Never sufficient on its own. */
  | "INFERRED"
  /** The worker said so. Carries no evidentiary weight by itself. */
  | "SELF_REPORTED";

export const TRUST_TIERS: readonly TrustTier[] = [
  "CRYPTOGRAPHIC",
  "INDEPENDENT",
  "INFERRED",
  "SELF_REPORTED",
] as const;

/** Predicates the engine knows how to execute. The compiler may only emit these. */
export type PredicateName =
  | "signature_valid"
  | "challenge_fresh"
  | "distinct_signers"
  | "object_id_match"
  | "within_deadline"
  | "ordered_timestamps"
  | "geo_within"
  | "evidence_unique"
  | "ai_assertion";

/** A single leaf check in a policy tree. */
export interface PredicateNode {
  op: "PRED";
  /** Stable id, unique within a policy. Used by the UI and the verdict trace. */
  id: string;
  predicate: PredicateName;
  /** Predicate-specific parameters. Validated per-predicate at compile time. */
  args: Record<string, unknown>;
  /** Human-readable, shown to both the agent funding the task and the worker. */
  label: string;
}

/** Boolean combinators over predicates. */
export type ProofPolicy =
  | PredicateNode
  | { op: "ALL"; of: ProofPolicy[] }
  | { op: "ANY"; of: ProofPolicy[] }
  | { op: "ATLEAST"; n: number; of: ProofPolicy[] }
  | { op: "NOT"; of: ProofPolicy };

/** Contract types the compiler supports. Anything else is refused, not invented. */
export type ContractKind =
  | "physical_delivery"
  | "physical_observation"
  | "device_state_change";

export interface Contract {
  contractId: string;
  kind: ContractKind;
  /** The operator's original words. Kept verbatim for audit. */
  sourceText: string;
  reward: { amount: string; currency: "AUSD" };
  /** ISO 8601. */
  deadline: string;
  policy: ProofPolicy;
  /**
   * sha256 over the canonical encoding of `policy`. Pinned at funding time so a
   * policy cannot be weakened after a worker commits to it.
   */
  policyHash: string;
  /**
   * Minimum evidentiary quality required before funds may move. Independent of
   * whether the policy tree evaluates true -- see engine docs.
   */
  authorizationFloor: AuthorizationFloor;
  /** Conditions the compiler could not express as executable checks. */
  unverifiable: string[];
  createdAt: string;
}

/**
 * Guard against a policy that is satisfiable purely by worker-controlled claims.
 * A tree of `ai_assertion` leaves can evaluate `true` while proving nothing.
 */
export interface AuthorizationFloor {
  /** Satisfied predicates at this tier or better, required to authorize payout. */
  minCryptographic: number;
  minIndependent: number;
  /** If true, an INFERRED-only satisfying set routes to REVIEW rather than APPROVED. */
  rejectInferredOnly: boolean;
}

/** A one-time challenge bound to a contract and issued to a specific role. */
export interface Challenge {
  nonce: string;
  contractId: string;
  /** Who is expected to sign this. */
  role: "worker" | "pickup" | "recipient" | "witness";
  issuedAt: string;
  expiresAt: string;
  /** Set once consumed. Replay of a consumed nonce fails `challenge_fresh`. */
  consumedAt?: string;
}

export interface SignedReceipt {
  /** Hex-encoded compressed secp256k1 public key of the signer. */
  signerPublicKey: string;
  /** The nonce the signer was asked to sign. */
  nonce: string;
  /** Hex secp256k1 signature over the canonical challenge payload. */
  signature: string;
  /** Signer's claimed role. Cross-checked against the issued challenge. */
  role: Challenge["role"];
  signedAt: string;
}

export interface GeoPoint {
  lat: number;
  lon: number;
  /** Reported accuracy in metres, if the device provided one. */
  accuracyM?: number;
  capturedAt: string;
}

/** Everything the worker submits, plus anything independent parties contributed. */
export interface EvidenceBundle {
  contractId: string;
  /** Must equal the contract's policyHash or the engine refuses to evaluate. */
  policyHash: string;
  workerId: string;
  submittedAt: string;
  receipts: SignedReceipt[];
  geo: GeoPoint[];
  /** sha256 of each uploaded artifact. The bytes live elsewhere. */
  artifactHashes: string[];
  /** Worker-declared identifier for the object in transit, if any. */
  declaredObjectId?: string;
  /**
   * Model outputs. Deliberately segregated: the engine tags every one of these
   * INFERRED, regardless of the confidence the model reports.
   */
  aiAssertions: AiAssertion[];
}

export interface AiAssertion {
  /** Which claim this addresses, matching a predicate id. */
  claim: string;
  holds: boolean;
  /** Model's self-reported confidence in [0,1]. Treated as a hint, never a proof. */
  confidence: number;
  model: string;
  /** Artifact hashes the model actually looked at. */
  over: string[];
}

export type PredicateOutcome = "PASS" | "FAIL" | "INDETERMINATE";

/** Per-predicate result, with enough detail to explain the verdict to a human. */
export interface PredicateResult {
  id: string;
  predicate: PredicateName;
  label: string;
  outcome: PredicateOutcome;
  tier: TrustTier;
  /** Why it passed or failed, in plain language. */
  reason: string;
  /** Evidence this check actually consumed, by hash or identifier. */
  usedEvidence: string[];
}

export type Decision = "APPROVED" | "REJECTED" | "REVIEW";

export interface Verdict {
  contractId: string;
  policyHash: string;
  /** sha256 over the canonical evidence bundle. Makes the verdict replayable. */
  evidenceHash: string;
  decision: Decision;
  /** True iff the boolean policy tree was satisfied. */
  policySatisfied: boolean;
  /** Why the decision differs from `policySatisfied`, when it does. */
  authorizationNotes: string[];
  results: PredicateResult[];
  satisfiedTierCounts: Record<TrustTier, number>;
  evaluatedAt: string;
  /** Engine version. A verdict is only reproducible against the same version. */
  engine: string;
}
