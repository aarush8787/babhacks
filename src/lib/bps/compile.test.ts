import test from "node:test";
import assert from "node:assert/strict";

import { compileContract } from "./compile";
import { hashCanonical } from "./canonical";
import { evaluate } from "./evaluate";
import { DEMO_SCENARIOS } from "./fixtures";

test("each contract kind compiles to a structurally distinct policy", () => {
  const delivery = compileContract({
    sourceText: "Deliver the package from the warehouse to the front office by 5pm.",
    reward: "10.00",
    deadline: "2026-02-01T00:00:00.000Z",
  });
  const observation = compileContract({
    sourceText: "Check if there is coffee in the pantry.",
    reward: "5.00",
    deadline: "2026-02-01T00:00:00.000Z",
  });
  const device = compileContract({
    sourceText: "Turn off the lobby lights.",
    reward: "3.00",
    deadline: "2026-02-01T00:00:00.000Z",
  });

  assert.equal(delivery.ok, true);
  assert.equal(observation.ok, true);
  assert.equal(device.ok, true);
  if (!delivery.ok || !observation.ok || !device.ok) return;

  assert.equal(delivery.contract.kind, "physical_delivery");
  assert.equal(observation.contract.kind, "physical_observation");
  assert.equal(device.contract.kind, "device_state_change");

  // Structurally distinct: different top-level op or different hash.
  const hashes = new Set([
    hashCanonical(delivery.contract.policy),
    hashCanonical(observation.contract.policy),
    hashCanonical(device.contract.policy),
  ]);
  assert.equal(hashes.size, 3, "all three policies must hash differently");

  // Delivery requires distinct_signers; observation requires ATLEAST corroboration
  // with a non-load-bearing ai_assertion; device requires a witness + ai_assertion.
  const deliveryStr = JSON.stringify(delivery.contract.policy);
  const observationStr = JSON.stringify(observation.contract.policy);
  const deviceStr = JSON.stringify(device.contract.policy);
  assert.match(deliveryStr, /distinct_signers/);
  assert.match(observationStr, /ATLEAST/);
  assert.match(observationStr, /ai_assertion/);
  assert.match(deviceStr, /ai_assertion/);
  assert.ok(!deviceStr.includes("ATLEAST"), "device policy should not use ATLEAST");

  // Authorization floors differ per the spec.
  assert.equal(delivery.contract.authorizationFloor.minCryptographic, 2);
  assert.equal(observation.contract.authorizationFloor.minCryptographic, 1);
  assert.equal(observation.contract.authorizationFloor.minIndependent, 2);
  assert.equal(device.contract.authorizationFloor.minCryptographic, 1);
  for (const c of [delivery, observation, device]) {
    if (c.ok) assert.equal(c.contract.authorizationFloor.rejectInferredOnly, true);
  }
});

test("unsupported tasks are refused, not invented", () => {
  const result = compileContract({
    sourceText: "Write a heartfelt poem about the ocean.",
    reward: "1.00",
    deadline: "2026-02-01T00:00:00.000Z",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "unsupported_task");
});

test("unsafe tasks are refused", () => {
  const result = compileContract({
    sourceText: "Drive my car to the pharmacy and pick up my medication.",
    reward: "1.00",
    deadline: "2026-02-01T00:00:00.000Z",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "unsafe");
});

test("missing/invalid deadline is refused", () => {
  const result = compileContract({
    sourceText: "Deliver the package to the front desk.",
    reward: "1.00",
    deadline: "not-a-date",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "no_deadline");
});

test("subjective/unverifiable language is surfaced honestly", () => {
  const result = compileContract({
    sourceText:
      "Deliver the package from the warehouse to the lobby, and gently and politely hand it over, make sure it looks nice.",
    reward: "10.00",
    deadline: "2026-02-01T00:00:00.000Z",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.contract.unverifiable.length > 0);
  assert.ok(result.contract.unverifiable.some((u) => u.includes("gently")));
  assert.ok(result.contract.unverifiable.some((u) => u.includes("politely")));
});

test("policyHash is stable across key reorderings", () => {
  const a = { op: "ALL", of: [{ op: "PRED", id: "x", predicate: "within_deadline", args: {}, label: "L" }] };
  const b = { of: [{ label: "L", args: {}, predicate: "within_deadline", id: "x", op: "PRED" }], op: "ALL" };
  assert.equal(hashCanonical(a), hashCanonical(b));
});

test("DEMO_SCENARIOS evaluate to their expected decisions", () => {
  for (const scenario of DEMO_SCENARIOS) {
    const verdict = evaluate(scenario.contract, {
      evidence: scenario.evidence,
      issuedChallenges: scenario.issuedChallenges,
      deadline: scenario.contract.deadline,
      priorArtifactHashes: new Set(scenario.priorArtifactHashes),
    });
    assert.equal(
      verdict.decision,
      scenario.expectedDecision,
      `${scenario.id}: expected ${scenario.expectedDecision}, got ${verdict.decision} (${verdict.authorizationNotes.join(" ")})`,
    );
  }
});
