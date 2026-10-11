/**
 * Server-side in-memory store for BPS.
 *
 * NO DATABASE. This is a documented limitation: everything here lives in
 * process memory, stashed on `globalThis` so Next.js dev HMR (which
 * re-evaluates modules but not the global object) doesn't reset state on
 * every edit. Restarting the server loses all data except the seeded demo
 * scenarios, which are re-seeded from `DEMO_SCENARIOS` on first access.
 *
 * This module enforces the BPS lifecycle state machine. Every transition
 * must go through `transition()` (or the narrow helpers built on it) so the
 * append-only `events` log and the legality checks can never be bypassed.
 */

import type {
  Challenge,
  Contract,
  EvidenceBundle,
  Verdict,
} from "./types";
import { DEMO_SCENARIOS } from "./fixtures";

export type ContractState =
  | "DRAFT"
  | "FUNDED"
  | "ACCEPTED"
  | "SUBMITTED"
  | "VERIFIED"
  | "REJECTED"
  | "REVIEW"
  | "SETTLED";

/** Settlement result, as returned verbatim by settleContract. Stored as-is. */
export type SettlementRecord = Record<string, unknown> & { status: string };

export interface LifecycleEvent {
  timestamp: string;
  from: ContractState | null;
  to: ContractState;
  actor: string;
  note: string;
}

export interface ContractRecord {
  contract: Contract;
  state: ContractState;
  warnings: string[];
  workerAddress?: string;
  challenges: Challenge[];
  evidence: EvidenceBundle[];
  verdicts: Verdict[];
  settlement?: SettlementRecord;
  events: LifecycleEvent[];
}

/** Thrown for any illegal lifecycle transition. Never swallow this. */
export class LifecycleError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LifecycleError";
    this.code = code;
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/** Legal state transitions. Anything not listed here is refused. */
const ALLOWED_TRANSITIONS: Record<ContractState, ContractState[]> = {
  DRAFT: ["FUNDED"],
  FUNDED: ["ACCEPTED"],
  ACCEPTED: ["SUBMITTED"],
  SUBMITTED: ["VERIFIED", "REJECTED", "REVIEW"],
  VERIFIED: ["SETTLED"],
  REJECTED: [],
  REVIEW: ["SETTLED", "SUBMITTED"], // a human may re-run evaluation after review, or settle after manual override
  SETTLED: [],
};

const CHALLENGE_TTL_MS = 15 * 60 * 1000; // 15 minute validity window

interface BpsGlobalStore {
  contracts: Map<string, ContractRecord>;
  seenArtifactHashes: Set<string>;
  seeded: boolean;
}

declare global {
  // eslint-disable-next-line no-var
  var __bpsStore: BpsGlobalStore | undefined;
}

function freshStore(): BpsGlobalStore {
  return {
    contracts: new Map(),
    seenArtifactHashes: new Set(),
    seeded: false,
  };
}

function getStore(): BpsGlobalStore {
  if (!globalThis.__bpsStore) {
    globalThis.__bpsStore = freshStore();
  }
  const store = globalThis.__bpsStore;
  if (!store.seeded) {
    store.seeded = true;
    seedFromDemoScenarios(store);
  }
  return store;
}

function seedFromDemoScenarios(store: BpsGlobalStore): void {
  for (const scenario of DEMO_SCENARIOS) {
    if (store.contracts.has(scenario.contract.contractId)) continue;
    const record: ContractRecord = {
      contract: scenario.contract,
      state: "FUNDED",
      warnings: [],
      challenges: scenario.issuedChallenges ?? [],
      evidence: [],
      verdicts: [],
      events: [
        {
          timestamp: scenario.contract.createdAt,
          from: null,
          to: "FUNDED",
          actor: "system:seed",
          note: `Seeded from demo scenario "${scenario.id}": ${scenario.title}`,
        },
      ],
    };
    store.contracts.set(scenario.contract.contractId, record);
    for (const hash of scenario.priorArtifactHashes ?? []) {
      store.seenArtifactHashes.add(hash);
    }
  }
}

