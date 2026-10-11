/**
 * Demo scenarios for the UI and tests.
 *
 * Real secp256k1 keypairs, real signatures over `challengePayload(...)`, real
 * `evaluate()` outcomes — nothing here is mocked at the crypto layer.
 */
import * as secp from "@noble/secp256k1";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { challengePayload, hashCanonical } from "./canonical";

// @noble/secp256k1 v2 needs a sync HMAC-SHA256 implementation wired in before
// `sign` (the non-async variant) can be used.
secp.etc.hmacSha256Sync = (key: Uint8Array, ...msgs: Uint8Array[]) =>
  hmac(sha256, key, secp.etc.concatBytes(...msgs));
import { compileContract } from "./compile";
import type {
  Challenge,
  Contract,
  Decision,
  EvidenceBundle,
  SignedReceipt,
} from "./types";

// ---------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------

function makeKeypair(seed: number): { priv: string; pub: string } {
  const priv = new Uint8Array(32);
  priv[31] = seed; // trivial but valid distinct scalars for demo purposes
  priv[0] = 1;
  const privHex = bytesToHex(priv);
  const pub = bytesToHex(secp.getPublicKey(priv, true));
  return { priv: privHex, pub };
}

export const WORKER_KEY = makeKeypair(1);
export const PICKUP_KEY = makeKeypair(2);
export const RECIPIENT_KEY = makeKeypair(3);
export const WITNESS_KEY = makeKeypair(4);

/** Sign the canonical challenge payload for (contractId, nonce, role) with a private key. */
export function signReceipt(
  privKeyHex: string,
  input: { contractId: string; nonce: string; role: Challenge["role"] },
  signedAt?: string,
): SignedReceipt {
  const payload = challengePayload(input);
  const msgHash = sha256(utf8ToBytes(payload));
  const sig = secp.sign(msgHash, privKeyHex);
  const pub = bytesToHex(secp.getPublicKey(privKeyHex, true));
  return {
    signerPublicKey: pub,
    nonce: input.nonce,
    signature: sig.toCompactHex(),
    role: input.role,
    signedAt: signedAt ?? new Date().toISOString(),
  };
}

function challenge(contractId: string, role: Challenge["role"], nonce: string, consumedAt?: string): Challenge {
  const issuedAt = "2026-01-01T00:00:00.000Z";
  const expiresAt = "2026-01-10T00:00:00.000Z";
  return { nonce, contractId, role, issuedAt, expiresAt, consumedAt };
}

// ---------------------------------------------------------------------------
// Scenario 1: goodDelivery — APPROVED
// ---------------------------------------------------------------------------

const deliveryCompiled = compileContract({
  sourceText: "Deliver the catering box from the kitchen to the front desk by 6pm.",
  reward: "25.00",
  deadline: "2026-01-05T18:00:00.000Z",
  now: new Date("2026-01-01T00:00:00.000Z"),
});
if (!deliveryCompiled.ok) throw new Error("fixture compile failed for goodDelivery");
export const deliveryContract: Contract = deliveryCompiled.contract;

const pickupNonce = "nonce-pickup-001";
const recipientNonce = "nonce-recipient-001";

const pickupChallenge = challenge(deliveryContract.contractId, "pickup", pickupNonce);
const recipientChallenge = challenge(deliveryContract.contractId, "recipient", recipientNonce);

const pickupReceiptGood = signReceipt(
  PICKUP_KEY.priv,
  { contractId: deliveryContract.contractId, nonce: pickupNonce, role: "pickup" },
  "2026-01-02T10:00:00.000Z",
);
const recipientReceiptGood = signReceipt(
  RECIPIENT_KEY.priv,
  { contractId: deliveryContract.contractId, nonce: recipientNonce, role: "recipient" },
  "2026-01-02T11:00:00.000Z",
);

const goodDeliveryEvidence: EvidenceBundle = {
  contractId: deliveryContract.contractId,
  policyHash: deliveryContract.policyHash,
  workerId: "0x9Ec8B4b7A1A9B8f4E3D2c1b0A9f8E7d6C5B4A3F2",
  submittedAt: "2026-01-02T11:05:00.000Z",
  receipts: [pickupReceiptGood, recipientReceiptGood],
  geo: [],
  artifactHashes: ["artifact-hash-good-1"],
  declaredObjectId: "catering box",
  aiAssertions: [],
};

// ---------------------------------------------------------------------------
// Scenario 2: forgedDelivery — recipient "signature" is actually the worker's
// own key signing over the recipient role (collusion) — fails distinct_signers
// ---------------------------------------------------------------------------

const recipientReceiptForged = signReceipt(
  WORKER_KEY.priv, // worker signs for BOTH roles -> only 1 distinct key
  { contractId: deliveryContract.contractId, nonce: recipientNonce, role: "recipient" },
  "2026-01-02T11:00:00.000Z",
);
const pickupReceiptForged = signReceipt(
  WORKER_KEY.priv,
  { contractId: deliveryContract.contractId, nonce: pickupNonce, role: "pickup" },
  "2026-01-02T10:00:00.000Z",
);

