import { DEMO_SCENARIOS } from "./fixtures";
import { getDb } from "./db";
import type { SettleContractResult } from "./payments/settle";
import type { Challenge, Contract, EvidenceBundle, Verdict } from "./types";

/**
 * Durable lifecycle store.
 *
 * Two drivers sit behind one async API: Postgres (`durable`) and process memory
 * (`ephemeral`). The Postgres driver is the real one -- every concurrency
 * guarantee is expressed as a database constraint or a conditional UPDATE, so
 * it holds across serverless instances and cold starts:
 *
 *   one worker per contract   UPDATE ... WHERE worker_address IS NULL
 *   nonce spent exactly once  UPDATE ... WHERE consumed_at IS NULL
 *   artifact reuse detected   INSERT ... ON CONFLICT DO NOTHING
 *   payout happens once       PRIMARY KEY (idempotency_key)
 *                             + partial UNIQUE INDEX on status = 'settled'
 *   legal transitions only    UPDATE ... WHERE state = ANY($from)
 *
 * The ephemeral driver cannot offer any of that under concurrency, which is why
 * `settlementAllowed()` returns false for it and the settle route refuses.
 */

export type ContractState =
  | "DRAFT"
  | "FUNDED"
  | "ACCEPTED"
  | "SUBMITTED"
  | "VERIFIED"
  | "REJECTED"
  | "REVIEW"
  | "SETTLED";

/**
 * A settlement row as stored.
 *
 * `pending` is the reservation stub written by `reserveSettlement()` before the
 * facilitator is contacted -- it is a real persisted state that
 * `SettleContractResult` does not model, so the union makes it explicit rather
 * than letting a `pending` row masquerade as a finished outcome at runtime.
 */
export type SettlementRecord = SettleContractResult | { status: "pending" };

export interface LifecycleEvent {
  timestamp: string;
  from: ContractState | null;
  to: ContractState;
  actor: string;
  note?: string;
}

export interface ContractRecord {
  contract: Contract;
  state: ContractState;
  warnings: string[];
  workerAddress?: string;
  challenges: Challenge[];
  evidence: EvidenceBundle[];
  verdicts: Verdict[];
  /** The verdict that produced `state`. Settlement consults this, not recency. */
  currentVerdict?: Verdict;
  settlement?: SettlementRecord;
  events: LifecycleEvent[];
}

export class LifecycleError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LifecycleError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

const CHALLENGE_TTL_MS = 15 * 60 * 1000;

/**
 * Cast a domain value for a `jsonb` column.
 *
 * postgres.js types `sql.json()` against its own structural `JSONValue`, which
 * our interface-typed domain objects do not satisfy nominally even though they
 * are plain JSON-serializable data. One helper keeps the cast in a single
 * reviewable place instead of scattering assertions through every query.
 */
type PgJson = Parameters<ReturnType<typeof getDb> extends { sql: infer S } ? S extends { json: (v: infer A) => unknown } ? (v: A) => void : never : never>[0];

function toJson(value: unknown): PgJson {
  return value as PgJson;
}

/**
 * Legal state transitions.
 *
 * SETTLED is the only terminal state. A rejection is recoverable -- a worker
 * whose proof was incomplete may resubmit -- but once money has moved, no
 * further evidence can be accepted, because a fresh verdict could otherwise
 * authorize a second payout.
 */
const ALLOWED_TRANSITIONS: Record<ContractState, ContractState[]> = {
  DRAFT: ["FUNDED"],
  FUNDED: ["ACCEPTED"],
  ACCEPTED: ["SUBMITTED"],
  SUBMITTED: ["VERIFIED", "REJECTED", "REVIEW"],
  VERIFIED: ["SETTLED", "SUBMITTED"],
  REJECTED: ["SUBMITTED"],
  REVIEW: ["SETTLED", "SUBMITTED"],
  SETTLED: [],
};

function assertTransitionLegal(from: ContractState, to: ContractState, contractId: string): void {
  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new LifecycleError(
      "illegal_transition",
      `Cannot move contract ${contractId} from ${from} to ${to}. Allowed: ${allowed.join(", ") || "(none, terminal state)"}.`,
    );
  }
}