function recordEvent(
  record: ContractRecord,
  to: ContractState,
  actor: string,
  note: string,
): void {
  record.events.push({
    timestamp: new Date().toISOString(),
    from: record.state,
    to,
    actor,
    note,
  });
}

/** The single gate for every state change. Throws LifecycleError on an illegal move. */
function transition(
  record: ContractRecord,
  to: ContractState,
  actor: string,
  note: string,
): void {
  const allowed = ALLOWED_TRANSITIONS[record.state] ?? [];
  if (!allowed.includes(to)) {
    throw new LifecycleError(
      "illegal_transition",
      `Cannot move contract ${record.contract.contractId} from ${record.state} to ${to}. Allowed: ${allowed.join(", ") || "(none, terminal state)"}.`,
    );
  }
  record.state = to;
  recordEvent(record, to, actor, note);
}

function getRecordOrThrow(contractId: string): ContractRecord {
  const record = getStore().contracts.get(contractId);
  if (!record) {
    throw new NotFoundError(`No contract with id ${contractId}`);
  }
  return record;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function listContracts(): ContractRecord[] {
  return [...getStore().contracts.values()];
}

export function getContract(contractId: string): ContractRecord {
  return getRecordOrThrow(contractId);
}

export function tryGetContract(contractId: string): ContractRecord | undefined {
  return getStore().contracts.get(contractId);
}

/** Insert a freshly compiled contract into the store as FUNDED. */
export function createFundedContract(
  contract: Contract,
  warnings: string[],
): ContractRecord {
  const store = getStore();
  const record: ContractRecord = {
    contract,
    state: "DRAFT",
    warnings,
    challenges: [],
    evidence: [],
    verdicts: [],
    events: [
      {
        timestamp: new Date().toISOString(),
        from: null,
        to: "DRAFT",
        actor: "system:compile",
        note: "Contract compiled from source text.",
      },
    ],
  };
  store.contracts.set(contract.contractId, record);
  transition(record, "FUNDED", "system:api", "Reward funded at creation time.");
  return record;
}

/** A worker accepts a FUNDED contract. Only one worker may ever accept. */
export function acceptContract(
  contractId: string,
  workerAddress: string,
): ContractRecord {
  const record = getRecordOrThrow(contractId);
  if (record.state === "ACCEPTED" || record.workerAddress) {
    if (record.workerAddress && record.workerAddress !== workerAddress) {
      throw new LifecycleError(
        "already_accepted",
        `Contract ${contractId} was already accepted by a different worker.`,
      );
    }
    if (record.state !== "FUNDED") {
      throw new LifecycleError(
        "already_accepted",
        `Contract ${contractId} has already been accepted.`,
      );
    }
  }
  record.workerAddress = workerAddress;
  transition(record, "ACCEPTED", `worker:${workerAddress}`, "Worker accepted the contract.");
  return record;
}

/** Issue a one-time challenge nonce for a role. Requires ACCEPTED or later, pre-settlement. */
export function issueChallenge(
  contractId: string,
  role: Challenge["role"],
): Challenge {
  const record = getRecordOrThrow(contractId);
  if (record.state === "DRAFT" || record.state === "FUNDED") {
    throw new LifecycleError(
      "not_accepted",
      `Contract ${contractId} must be ACCEPTED before challenges can be issued (currently ${record.state}).`,
    );
  }
  if (record.state === "SETTLED" || record.state === "REJECTED") {
    throw new LifecycleError(
      "terminal_state",
      `Contract ${contractId} is in terminal state ${record.state}; no new challenges may be issued.`,
    );
  }
  const now = Date.now();
  const challenge: Challenge = {
    nonce: crypto.randomUUID(),
    contractId,
    role,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CHALLENGE_TTL_MS).toISOString(),
  };
  record.challenges.push(challenge);
  return challenge;
}

/** Mark a nonce consumed. Idempotent-ish: consuming twice is a no-op past the first. */
export function consumeChallenge(nonce: string): Challenge | undefined {
  const store = getStore();
  for (const record of store.contracts.values()) {
    const challenge = record.challenges.find((c) => c.nonce === nonce);
    if (challenge) {
      if (!challenge.consumedAt) {
        challenge.consumedAt = new Date().toISOString();
      }
      return challenge;
    }
  }
  return undefined;
}

