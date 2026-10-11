# The proof policy language

BPS does not ask a model "does this photo look right?" and pay out on a yes.
It compiles a physical task into a **policy tree of executable predicates**,
evaluates evidence against that tree deterministically, and then applies a
second, independent test — the *authorization floor* — before any money moves.

## Why a boolean tree is not enough

A naive system treats "the policy evaluated true" as "pay the worker". That is
exploitable, because the cheapest predicates to satisfy are the ones that prove
the least. Consider a policy that is nothing but model inference:

```
ALL
└── ai_assertion("folder was delivered", minConfidence: 0.75)
```

A confident model looking at a photo of the right folder on the right desk will
satisfy this. It proves nothing — the photo could be from last week, from
someone else, or generated. The tree says `true`; the work may never have
happened.

So BPS separates two questions:

1. **Is the policy satisfied?** A pure boolean walk of the tree.
2. **Is the evidence good enough to move money?** A test on the *quality* of
   the predicates that carried the satisfying set.

A contract can be `policySatisfied: true` and still land on `REVIEW` with no
payout. That gap is the core mechanism.

## Trust tiers

Every predicate has a **ceiling** — the best it can ever claim, even passing.

| Tier | Meaning | Example predicates |
| --- | --- | --- |
| `CRYPTOGRAPHIC` | A key we pinned signed a payload we chose. | `signature_valid`, `challenge_fresh`, `distinct_signers` |
| `INDEPENDENT` | Asserted by a party with no incentive to help the worker cheat, or checked against a server-side clock/record. | `object_id_match`, `within_deadline`, `evidence_unique` |
| `INFERRED` | A model's reading of pixels. Probabilistic. | `ai_assertion` |
| `SELF_REPORTED` | The worker said so. | `geo_within`, `ordered_timestamps` |

Two deliberate design decisions follow:

- **`ai_assertion` is hard-capped at `INFERRED`** regardless of the confidence
  the model reports. 0.99 confidence is still inference. A model cannot witness
  a physical event; it can only describe an artifact it was handed.
- **`geo_within` is capped at `SELF_REPORTED`.** Device GPS is trivially
  spoofed. It can corroborate a story but must never be load-bearing. We would
  rather say so than imply a location check is proof.

## The authorization floor

Each contract carries an `authorizationFloor`:

```ts
{ minCryptographic: 2, minIndependent: 3, rejectInferredOnly: true }
```

After the tree is walked, the engine counts tiers **only across predicates that
actually carried the satisfying set** — a passing check on an unused `ANY`
branch buys nothing. If the counts fall short, the decision is `REVIEW`, not
`APPROVED`, and `authorizesSettlement()` returns false.

This is why the three decisions are distinct:

| Decision | Meaning | Funds move? |
| --- | --- | --- |
| `APPROVED` | Tree satisfied *and* evidence cleared the floor. | Yes |
| `REVIEW` | Tree satisfied, evidence too weak to trust automatically. | No |
| `REJECTED` | Tree not satisfied. | No |

## Determinism

For a fixed `(contract, evidence, issuedChallenges, priorArtifactHashes)` the
engine returns an identical verdict, including its hashes. `evaluatedAt` is the
only field that varies and is excluded from `evidenceHash`.

This matters for disputes: a verdict is replayable. Anyone holding the evidence
bundle and the policy can recompute the decision and get the same answer, or
demonstrate that the inputs changed.

Determinism rests on `canonicalize()` — JSON with keys sorted at every depth.
Two structurally identical policies written with keys in a different order hash
identically, so a policy cannot be "edited" without changing its meaning yet
still pass the pin check.

## Policy pinning

`Contract.policyHash` is `sha256(canonicalize(policy))`, fixed when the contract
is funded. An `EvidenceBundle` carries the `policyHash` it was gathered against.
If the two disagree, the engine **refuses to evaluate at all** and returns
`REJECTED`. Without that check, a policy could be quietly relaxed after a worker
committed to the harder version.

## Replay and collusion resistance

- **Nonce binding.** The signed payload is
  `{domain: "bps.challenge.v1", contractId, nonce, role}`. A signature harvested
  from one contract cannot be replayed against another, because the contract id
  is inside the signed bytes.
- **Freshness.** `challenge_fresh` fails a nonce that was never issued, has
  expired, was signed before it was issued, or was already consumed.
- **Independence.** `distinct_signers` counts *verifying signatures from
  different keys*. One person signing both ends of a handoff proves nothing, so
  a worker signing their own recipient receipt fails this check even though both
  signatures are individually valid.
- **Artifact reuse.** `evidence_unique` rejects an artifact hash already
  submitted for an earlier contract.

## What this does not solve

Stated plainly, because the alternative is overclaiming:

- A **recipient signature proves a key signed an acknowledgment, not that the
  signer was honest.** A worker who controls a second keypair and a cooperative
  friend can satisfy `distinct_signers`. Mitigating that needs pinned
  counterparty identity, which BPS does not yet implement.
- **Photo and video evidence can be fabricated.** We lower the weight of such
  evidence rather than claim to detect fakes.
- **GPS can be spoofed.** Hence the tier cap.
- The strongest contracts are those where an **instrument or system the worker
  does not control** can attest to the outcome — a smart-device state change, a
  merchant point-of-sale record. Policies that lean on those are genuinely
  stronger, and the tier system is what makes that difference visible instead of
  rhetorical.
