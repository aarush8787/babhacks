# BPS Operations Guide

This is the operator's reference for running BPS safely: what guarantees you
actually have in each mode, every environment variable, how to issue and
revoke credentials, how to check a deployment is healthy, and which database
constraint enforces which invariant. Read it before touching a production
deployment — several of the defaults exist specifically to keep a
misconfigured demo from quietly becoming an unsafe production system.

## 1. Store modes

BPS has two storage backends, chosen by a single env var
(`BPS_DATABASE_URL`), implemented in `src/lib/bps/db.ts` and
`src/lib/bps/store.ts`.

### `durable` (Postgres / Supabase) — `BPS_DATABASE_URL` is set

State lives in Postgres. Every concurrency-sensitive invariant (one worker
per contract, nonce single-use, artifact-reuse detection, settlement
idempotency, legal-transition-only state changes) is enforced by a database
constraint or a conditional `UPDATE ... WHERE ...`, so it holds across every
serving instance and survives cold starts. **This is the only mode in which
settlement (real payouts) is permitted** — `settlementAllowed()` returns
`true` only here.

### `ephemeral` (in-memory) — `BPS_DATABASE_URL` unset

State lives in a process-memory `Map`. Fine for local development and for
exercising the proof engine without standing up Postgres, but:

- Two serverless instances each get their own copy of the map, so a nonce
  could be spent twice, an artifact-reuse check could miss a collision, and
  a worker-acceptance race could hand the same contract to two workers.
- **Settlement is refused outright.** The engine still evaluates evidence
  and can reach an `APPROVED` verdict, but `reserveSettlement()` throws and
  the settle route never calls `settleContract()`'s facilitator path. This
  is deliberate: moving real money requires durable idempotency, and there
  is none in this mode.

Use `ephemeral` only for local iteration or a non-monetary demo. Never point
real funds at an ephemeral deployment.

## 2. Auth modes

Implemented in `src/lib/bps/auth.ts`, selected the same way every time —
purely from env vars, checked in this order by `authMode()`:

### `database` — `BPS_DATABASE_URL` is set

Credentials live in the `api_keys` table. Each row is `(key_hash, principal,
role, created_at, revoked_at)`. Multiple distinct keys, per-key revocation,
and an audit trail of which principal did what. **This is the only mode
that should be used in production.**

### `bootstrap-key` — no database, but `BPS_BOOTSTRAP_API_KEY` is set