/** Settlement requires durable idempotency. See db.ts. */
export function settlementAllowed(): boolean {
  return getDb().mode === "durable";
}

// ---------------------------------------------------------------------------
// Ephemeral driver
// ---------------------------------------------------------------------------

interface MemStore {
  contracts: Map<string, ContractRecord>;
  seenArtifacts: Map<string, string>; // hash -> contractId that first claimed it
  seeded: boolean;
}

type Globals = typeof globalThis & { __bpsMem?: MemStore };

function mem(): MemStore {
  const g = globalThis as Globals;
  if (!g.__bpsMem) {
    g.__bpsMem = { contracts: new Map(), seenArtifacts: new Map(), seeded: false };
  }
  if (!g.__bpsMem.seeded) {
    g.__bpsMem.seeded = true;
    for (const s of DEMO_SCENARIOS) {
      if (g.__bpsMem.contracts.has(s.contract.contractId)) continue;
      g.__bpsMem.contracts.set(s.contract.contractId, {
        contract: s.contract,
        state: "FUNDED",
        warnings: [],
        challenges: [...s.issuedChallenges],
        evidence: [],
        verdicts: [],
        events: [
          { timestamp: new Date().toISOString(), from: null, to: "DRAFT", actor: "system:seed" },
          { timestamp: new Date().toISOString(), from: "DRAFT", to: "FUNDED", actor: "system:seed" },
        ],
      });
      for (const h of s.priorArtifactHashes ?? []) {
        g.__bpsMem.seenArtifacts.set(h, "seed");
      }
    }
  }
  return g.__bpsMem;
}

// ---------------------------------------------------------------------------
// Row mapping (durable driver)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function rowToContract(r: Row): Contract {
  return {
    contractId: r.contract_id as string,
    kind: r.kind as Contract["kind"],
    sourceText: r.source_text as string,
    reward: { amount: r.reward_amount as string, currency: r.reward_currency as "AUSD" },
    deadline: new Date(r.deadline as string).toISOString(),
    policy: r.policy as Contract["policy"],
    policyHash: r.policy_hash as string,
    authorizationFloor: r.authorization_floor as Contract["authorizationFloor"],
    unverifiable: (r.unverifiable as string[]) ?? [],
    createdAt: new Date(r.created_at as string).toISOString(),
  };
}

function rowToChallenge(r: Row): Challenge {
  return {
    nonce: r.nonce as string,
    contractId: r.contract_id as string,
    role: r.role as Challenge["role"],
    issuedAt: new Date(r.issued_at as string).toISOString(),
    expiresAt: new Date(r.expires_at as string).toISOString(),
    consumedAt: r.consumed_at ? new Date(r.consumed_at as string).toISOString() : undefined,
  };
}

function rowToSettlement(r: Row): SettlementRecord {
  return { status: r.status, ...(r.detail as object) } as SettlementRecord;
}

// ---------------------------------------------------------------------------
// Seeding (durable driver)
// ---------------------------------------------------------------------------

let seedPromise: Promise<void> | null = null;

