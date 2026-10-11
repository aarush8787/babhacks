# BPS

**The settlement layer for physical work.**

AI agents can call any API, but they cannot carry a folder across a building,
check whether a shelf is actually stocked, or flip a physical switch. BPS lets
an agent post a contract for a real-world task, lets a human execute it, and
then answers the hard question: *did the work actually happen?* — before
releasing payment in AUSD over x402.

The marketplace is the easy half. The interesting half is the proof.

---

## The mechanism

Most "agents hire humans" systems verify work by showing a photo to a vision
model and paying out if it looks right. That is not verification; it is a model
guessing about pixels. BPS does three things differently:

**1. It compiles the task into an executable policy.**
A free-text instruction becomes a typed tree of predicates — not a prompt.

```
"Deliver a blue folder from Room A to Room B before 4pm"
                        ↓  compileContract()
ALL
├── signature_valid(role: pickup)        CRYPTOGRAPHIC
├── signature_valid(role: recipient)     CRYPTOGRAPHIC
├── challenge_fresh(role: recipient)     CRYPTOGRAPHIC
├── distinct_signers(n: 2)               CRYPTOGRAPHIC
├── object_id_match(objectId: ...)       INDEPENDENT
├── ordered_timestamps(pickup→recipient) SELF_REPORTED
└── within_deadline                      INDEPENDENT
```

The compiler is deterministic and rule-based. It emits only predicates the
engine can actually execute, and anything it cannot express — "deliver it
politely", "make sure they're happy" — is surfaced in an `unverifiable` list
rather than silently dropped or faked.

**2. It grades evidence by what it can actually prove.**
Every predicate has a trust ceiling. A counterparty signing a one-time nonce is
`CRYPTOGRAPHIC`. A model's opinion is `INFERRED` — capped there no matter what
confidence it reports, because a model cannot witness a physical event. GPS is
capped at `SELF_REPORTED`, because it is trivially spoofed.

**3. It separates "policy passed" from "pay the worker".**
A satisfied policy tree is necessary but not sufficient. The engine then counts
the tiers of the predicates that *carried* the satisfying set against the
contract's `authorizationFloor`. A policy that passes purely on model inference
returns `REVIEW` — work possibly done, evidence too weak to move money
automatically — and `authorizesSettlement()` returns false.

That three-way decision (`APPROVED` / `REVIEW` / `REJECTED`) is the product.

Full detail: **[docs/PROOF_POLICY.md](docs/PROOF_POLICY.md)**, including an
honest account of [what this does not solve](docs/PROOF_POLICY.md#what-this-does-not-solve).

---

## AUSD and x402

Settlement runs on **AUSD on Base Sepolia** (chainId 84532) using
**ERC-3009 `transferWithAuthorization`** — the gasless primitive x402 is built
on, so the paying agent never needs to hold gas.

The flow:

```
Verdict APPROVED
   → sign ERC-3009 TransferWithAuthorization (EIP-712, gasless)
   → worker payout endpoint answers HTTP 402 with PaymentRequirements
   → agent retries with base64 X-PAYMENT header
   → facilitator /verify then /settle
   → onchain tx hash, surfaced with a Basescan link
```

Two architectural points we were careful about:

- **The x402 facilitator is not an escrow.** It verifies and settles a payment
  authorization. It does not hold funds or guarantee the worker gets paid. BPS
  keeps those responsibilities separate rather than conflating them, and this
  build is pay-after-verification — which means the worker carries credit risk
  against the agent. A production version needs real escrow at acceptance time.
- **There is exactly one gate on money movement.** `authorizesSettlement()` in
  `src/lib/bps/evaluate.ts` is the only function permitted to authorize a
  payout, so there is a single auditable place where a verdict becomes a
  transfer.

**Settlement is unconfigured by default.** Without the env vars below, the
settle endpoint returns an explicit `unconfigured` status listing what is
missing. It does not invent a transaction hash. See
[src/lib/bps/payments/README.md](src/lib/bps/payments/README.md).

---

## Running it

```bash
npm install
cp .env.example .env.local   # optional; settlement stays off without it
npm run dev
```

Open http://localhost:3000.

Everything except onchain settlement works with no configuration: compile a
contract from plain English, inspect the generated policy, submit evidence, and
watch the proof graph resolve.

### Enabling real settlement

1. Get a Base Sepolia wallet and testnet gas.
2. Mint testnet AUSD from the Agora faucet.
3. Fill in `.env.local`:

```
BPS_SETTLEMENT_PRIVATE_KEY=0x...
BPS_BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
BPS_AUSD_ADDRESS=0x...
BPS_X402_FACILITATOR_URL=https://...
```

The facilitator must actually support AUSD on Base Sepolia — not every x402
facilitator supports every token/network pair.

---

## Architecture

```
src/lib/bps/
  types.ts         Domain types. The contract between all four subsystems.
  canonical.ts     Deterministic JSON + sha256. Underpins verdict replayability.
  predicates.ts    The 9 executable checks, each with a trust ceiling.
  evaluate.ts      Policy walk, authorization floor, the single settlement gate.
  compile.ts       Natural language → ProofPolicy. Deterministic, refuses rather than invents.
  fixtures.ts      Demo scenarios with REAL secp256k1 signatures.
  store.ts         Lifecycle state machine + append-only event log.
  payments/        AUSD, ERC-3009, x402 client, settlement.
src/app/api/       REST surface over the above.
src/components/    Proof graph, contract composer, settlement strip.
```

Module rule: `types`, `canonical`, `predicates`, and `evaluate` have no
dependency on React, Next, or any network client. The engine is testable in
isolation and could be lifted out as a library.

### Lifecycle

```
DRAFT → FUNDED → ACCEPTED → SUBMITTED → VERIFIED | REJECTED | REVIEW → SETTLED
```

Illegal transitions throw. Only one worker may accept a contract. Evidence
cannot be submitted before acceptance. Settlement requires an `APPROVED`
verdict and refuses a second attempt.

---

## Known limitations

We would rather state these than have a judge find them.

- **Durable state is opt-in.** With `BPS_DATABASE_URL` set, state lives in
  Postgres and every concurrency guarantee is a database constraint (see
  [docs/OPERATIONS.md](docs/OPERATIONS.md)). Without it, BPS runs in
  `ephemeral` mode and **settlement is refused**, because the double-payment
  guard cannot exist in process memory. The engine still works; money cannot
  move.
- **Auth has an open mode.** With neither `BPS_DATABASE_URL` nor
  `BPS_BOOTSTRAP_API_KEY` set, the API accepts unauthenticated writes so the
  public demo works. Any real deployment must set one of them. `/api/health`
  reports the live `authMode` so this cannot be missed silently.
- **Pay-after-verification, not escrow.** See the AUSD section above.
- **Counterparty identity is not pinned.** `distinct_signers` proves two
  different keys signed, not that either belongs to the intended person.
- **Demo scenario order affects the rejection *reason*.** Three delivery
  scenarios share one contract (the signatures bind the contract id, so they
  cannot be split without re-signing). Running the valid one first consumes its
  nonces, so the forged attempt then fails on nonce freshness rather than on
  `distinct_signers`. It is still correctly rejected either way; run the forged
  scenario first to see it fail on signer independence specifically.
- **No worker mobile capture flow.** Evidence is submitted through the API and
  the demo scenarios rather than a camera-and-GPS PWA.

## Track

Built for **Best Use of AUSD** (Agora) — agentic payments and x402.