const forgedDeliveryEvidence: EvidenceBundle = {
  contractId: deliveryContract.contractId,
  policyHash: deliveryContract.policyHash,
  workerId: "0x9Ec8B4b7A1A9B8f4E3D2c1b0A9f8E7d6C5B4A3F2",
  submittedAt: "2026-01-02T11:05:00.000Z",
  receipts: [pickupReceiptForged, recipientReceiptForged],
  geo: [],
  artifactHashes: ["artifact-hash-forged-1"],
  declaredObjectId: "catering box",
  aiAssertions: [],
};

// ---------------------------------------------------------------------------
// Scenario 3: replayedDelivery — cites an already-consumed nonce
// ---------------------------------------------------------------------------

const recipientChallengeConsumed = challenge(
  deliveryContract.contractId,
  "recipient",
  recipientNonce,
  "2026-01-02T09:00:00.000Z", // consumed before the receipt below was signed
);

const replayedDeliveryEvidence: EvidenceBundle = {
  contractId: deliveryContract.contractId,
  policyHash: deliveryContract.policyHash,
  workerId: "0x9Ec8B4b7A1A9B8f4E3D2c1b0A9f8E7d6C5B4A3F2",
  submittedAt: "2026-01-02T11:05:00.000Z",
  receipts: [pickupReceiptGood, recipientReceiptGood],
  geo: [],
  artifactHashes: ["artifact-hash-replay-1"],
  declaredObjectId: "catering box",
  aiAssertions: [],
};

// ---------------------------------------------------------------------------
// Scenario 4: aiOnlyObservation — only ai_assertion passes -> REVIEW
// ---------------------------------------------------------------------------

const observationCompiled = compileContract({
  sourceText: "Check if there is coffee in the break room pantry.",
  reward: "5.00",
  deadline: "2026-01-05T18:00:00.000Z",
  now: new Date("2026-01-01T00:00:00.000Z"),
});
if (!observationCompiled.ok) throw new Error("fixture compile failed for aiOnlyObservation");
export const observationContract: Contract = observationCompiled.contract;

const aiOnlyEvidence: EvidenceBundle = {
  contractId: observationContract.contractId,
  policyHash: observationContract.policyHash,
  workerId: "0x7A3b5C9d1e2F4A6b8C0D2e4F6A8B0C2d4E6f8A0b",
  submittedAt: "2026-01-02T11:05:00.000Z",
  receipts: [], // no witness signature at all -> crypto branch fails
  geo: [{ lat: 37.0, lon: -122.0, capturedAt: "2026-01-02T11:00:00.000Z" }],
  artifactHashes: ["artifact-hash-ai-1"],
  declaredObjectId: "coffee",
  aiAssertions: [
    {
      claim: "observation_holds",
      holds: true,
      confidence: 0.92,
      model: "demo-vision-model",
      over: ["artifact-hash-ai-1"],
    },
  ],
};

// ---------------------------------------------------------------------------
// Export the scenario table
// ---------------------------------------------------------------------------

export interface DemoScenario {
  id: string;
  title: string;
  description: string;
  contract: Contract;
  evidence: EvidenceBundle;
  issuedChallenges: Challenge[];
  priorArtifactHashes: string[];
  expectedDecision: Decision;
}

export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    id: "goodDelivery",
    title: "Good delivery",
    description:
      "Pickup and recipient both sign distinct, fresh nonces in the correct order before the deadline.",
    contract: deliveryContract,
    evidence: goodDeliveryEvidence,
    issuedChallenges: [pickupChallenge, recipientChallenge],
    priorArtifactHashes: [],
    expectedDecision: "APPROVED",
  },
  {
    id: "forgedDelivery",
    title: "Forged delivery (collusion)",
    description:
      "The worker signs both the pickup and recipient receipts with their own key — fails distinct_signers.",
    contract: deliveryContract,
    evidence: forgedDeliveryEvidence,
    issuedChallenges: [pickupChallenge, recipientChallenge],
    priorArtifactHashes: [],
    expectedDecision: "REJECTED",
  },
  {
    id: "replayedDelivery",
    title: "Replayed delivery",
    description: "Evidence cites a recipient nonce that was already consumed — fails challenge_fresh.",
    contract: deliveryContract,
    evidence: replayedDeliveryEvidence,
    issuedChallenges: [pickupChallenge, recipientChallengeConsumed],
    priorArtifactHashes: [],
    expectedDecision: "REJECTED",
  },
  {
    id: "aiOnlyObservation",
    title: "AI-only observation",
    description:
      "Only the model's ai_assertion affirms the claim; no witness signature exists. Lands on REVIEW, never APPROVED.",
    contract: observationContract,
    evidence: aiOnlyEvidence,
    issuedChallenges: [],
    priorArtifactHashes: [],
    expectedDecision: "REVIEW",
  },
];

export { deliveryContract as goodDeliveryContract };
export const goodDelivery = DEMO_SCENARIOS[0];
export const forgedDelivery = DEMO_SCENARIOS[1];
export const replayedDelivery = DEMO_SCENARIOS[2];
export const aiOnlyObservation = DEMO_SCENARIOS[3];
export { hashCanonical };