async function ensureSeeded(): Promise<void> {
  const db = getDb();
  if (db.mode !== "durable") return;
  // Seed at most once per instance, and idempotently across instances.
  if (!seedPromise) {
    seedPromise = (async () => {
      const sql = db.sql;
      for (const s of DEMO_SCENARIOS) {
        const c = s.contract;
        await sql`
          insert into contracts (
            contract_id, kind, source_text, reward_amount, reward_currency, deadline,
            policy, policy_hash, authorization_floor, unverifiable, warnings, state, created_at
          ) values (
            ${c.contractId}, ${c.kind}, ${c.sourceText}, ${c.reward.amount}, ${c.reward.currency},
            ${c.deadline}, ${sql.json(toJson(c.policy))}, ${c.policyHash}, ${sql.json(toJson(c.authorizationFloor))},
            ${sql.json(toJson(c.unverifiable))}, ${sql.json(toJson([]))}, 'FUNDED', ${c.createdAt}
          )
          on conflict (contract_id) do nothing`;
        for (const ch of s.issuedChallenges) {
          await sql`
            insert into challenges (nonce, contract_id, role, issued_at, expires_at, consumed_at)
            values (${ch.nonce}, ${c.contractId}, ${ch.role}, ${ch.issuedAt}, ${ch.expiresAt}, ${ch.consumedAt ?? null})
            on conflict (nonce) do nothing`;
        }
        for (const h of s.priorArtifactHashes ?? []) {
          await sql`
            insert into artifact_hashes (hash, contract_id) values (${h}, ${c.contractId})
            on conflict (hash) do nothing`;
        }
      }
    })().catch((err) => {
      // Allow a later request to retry rather than poisoning the instance.
      seedPromise = null;
      throw err;
    });
  }
  return seedPromise;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function loadRecord(contractId: string): Promise<ContractRecord | undefined> {
  const db = getDb();
  if (db.mode === "ephemeral") return mem().contracts.get(contractId);

  await ensureSeeded();
  const sql = db.sql;
  const [c] = await sql`select * from contracts where contract_id = ${contractId}`;
  if (!c) return undefined;

  const [challenges, evidence, verdicts, settlements, events] = await Promise.all([
    sql`select * from challenges where contract_id = ${contractId} order by issued_at`,
    sql`select * from evidence_bundles where contract_id = ${contractId} order by id`,
    sql`select * from verdicts where contract_id = ${contractId} order by id`,
    sql`select * from settlements where contract_id = ${contractId} order by created_at desc limit 1`,
    sql`select * from lifecycle_events where contract_id = ${contractId} order by id`,
  ]);

  return {
    contract: rowToContract(c as Row),
    state: (c as Row).state as ContractState,
    warnings: ((c as Row).warnings as string[]) ?? [],
    workerAddress: ((c as Row).worker_address as string | null) ?? undefined,
    challenges: (challenges as Row[]).map(rowToChallenge),
    evidence: (evidence as Row[]).map((r) => r.bundle as EvidenceBundle),
    verdicts: (verdicts as Row[]).map((r) => r.verdict as Verdict),
    currentVerdict: (() => {
      const hash = (c as Row).current_verdict_hash as string | null;
      if (!hash) return undefined;
      const row = (verdicts as Row[]).find((r) => r.evidence_hash === hash);
      return row ? (row.verdict as Verdict) : undefined;
    })(),
    settlement: settlements.length ? rowToSettlement(settlements[0] as Row) : undefined,
    events: (events as Row[]).map((r) => ({
      timestamp: new Date(r.created_at as string).toISOString(),
      from: (r.from_state as ContractState | null) ?? null,
      to: r.to_state as ContractState,
      actor: r.actor as string,
      note: (r.note as string | null) ?? undefined,
    })),
  };
}

export async function tryGetContract(contractId: string): Promise<ContractRecord | undefined> {
  return loadRecord(contractId);
}

export async function getContract(contractId: string): Promise<ContractRecord> {
  const record = await loadRecord(contractId);
  if (!record) throw new NotFoundError(`No contract with id ${contractId}`);
  return record;
}

export async function listContracts(): Promise<ContractRecord[]> {
  const db = getDb();
  if (db.mode === "ephemeral") return [...mem().contracts.values()];
  await ensureSeeded();
  const rows = await db.sql`select contract_id from contracts order by created_at desc limit 100`;
  const records = await Promise.all((rows as Row[]).map((r) => loadRecord(r.contract_id as string)));
  return records.filter((r): r is ContractRecord => Boolean(r));
}

/** Record a lifecycle event and move state, refusing illegal or raced transitions. */
async function transition(
  contractId: string,
  from: ContractState,
  to: ContractState,
  actor: string,
  note?: string,
): Promise<void> {
  assertTransitionLegal(from, to, contractId);
  const db = getDb();

  if (db.mode === "ephemeral") {
    const rec = mem().contracts.get(contractId);
    if (!rec) throw new NotFoundError(`No contract with id ${contractId}`);
    rec.state = to;
    rec.events.push({ timestamp: new Date().toISOString(), from, to, actor, note });
    return;
  }

  const sql = db.sql;
  // The `state = ${from}` predicate is the race guard: if another instance
  // already moved this contract, zero rows update and we refuse rather than
  // clobbering their transition.
  const updated = await sql`
    update contracts set state = ${to}
    where contract_id = ${contractId} and state = ${from}
    returning contract_id`;
  if (updated.length === 0) {
    const [cur] = await sql`select state from contracts where contract_id = ${contractId}`;
    throw new LifecycleError(
      "illegal_transition",
      cur
        ? `Contract ${contractId} is in state ${(cur as Row).state}, not ${from}; another request changed it first.`
        : `No contract with id ${contractId}`,
    );
  }
  await sql`
    insert into lifecycle_events (contract_id, from_state, to_state, actor, note)
    values (${contractId}, ${from}, ${to}, ${actor}, ${note ?? null})`;
}

export async function createFundedContract(
  contract: Contract,
  warnings: string[],
): Promise<ContractRecord> {
  const db = getDb();

  if (db.mode === "ephemeral") {
    const rec: ContractRecord = {
      contract,
      state: "DRAFT",
      warnings,
      challenges: [],
      evidence: [],
      verdicts: [],
      events: [{ timestamp: new Date().toISOString(), from: null, to: "DRAFT", actor: "system:compile" }],
    };
    mem().contracts.set(contract.contractId, rec);
    await transition(contract.contractId, "DRAFT", "FUNDED", "system:api", "Reward funded at creation time.");
    return (await getContract(contract.contractId));
  }

  const sql = db.sql;
  await sql`
    insert into contracts (
      contract_id, kind, source_text, reward_amount, reward_currency, deadline,
      policy, policy_hash, authorization_floor, unverifiable, warnings, state, created_at
    ) values (
      ${contract.contractId}, ${contract.kind}, ${contract.sourceText}, ${contract.reward.amount},
      ${contract.reward.currency}, ${contract.deadline}, ${sql.json(toJson(contract.policy))}, ${contract.policyHash},
      ${sql.json(toJson(contract.authorizationFloor))}, ${sql.json(toJson(contract.unverifiable))}, ${sql.json(toJson(warnings))},
      'DRAFT', ${contract.createdAt}
    )
    on conflict (contract_id) do nothing`;
  await sql`
    insert into lifecycle_events (contract_id, from_state, to_state, actor, note)
    values (${contract.contractId}, null, 'DRAFT', 'system:compile', 'Contract compiled from source text.')`;
  await transition(contract.contractId, "DRAFT", "FUNDED", "system:api", "Reward funded at creation time.");
  return getContract(contract.contractId);
}

/**
 * A worker accepts a FUNDED contract.
 *
 * In durable mode the `worker_address is null` predicate makes this atomic:
 * concurrent accepts produce exactly one winner, so an exclusive task cannot be
 * handed to two people.
 */
export async function acceptContract(
  contractId: string,
  workerAddress: string,
): Promise<ContractRecord> {
  const db = getDb();

  if (db.mode === "ephemeral") {
    const rec = mem().contracts.get(contractId);
    if (!rec) throw new NotFoundError(`No contract with id ${contractId}`);
    if (rec.workerAddress && rec.workerAddress !== workerAddress) {
      throw new LifecycleError("already_accepted", `Contract ${contractId} was already accepted by a different worker.`);
    }
    if (rec.workerAddress === workerAddress && rec.state !== "FUNDED") return rec;
    rec.workerAddress = workerAddress;
    await transition(contractId, "FUNDED", "ACCEPTED", `worker:${workerAddress}`, "Worker accepted the contract.");
    return rec;
  }

  const sql = db.sql;
  const claimed = await sql`
    update contracts set worker_address = ${workerAddress}, state = 'ACCEPTED'
    where contract_id = ${contractId} and state = 'FUNDED' and worker_address is null
    returning contract_id`;

  if (claimed.length === 0) {
    const [cur] = await sql`select state, worker_address from contracts where contract_id = ${contractId}`;
    if (!cur) throw new NotFoundError(`No contract with id ${contractId}`);
    const row = cur as Row;
    if (row.worker_address && row.worker_address !== workerAddress) {
      throw new LifecycleError("already_accepted", `Contract ${contractId} was already accepted by a different worker.`);
    }
    // Same worker re-accepting an already-accepted contract is a no-op.
    if (row.worker_address === workerAddress) return getContract(contractId);
    throw new LifecycleError(
      "illegal_transition",
      `Contract ${contractId} cannot be accepted from state ${row.state}.`,
    );
  }

  await sql`
    insert into lifecycle_events (contract_id, from_state, to_state, actor, note)
    values (${contractId}, 'FUNDED', 'ACCEPTED', ${`worker:${workerAddress}`}, 'Worker accepted the contract.')`;
  return getContract(contractId);
}

export async function issueChallenge(contractId: string, role: Challenge["role"]): Promise<Challenge> {
  const record = await getContract(contractId);
  if (record.state === "DRAFT" || record.state === "FUNDED") {
    throw new LifecycleError(
      "not_accepted",
      `Contract ${contractId} must be ACCEPTED before challenges can be issued (currently ${record.state}).`,
    );
  }
  if (record.state === "SETTLED") {
    throw new LifecycleError("terminal_state", `Contract ${contractId} has settled; no new challenges may be issued.`);
  }

  const now = Date.now();
  const challenge: Challenge = {
    nonce: crypto.randomUUID(),
    contractId,
    role,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CHALLENGE_TTL_MS).toISOString(),
  };

  const db = getDb();
  if (db.mode === "ephemeral") {
    mem().contracts.get(contractId)?.challenges.push(challenge);
    return challenge;
  }
  await db.sql`
    insert into challenges (nonce, contract_id, role, issued_at, expires_at)
    values (${challenge.nonce}, ${contractId}, ${role}, ${challenge.issuedAt}, ${challenge.expiresAt})`;
  return challenge;
}

