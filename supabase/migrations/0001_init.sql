-- BPS durable state.
--
-- Every guarantee the proof engine advertises depends on state that is shared
-- across all serving instances. The previous in-memory store silently broke
-- all of them under serverless concurrency: two instances could each spend the
-- same nonce, and a settlement retry after a cold start could pay twice.
--
-- The constraints below are the enforcement mechanism, not the application
-- code. Each one is written so that correctness survives concurrent callers.

create table if not exists contracts (
  contract_id          text primary key,
  kind                 text        not null,
  source_text          text        not null,
  reward_amount        text        not null,
  reward_currency      text        not null default 'AUSD',
  deadline             timestamptz not null,
  policy               jsonb       not null,
  policy_hash          text        not null,
  authorization_floor  jsonb       not null,
  unverifiable         jsonb       not null default '[]'::jsonb,
  warnings             jsonb       not null default '[]'::jsonb,
  state                text        not null default 'DRAFT',
  -- NULL until a worker accepts. The conditional UPDATE in acceptContract()
  -- relies on this being NULL to enforce one-worker-per-contract atomically.
  worker_address       text,
  -- The evidence hash of the verdict that produced `state`.
  --
  -- A contract accumulates verdicts from several evidence bundles, so "the
  -- latest row in verdicts" is NOT the verdict that governs the contract: a
  -- replayed earlier bundle can legitimately move state without appending a
  -- row. Settlement must consult the governing verdict, so state and verdict
  -- are updated together.
  current_verdict_hash text,
  created_at           timestamptz not null default now(),
  constraint contracts_state_valid check (
    state in ('DRAFT','FUNDED','ACCEPTED','SUBMITTED','VERIFIED','REJECTED','REVIEW','SETTLED')
  )
);

-- One-time challenges. `consumed_at` is the replay guard.
create table if not exists challenges (
  nonce        text primary key,
  contract_id  text        not null references contracts(contract_id) on delete cascade,
  role         text        not null,
  issued_at    timestamptz not null default now(),
  expires_at   timestamptz not null,
  -- Set exactly once, by `UPDATE ... WHERE consumed_at IS NULL RETURNING`.
  -- That predicate makes consumption atomic: concurrent attempts to spend the
  -- same nonce produce exactly one winner, whichever instance they land on.
  consumed_at  timestamptz,
  constraint challenges_role_valid check (role in ('worker','pickup','recipient','witness'))
);
create index if not exists challenges_contract_idx on challenges(contract_id);

create table if not exists evidence_bundles (
  id             bigserial primary key,
  contract_id    text        not null references contracts(contract_id) on delete cascade,
  evidence_hash  text        not null,
  bundle         jsonb       not null,
  submitted_at   timestamptz not null default now()
);
create index if not exists evidence_contract_idx on evidence_bundles(contract_id);

create table if not exists verdicts (
  id             bigserial primary key,
  contract_id    text        not null references contracts(contract_id) on delete cascade,
  decision       text        not null,
  evidence_hash  text        not null,
  policy_hash    text        not null,
  verdict        jsonb       not null,
  created_at     timestamptz not null default now(),
  -- Re-evaluating identical evidence must not create a second verdict row;
  -- the engine is deterministic, so the decision would be identical anyway.
  constraint verdicts_unique_evidence unique (contract_id, evidence_hash)
);
create index if not exists verdicts_contract_idx on verdicts(contract_id, created_at desc);

-- THE double-payout guard.
--
-- The primary key is the idempotency key, derived from
-- `${contract_id}:${evidence_hash}`. A second settlement attempt for the same
-- approved evidence collides on this key and is refused by the database, not
-- by application memory -- so it holds across instances and cold starts.
create table if not exists settlements (
  idempotency_key  text primary key,
  contract_id      text        not null references contracts(contract_id) on delete cascade,
  status           text        not null,
  tx_hash          text,
  explorer_url     text,
  detail           jsonb       not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists settlements_contract_idx on settlements(contract_id);

-- At most one *successful* settlement per contract, enforced by the database.
-- A partial unique index is the right tool: failed and refused attempts may
-- repeat freely, but 'settled' can exist only once per contract.
create unique index if not exists settlements_one_success_per_contract
  on settlements(contract_id) where status = 'settled';

-- Global artifact-reuse registry, backing the evidence_unique predicate.
-- The primary key does the detection: INSERT ... ON CONFLICT DO NOTHING and
-- inspect the row count to learn whether this artifact was already claimed.
create table if not exists artifact_hashes (
  hash           text primary key,
  contract_id    text        not null references contracts(contract_id) on delete cascade,
  first_seen_at  timestamptz not null default now()
);

create table if not exists lifecycle_events (
  id          bigserial primary key,
  contract_id text        not null references contracts(contract_id) on delete cascade,
  from_state  text,
  to_state    text        not null,
  actor       text        not null,
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists lifecycle_contract_idx on lifecycle_events(contract_id, id);

-- API credentials. Only the SHA-256 of a key is stored, never the key itself,
-- so a database disclosure does not hand over working credentials.
create table if not exists api_keys (
  key_hash    text primary key,
  principal   text        not null,
  role        text        not null,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  constraint api_keys_role_valid check (role in ('agent','worker','admin'))
);
