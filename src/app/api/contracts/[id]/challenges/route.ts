import { NextResponse } from "next/server";
import { z } from "zod";
import { challengePayload } from "@/lib/bps/canonical";
import {
  acceptContract,
  getContract,
  issueChallenge,
  LifecycleError,
  NotFoundError,
} from "@/lib/bps/store";
import { requireAuth } from "@/lib/bps/auth";

const ROLES = ["worker", "pickup", "recipient", "witness"] as const;

const IssueChallengeSchema = z.object({
  role: z.enum(ROLES),
  /**
   * The address/identifier of the worker requesting this challenge. The first
   * worker to request a challenge for a FUNDED contract implicitly accepts it;
   * a different worker requesting afterwards is refused (409).
   */
  workerAddress: z.string().min(1, "workerAddress is required"),
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

  const parsed = IssueChallengeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", message: "Request body failed validation.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const existing = await getContract(id);
    if (existing.state === "FUNDED") {
      await acceptContract(id, parsed.data.workerAddress);
    }

    const challenge = await issueChallenge(id, parsed.data.role);
    const payload = challengePayload({
      contractId: id,
      nonce: challenge.nonce,
      role: parsed.data.role,
    });

    return NextResponse.json({ challenge, payloadToSign: payload }, { status: 201 });
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
