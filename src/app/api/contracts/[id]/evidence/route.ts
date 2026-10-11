import { NextResponse } from "next/server";
import { z } from "zod";
import { getAddress } from "viem";
import { hashCanonical } from "@/lib/bps/canonical";
import { evaluate } from "@/lib/bps/evaluate";
import {
  acceptContract,
  addSeenArtifactHashes,
  consumeChallenge,
  getContract,
  getPriorArtifactHashes,
  LifecycleError,
  NotFoundError,
  latestVerdict,
  getVerdictByEvidenceHash,
  reconcileToVerdict,
  recordVerdict,
  submitEvidence,
} from "@/lib/bps/store";
import { requireAuth } from "@/lib/bps/auth";
import type { EvidenceBundle } from "@/lib/bps/types";

const ROLES = ["worker", "pickup", "recipient", "witness"] as const;

const SignedReceiptSchema = z.object({
  signerPublicKey: z.string().min(1),
  nonce: z.string().min(1),
  signature: z.string().min(1),
  role: z.enum(ROLES),
  signedAt: z.string().min(1),
});

const GeoPointSchema = z.object({
  lat: z.number(),
  lon: z.number(),
  accuracyM: z.number().optional(),
  capturedAt: z.string().min(1),
});

const AiAssertionSchema = z.object({
  claim: z.string().min(1),
  holds: z.boolean(),
  confidence: z.number().min(0).max(1),
  model: z.string().min(1),
  over: z.array(z.string()),
});

/**
 * The worker identifier doubles as the AUSD payout destination, so it must be a
 * well-formed EVM address.
 *
 * Validated here, at the point evidence enters the system, rather than at
 * settlement: a worker who has already done the job should not discover their
 * identifier was unpayable only after the verdict lands.
 */
const EvmAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "workerId must be a 20-byte hex EVM address (the AUSD payout destination)")
  // Reject a bad EIP-55 checksum here rather than letting viem throw at signing
  // time. A mixed-case address whose checksum does not verify is usually a
  // transcription error, and catching it now means the worker learns before
  // doing the job -- not after the verdict, when the payout fails.
  .refine(
    (a) => {
      const hasMixedCase = a !== a.toLowerCase() && a !== a.toUpperCase();
      if (!hasMixedCase) return true;
      try {
        return getAddress(a) === a;
      } catch {
        return false;
      }
    },
    { message: "workerId has an invalid EIP-55 checksum; send it all-lowercase or correctly checksummed" },
  );

const EvidenceBundleSchema = z.object({
  // contractId is taken from the URL, not trusted from the body.
  contractId: z.string().optional(),
  policyHash: z.string().min(1),
  workerId: EvmAddressSchema,
  submittedAt: z.string().min(1),
  receipts: z.array(SignedReceiptSchema),
  geo: z.array(GeoPointSchema),
  artifactHashes: z.array(z.string()),
  declaredObjectId: z.string().optional(),
  aiAssertions: z.array(AiAssertionSchema),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const auth = await requireAuth(req, "worker");
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "malformed_json", message: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsed = EvidenceBundleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", message: "Request body failed validation.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Evidence is data, never instructions: it is only ever read by the deterministic
  // engine below, never interpreted, templated, or executed.
  const evidence: EvidenceBundle = {
    ...parsed.data,
    contractId: id,
  };

  const evidenceHash = hashCanonical(evidence);

  try {
    const existing = await getContract(id);

    // Identical evidence replays to the stored verdict instead of 409-ing on the
    // lifecycle guard. This is not a weakening of the state machine: the engine is
    // deterministic, so re-evaluating the same bundle against the same policy can
    // only ever yield the same decision. It makes the verdict endpoint idempotent
    // and lets a reviewer re-run a scenario without resetting the contract.
    const prior = await getVerdictByEvidenceHash(id, evidenceHash);
    if (prior && prior.evidenceHash === evidenceHash) {
      // Keep contract state in agreement with the verdict we are handing back;
      // a later, different submission may have moved it elsewhere.
      await reconcileToVerdict(id, prior);
      return NextResponse.json({ verdict: prior, replayed: true }, { status: 200 });
    }

    // Allow the worker's first evidence submission to double as acceptance, for
    // flows that skipped an explicit challenge round (e.g. policies with no
    // signature predicates).
    if (existing.state === "FUNDED") {
      await acceptContract(id, evidence.workerId);
    }

    const record = await submitEvidence(id, evidence, evidenceHash);

    const priorArtifactHashes = await getPriorArtifactHashes(id, evidence.artifactHashes);

    const verdict = evaluate(record.contract, {
      evidence,
      issuedChallenges: record.challenges,
      deadline: record.contract.deadline,
      priorArtifactHashes,
    });

    // Consume every nonce this evidence bundle cited, regardless of outcome —
    // a spent nonce must never be replayable.
    for (const receipt of evidence.receipts) {
      await consumeChallenge(receipt.nonce);
    }

    await addSeenArtifactHashes(id, evidence.artifactHashes);

    await recordVerdict(id, verdict);

    return NextResponse.json({ verdict }, { status: 201 });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: "not_found", message: err.message }, { status: 404 });
    }
    if (err instanceof LifecycleError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: 409 });
    }
    throw err;
  }
}