/** Evidence may only be submitted once the contract has been ACCEPTED (or is already SUBMITTED/REVIEW, for resubmission). */
export function submitEvidence(
  contractId: string,
  evidence: EvidenceBundle,
): ContractRecord {
  const record = getRecordOrThrow(contractId);
  if (record.state === "DRAFT" || record.state === "FUNDED") {
    throw new LifecycleError(
      "not_accepted",
      `Evidence cannot be submitted before the contract is ACCEPTED (currently ${record.state}).`,
    );
  }
  if (record.state === "SETTLED" || record.state === "REJECTED") {
    throw new LifecycleError(
      "terminal_state",
      `Contract ${contractId} is in terminal state ${record.state}; evidence can no longer be submitted.`,
    );
  }
  if (record.state === "ACCEPTED") {
    transition(record, "SUBMITTED", `worker:${record.workerAddress ?? "unknown"}`, "Evidence submitted.");
  }
  record.evidence.push(evidence);
  return record;
}

/** Persist a verdict and move the state machine per the engine's decision. */
export function recordVerdict(contractId: string, verdict: Verdict): ContractRecord {
  const record = getRecordOrThrow(contractId);
  record.verdicts.push(verdict);

  const target =
    verdict.decision === "APPROVED"
      ? "VERIFIED"
      : verdict.decision === "REJECTED"
        ? "REJECTED"
        : "REVIEW";

  transition(
    record,
    target,
    "system:engine",
    `Evaluated evidence: decision=${verdict.decision}.`,
  );
  return record;
}

export function addSeenArtifactHashes(hashes: string[]): void {
  const store = getStore();
  for (const h of hashes) store.seenArtifactHashes.add(h);
}

export function getPriorArtifactHashes(): ReadonlySet<string> {
  return getStore().seenArtifactHashes;
}

/** Settlement is only legal once VERIFIED, and only once. */
export function recordSettlement(
  contractId: string,
  settlement: SettlementRecord,
): ContractRecord {
  const record = getRecordOrThrow(contractId);
  if (record.state !== "VERIFIED") {
    throw new LifecycleError(
      "not_verified",
      `Contract ${contractId} cannot be settled unless it is VERIFIED (currently ${record.state}).`,
    );
  }
  if (record.settlement) {
    throw new LifecycleError(
      "already_settled",
      `Contract ${contractId} has already been settled.`,
    );
  }
  record.settlement = settlement;
  if (settlement.status === "settled") {
    transition(record, "SETTLED", "system:payments", `Settlement completed: status=${settlement.status}.`);
  } else {
    // Settlement attempted but did not actually move funds (refused/unconfigured/failed).
    // Stay in VERIFIED so a retry remains possible; log the attempt either way.
    recordEvent(record, "VERIFIED", "system:payments", `Settlement attempt did not settle: status=${settlement.status}.`);
  }
  return record;
}

/** Guard a settlement attempt against being issued twice, without mutating state. */
export function assertSettleable(contractId: string): ContractRecord {
  const record = getRecordOrThrow(contractId);
  if (record.settlement?.status === "settled") {
    throw new LifecycleError(
      "already_settled",
      `Contract ${contractId} has already been settled.`,
    );
  }
  if (record.state !== "VERIFIED") {
    throw new LifecycleError(
      "not_verified",
      `Contract ${contractId} cannot be settled unless it is VERIFIED (currently ${record.state}).`,
    );
  }
  const verdict = record.verdicts[record.verdicts.length - 1];
  if (!verdict || verdict.decision !== "APPROVED") {
    throw new LifecycleError(
      "not_approved",
      `Contract ${contractId} has no APPROVED verdict on file.`,
    );
  }
  return record;
}

export function latestVerdict(record: ContractRecord): Verdict | undefined {
  return record.verdicts[record.verdicts.length - 1];
}