/**
 * Spend a nonce. Returns the challenge only if THIS call consumed it.
 *
 * The `consumed_at is null` predicate is what makes replay protection real:
 * two instances racing to spend the same nonce yield exactly one winner.
 */
export async function consumeChallenge(nonce: string): Promise<Challenge | undefined> {
  const db = getDb();
  if (db.mode === "ephemeral") {
    for (const rec of mem().contracts.values()) {
      const ch = rec.challenges.find((c) => c.nonce === nonce);
      if (ch) {
        if (!ch.consumedAt) ch.consumedAt = new Date().toISOString();
        return ch;
      }
    }
    return undefined;
  }
  const rows = await db.sql`
    update challenges set consumed_at = now()
    where nonce = ${nonce} and consumed_at is null
    returning *`;
  return rows.length ? rowToChallenge(rows[0] as Row) : undefined;
}

export async function submitEvidence(
  contractId: string,
  evidence: EvidenceBundle,
  evidenceHash: string,
): Promise<ContractRecord> {
  const record = await getContract(contractId);
  if (record.state === "DRAFT" || record.state === "FUNDED") {
    throw new LifecycleError(
      "not_accepted",
      `Evidence cannot be submitted before the contract is ACCEPTED (currently ${record.state}).`,
    );
  }
  if (record.state === "SETTLED") {
    throw new LifecycleError(
      "terminal_state",
      `Contract ${contractId} has already settled; evidence can no longer be submitted.`,
    );
  }
  if (record.state !== "SUBMITTED") {
    await transition(contractId, record.state, "SUBMITTED", `worker:${record.workerAddress ?? "unknown"}`, "Evidence submitted.");
  }

  const db = getDb();
  if (db.mode === "ephemeral") {
    mem().contracts.get(contractId)?.evidence.push(evidence);
  } else {
    await db.sql`
      insert into evidence_bundles (contract_id, evidence_hash, bundle)
      values (${contractId}, ${evidenceHash}, ${db.sql.json(toJson(evidence))})`;
  }
  return getContract(contractId);
}

