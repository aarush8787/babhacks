import { NextResponse } from "next/server";
import { z } from "zod";
import { evaluate } from "@/lib/bps/evaluate";
import {
  acceptContract,
  addSeenArtifactHashes,
  consumeChallenge,
  getContract,
  getPriorArtifactHashes,
  LifecycleError,
  NotFoundError,
  recordVerdict,
  submitEvidence,
} from "@/lib/bps/store";
import type { EvidenceBundle } from "@/lib/bps/types";

export const runtime = "nodejs";

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

const EvidenceBundleSchema = z.object({
  // contractId is taken from the URL, not trusted from the body.
  contractId: z.string().optional(),
  policyHash: z.string().min(1),
  workerId: z.string().min(1),
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

  try {
    const existing = getContract(id);

    // Allow the worker's first evidence submission to double as acceptance, for
    // flows that skipped an explicit challenge round (e.g. policies with no
    // signature predicates).
    if (existing.state === "FUNDED") {
      acceptContract(id, evidence.workerId);
    }

    const record = submitEvidence(id, evidence);

    const verdict = evaluate(record.contract, {
      evidence,
      issuedChallenges: record.challenges,
      deadline: record.contract.deadline,
      priorArtifactHashes: getPriorArtifactHashes(),
    });

    // Consume every nonce this evidence bundle cited, regardless of outcome —
    // a spent nonce must never be replayable.
    for (const receipt of evidence.receipts) {
      consumeChallenge(receipt.nonce);
    }

    addSeenArtifactHashes(evidence.artifactHashes);

    recordVerdict(id, verdict);

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