There is no `api_keys` table to read without a database, so exactly one key
works — the raw value of `BPS_BOOTSTRAP_API_KEY` — and it is always treated
as role `admin` (which satisfies every endpoint's role requirement). This
lets an operator lock down an ephemeral/demo deployment with a single
shared secret before standing up Postgres. The key is compared using a
timing-safe comparison of its SHA-256 hash; the raw key is never stored or
logged.

### `open` — neither var is set

**Every request is let through with zero authentication**, with principal
`anonymous:open-mode`. This is a deliberate, named escape hatch, not an
oversight: it exists purely so the public demo works with zero
configuration. **Security implication: in `open` mode, anyone can drive the
entire contract lifecycle, including triggering settlement attempts** (the
request will still be refused by `ephemeral`'s lack of durable storage if
there's no database — but if you somehow run `open` auth *with* a database
configured, e.g. by unsetting `BPS_BOOTSTRAP_API_KEY` while
`BPS_DATABASE_URL` is set, auth mode is decided by `BPS_DATABASE_URL`
presence, not the absence of a bootstrap key — see below). Never run this
combination against a database holding funds without also setting
`BPS_BOOTSTRAP_API_KEY` or populating `api_keys`.

Important: `authMode()` checks `BPS_DATABASE_URL` *first*. If it's set, you
are always in `database` mode, even if `api_keys` is empty — in that case
every key lookup returns "unknown key" and all authenticated requests get
401, which is a safe failure. You only land in `open` mode when
`BPS_DATABASE_URL` is completely unset.

**Before going to production: confirm `/api/health` (or a direct check of
`authMode()`) reports `database`, not `open` or `bootstrap-key`.**

## 3. Environment variables

| Variable | Required for | Purpose |
| --- | --- | --- |
| `BPS_DATABASE_URL` | durable storage, real settlement, `database` auth mode | Postgres connection string (use Supabase's pooled/transaction-mode connection string for serverless). Unset = ephemeral store + no settlement. |
| `BPS_BOOTSTRAP_API_KEY` | `bootstrap-key` auth mode | A single shared admin API key, used only when there is no database. Treat it as a production secret even in a demo. |
| `BPS_SETTLEMENT_PRIVATE_KEY` | real settlement | Hex private key (32 bytes) of BPS's treasury/escrow signer — the payer ("from") on every payout authorization. Never logged. |
| `BPS_BASE_SEPOLIA_RPC_URL` | real settlement | HTTPS RPC endpoint for Base Sepolia (read-only calls). |
| `BPS_AUSD_ADDRESS` | optional | AUSD's ERC-20 contract address on Base Sepolia. Defaults to a published Agora address baked into `payments/config.ts` if unset. |
| `BPS_X402_FACILITATOR_URL` | real settlement | Base URL of an x402 facilitator exposing `POST /settle`. |

With none of `BPS_SETTLEMENT_PRIVATE_KEY` / `BPS_BASE_SEPOLIA_RPC_URL` /
`BPS_X402_FACILITATOR_URL` set, `settleContract()` returns
`{ status: "unconfigured", missing: [...] }` rather than attempting a
payout — see `src/lib/bps/payments/README.md` for the full payments-layer
writeup.

## 4. Running the migration against Supabase

The schema lives in `supabase/migrations/0001_init.sql` and is written to be
safely re-run (`create table if not exists`, `create index if not exists`).

Either of these works:

```bash
# Via the Supabase CLI, against a linked project:
supabase db push

# Or directly with psql against the same connection string BPS uses
# (use the *direct*/session connection for DDL, not the transaction pooler):
psql "$BPS_DATABASE_URL" -f supabase/migrations/0001_init.sql
```

After it runs, `select * from api_keys limit 1;` and `select * from
settlements limit 1;` should both succeed (zero rows is fine) — that
confirms every table in the migration landed, not just the first one.

## 5. Issuing and revoking API keys

### Issue

Requires `BPS_DATABASE_URL` (either set in your shell or present in
`.env.local` in the project root — the script loads `.env.local` itself, no
`dotenv` dependency needed):

```bash
node scripts/issue-api-key.mjs <principal> <agent|worker|admin>
# e.g.
node scripts/issue-api-key.mjs acme-agent-1 agent
```

The script generates a random key, stores only its SHA-256 hash in
`api_keys`, and prints the raw key **once**. There is no recovery path —
copy it immediately into whatever secret store the caller will read it
from. The role is checked against `agent | worker | admin`; anything else
exits non-zero with a clear message, as does an unreachable database.

Use the issued key as:

```
Authorization: Bearer <key>
```

### Revoke

There is no script for this — it's a one-line SQL statement, intentionally
simple so an operator can run it under time pressure without reading a
script first:

```sql
update api_keys set revoked_at = now() where key_hash = '<key_hash>';
```

You need the `key_hash`, not the raw key (the raw key is never stored, so
revocation by raw value is impossible by design). The issue script prints
the exact `update` statement, pre-filled with the hash, right after it
prints the new key — save that output. If you only know the principal, you
can look up its hash(es) first:

```sql
select key_hash, role, created_at, revoked_at from api_keys where principal = '<principal>';
```

A revoked key fails `verifyApiKey()` immediately (treated the same as an
unknown key — a 401, not a 403), on the very next request; there is no
cache to wait out.

## 6. Verifying a deployment via `/api/health`

`GET /api/health` reports:

```json
{
  "ok": true,
  "mode": "durable" | "ephemeral",
  "settlementAllowed": true | false,
  "db": { "ok": true, "mode": "durable" }
}
```

- `mode: "durable"` + `db.ok: true` → Postgres is reachable; the endpoint
  actually ran `select 1` against it, so this confirms the connection
  string and network path, not just that the var is set.
  `settlementAllowed` should be `true`.
- `mode: "durable"` + `db.ok: false` → the database is configured but
  unreachable. The endpoint returns HTTP 503 in this case — treat this as a
  hard failure, not a degraded-but-ok state.
- `mode: "ephemeral"` → no `BPS_DATABASE_URL` configured. HTTP 200 (this is
  an expected, not-erroring configuration), but `settlementAllowed: false`
  — no payouts will happen, by design.

The health endpoint does not currently echo `authMode()` in its response
body. Until it does, check auth mode directly: `database` if
`BPS_DATABASE_URL` is set, `bootstrap-key` if only `BPS_BOOTSTRAP_API_KEY`
is set, otherwise `open`. Treat seeing `open` on anything but a disposable
local/demo instance as a finding, not a configuration choice to shrug off.

A quick end-to-end credential check once you have a key:

```bash
# Should be 401 (unauthenticated) in `database` mode:
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<host>/api/contracts -d '{}'

# Should pass auth (then fail/succeed on request validation instead):
curl -s -X POST https://<host>/api/contracts \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d '{...}'
```

## 7. Invariants and which constraint enforces them

All of these only hold in `durable` mode — the `ephemeral` driver in
`store.ts` implements the same function signatures over a `Map` but cannot
offer any of these guarantees under concurrency (see §1).

| Invariant | Enforced by |
| --- | --- |
| A nonce (challenge) can be consumed at most once | `challenges.consumed_at`, spent via `UPDATE challenges SET consumed_at = now() WHERE nonce = $1 AND consumed_at IS NULL RETURNING *` in `consumeChallenge()` (`store.ts`). Zero rows returned means someone else already spent it. |
| An artifact hash cannot be claimed by two different contracts | `artifact_hashes.hash` is a `PRIMARY KEY`; `INSERT ... ON CONFLICT DO NOTHING`, then a separate `SELECT` for hashes claimed by a *different* `contract_id` (`getPriorArtifactHashes` / `addSeenArtifactHashes`). |
| A contract can be accepted by at most one worker | `contracts.worker_address`, claimed via `UPDATE contracts SET worker_address = $1, state = 'ACCEPTED' WHERE contract_id = $2 AND state = 'FUNDED' AND worker_address IS NULL` in `acceptContract()`. Zero rows updated means someone else already claimed it (or it wasn't `FUNDED`). |
| At most one successful payout per contract | Two layers: (1) `settlements.idempotency_key` is a `PRIMARY KEY` — `reserveSettlement()`'s `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` means only the first caller for a given key gets to attempt settlement; (2) `settlements_one_success_per_contract`, a **partial unique index** `ON settlements(contract_id) WHERE status = 'settled'`, which stops even a *different* idempotency key (e.g. a different evidence hash re-approved later) from producing a second successful payout on the same contract. |
| State transitions only happen along the allowed graph, and can't race | `ALLOWED_TRANSITIONS` in `store.ts` checked in-process, then enforced against races by `UPDATE contracts SET state = $to WHERE contract_id = $1 AND state = $from` in `transition()` — zero rows updated means another request already moved it, and the caller gets a clear `illegal_transition` error instead of silently clobbering it. |
| A revoked or unknown API key is always rejected | `api_keys.key_hash` lookup in `verifyApiKey()` (`auth.ts`); a `NULL` row or a non-null `revoked_at` both return "no identity," which `requireAuth()` turns into a 401. Only the SHA-256 hash is ever stored or compared — the raw key is never persisted, so a database read alone cannot produce a working credential. |

## 8. Known limits worth operator awareness

- `bootstrap-key` auth mode supports exactly one credential, with no
  revocation path other than rotating `BPS_BOOTSTRAP_API_KEY` itself (which
  invalidates the old value for everyone immediately, with no granularity).
- `open` auth mode has no audit trail at all — every event is attributed to
  the literal principal string `anonymous:open-mode`.
- The payments layer has its own set of documented limitations (facilitator
  asset acceptance unverified, no `/verify` pre-check, no on-chain balance
  pre-check, assumed 6-decimal AUSD units) — see
  `src/lib/bps/payments/README.md` before relying on real settlement.