export async function recordVerdict(contractId: string, verdict: Verdict): Promise<ContractRecord> {
  const db = getDb();
  const target: ContractState =
    verdict.decision === "APPROVED" ? "VERIFIED" : verdict.decision === "REJECTED" ? "REJECTED" : "REVIEW";

  if (db.mode === "ephemeral") {
    mem().contracts.get(contractId)?.verdicts.push(verdict);
  } else {
    await db.sql`
      insert into verdicts (contract_id, decision, evidence_hash, policy_hash, verdict)
      values (${contractId}, ${verdict.decision}, ${verdict.evidenceHash}, ${verdict.policyHash}, ${db.sql.json(toJson(verdict))})
      on conflict (contract_id, evidence_hash) do nothing`;
  }

  await transition(contractId, "SUBMITTED", target, "system:engine", `Evaluated evidence: decision=${verdict.decision}.`);
  await setCurrentVerdict(contractId, verdict);
  return getContract(contractId);
}

/**
 * Register artifact hashes and report which were already claimed elsewhere.
 *
 * Returns the subset that had previously been seen on a DIFFERENT contract --
 * exactly what the `evidence_unique` predicate needs. Scoping the query to the
 * hashes actually submitted keeps this O(bundle) rather than O(all history).
 */
export async function getPriorArtifactHashes(
  contractId: string,
  hashes: string[],
): Promise<ReadonlySet<string>> {
  if (hashes.length === 0) return new Set();
  const db = getDb();

  if (db.mode === "ephemeral") {
    const seen = mem().seenArtifacts;
    return new Set(hashes.filter((h) => seen.has(h) && seen.get(h) !== contractId));
  }
  const rows = await db.sql`
    select hash from artifact_hashes
    where hash in ${db.sql(hashes)} and contract_id <> ${contractId}`;
  return new Set((rows as Row[]).map((r) => r.hash as string));
}

export async function addSeenArtifactHashes(contractId: string, hashes: string[]): Promise<void> {
  if (hashes.length === 0) return;
  const db = getDb();
  if (db.mode === "ephemeral") {
    for (const h of hashes) if (!mem().seenArtifacts.has(h)) mem().seenArtifacts.set(h, contractId);
    return;
  }
  for (const h of hashes) {
    await db.sql`
      insert into artifact_hashes (hash, contract_id) values (${h}, ${contractId})
      on conflict (hash) do nothing`;
  }
}

/**
 * Claim the exclusive right to settle, before any money moves.
 *
 * In durable mode the settlements primary key is the reservation: whichever
 * caller inserts the idempotency key first owns the payout, and every
 * concurrent or retried caller gets `reserved: false` plus the existing row.
 * This is the guard that makes double payment impossible across instances.
 */
export async function reserveSettlement(
  contractId: string,
  idempotencyKey: string,
): Promise<{ reserved: boolean; existing?: SettlementRecord }> {
  const db = getDb();
  if (db.mode === "ephemeral") {
    throw new LifecycleError(
      "ephemeral_state",
      "Settlement requires durable storage; BPS_DATABASE_URL is not configured.",
    );
  }
  const sql = db.sql;
  const inserted = await sql`
    insert into settlements (idempotency_key, contract_id, status, detail)
    values (${idempotencyKey}, ${contractId}, 'pending', '{}'::jsonb)
    on conflict (idempotency_key) do nothing
    returning idempotency_key`;
  if (inserted.length > 0) return { reserved: true };

  const [row] = await sql`select * from settlements where idempotency_key = ${idempotencyKey}`;
  return { reserved: false, existing: row ? rowToSettlement(row as Row) : undefined };
}

/** Write the outcome of a settlement attempt against its reservation. */
export async function recordSettlement(
  contractId: string,
  idempotencyKey: string,
  settlement: SettlementRecord,
): Promise<ContractRecord> {
  const db = getDb();
  if (db.mode === "ephemeral") {
    throw new LifecycleError("ephemeral_state", "Settlement requires durable storage.");
  }
  const sql = db.sql;
  const txHash = (settlement as { txHash?: string }).txHash ?? null;
  const explorerUrl = (settlement as { explorerUrl?: string }).explorerUrl ?? null;

  await sql`
    update settlements
    set status = ${settlement.status}, tx_hash = ${txHash}, explorer_url = ${explorerUrl},
        detail = ${sql.json(toJson(settlement))}, updated_at = now()
    where idempotency_key = ${idempotencyKey}`;

  if (settlement.status === "settled") {
    const record = await getContract(contractId);
    await transition(contractId, record.state, "SETTLED", "system:payments", "Settlement completed.");
  } else {
    await sql`
      insert into lifecycle_events (contract_id, from_state, to_state, actor, note)
      select contract_id, state, state, 'system:payments', ${`Settlement attempt did not settle: status=${settlement.status}.`}
      from contracts where contract_id = ${contractId}`;
  }
  return getContract(contractId);
}

/**
 * Find the verdict previously reached for one exact evidence bundle.
 *
 * Keyed on the evidence hash rather than recency, because a contract
 * accumulates verdicts from multiple distinct bundles. Comparing only against
 * the most recent verdict meant a resubmission of an earlier bundle missed its
 * own stored adjudication and got re-evaluated -- and by then the nonces it
 * cited were spent, so a previously APPROVED bundle came back REJECTED.
 *
 * The `verdicts_unique_evidence` constraint guarantees at most one row here.
 */
export async function getVerdictByEvidenceHash(
  contractId: string,
  evidenceHash: string,
): Promise<Verdict | undefined> {
  const db = getDb();
  if (db.mode === "ephemeral") {
    const rec = mem().contracts.get(contractId);
    return rec?.verdicts.find((v) => v.evidenceHash === evidenceHash);
  }
  const rows = await db.sql`
    select verdict from verdicts
    where contract_id = ${contractId} and evidence_hash = ${evidenceHash}
    limit 1`;
  return rows.length ? ((rows[0] as Row).verdict as Verdict) : undefined;
}

/**
 * Bring contract state into agreement with a verdict we are returning.
 *
 * The evidence route short-circuits an identical resubmission to the stored
 * verdict (the engine is deterministic, so re-evaluating cannot change the
 * answer, and the nonces it cited are by then spent). But the contract may
 * have moved on since -- a later, different evidence bundle could have left it
 * REJECTED while this bundle's verdict says APPROVED. Returning the cached
 * verdict without reconciling produced exactly that inconsistency: an APPROVED
 * verdict on a contract that `assertSettleable` then refused as not VERIFIED.
 *
 * Walking through SUBMITTED keeps every hop a legal transition.
 */
export async function reconcileToVerdict(contractId: string, verdict: Verdict): Promise<ContractRecord> {
  const target: ContractState =
    verdict.decision === "APPROVED" ? "VERIFIED" : verdict.decision === "REJECTED" ? "REJECTED" : "REVIEW";

  let record = await getContract(contractId);
  // Once settled, nothing may move it. Money has already changed hands.
  if (record.state === "SETTLED") return record;
  if (record.state === target) {
    await setCurrentVerdict(contractId, verdict);
    return getContract(contractId);
  }

  if (record.state !== "SUBMITTED") {
    await transition(contractId, record.state, "SUBMITTED", "system:engine", "Reopened to reconcile a replayed verdict.");
    record = await getContract(contractId);
  }
  await transition(contractId, "SUBMITTED", target, "system:engine", `Reconciled to replayed verdict: ${verdict.decision}.`);
  await setCurrentVerdict(contractId, verdict);
  return getContract(contractId);
}

/** Stamp the verdict that governs the contract's current state. */
async function setCurrentVerdict(contractId: string, verdict: Verdict): Promise<void> {
  const db = getDb();
  if (db.mode === "ephemeral") {
    const rec = mem().contracts.get(contractId);
    if (rec) rec.currentVerdict = verdict;
    return;
  }
  await db.sql`
    update contracts set current_verdict_hash = ${verdict.evidenceHash}
    where contract_id = ${contractId}`;
}

/** Guard a settlement attempt. Does not mutate state. */
export async function assertSettleable(contractId: string): Promise<ContractRecord> {
  const record = await getContract(contractId);
  if (record.settlement?.status === "settled") {
    throw new LifecycleError("already_settled", `Contract ${contractId} has already been settled.`);
  }
  if (record.state !== "VERIFIED") {
    throw new LifecycleError(
      "not_verified",
      `Contract ${contractId} cannot be settled unless it is VERIFIED (currently ${record.state}).`,
    );
  }
  const verdict = governingVerdict(record);
  if (!verdict || verdict.decision !== "APPROVED") {
    throw new LifecycleError("not_approved", `Contract ${contractId} has no APPROVED verdict on file.`);
  }
  return record;
}

export function latestVerdict(record: ContractRecord): Verdict | undefined {
  return record.verdicts[record.verdicts.length - 1];
}

/**
 * The verdict that authorizes (or blocks) settlement.
 *
 * Prefers the explicitly stamped governing verdict; falls back to recency only
 * for records written before that column existed.
 */
export function governingVerdict(record: ContractRecord): Verdict | undefined {
  return record.currentVerdict ?? latestVerdict(record);
}
