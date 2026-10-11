import { NextResponse } from "next/server";
import { z } from "zod";
import { settleContract } from "@/lib/bps/payments/settle";
import {
  assertSettleable,
  getContract,
  LifecycleError,
  NotFoundError,
  recordSettlement,
} from "@/lib/bps/store";

export const runtime = "nodejs";

const SettleSchema = z.object({
  idempotencyKey: z.string().min(1, "idempotencyKey is required"),
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

  const parsed = SettleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", message: "Request body failed validation.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    // Throws if not VERIFIED, not APPROVED, or already settled.
    const record = assertSettleable(id);
    const verdict = record.verdicts[record.verdicts.length - 1];

    if (!record.workerAddress) {
      return NextResponse.json(
        { error: "no_worker", message: `Contract ${id} has no accepted worker to pay out.` },
        { status: 409 },
      );
    }

    const result = await settleContract({
      contract: record.contract,
      verdict,
      workerAddress: record.workerAddress,
      idempotencyKey: parsed.data.idempotencyKey,
    });

    // Persist and return exactly what the payments layer decided. Never invent
    // or alter a txHash or any other field here.
    const updated = recordSettlement(id, result as Record<string, unknown> & { status: string });

    return NextResponse.json({ settlement: updated.settlement, state: updated.state });
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

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const record = getContract(id);
    return NextResponse.json({ settlement: record.settlement ?? null, state: record.state });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: "not_found", message: err.message }, { status: 404 });
    }
    throw err;
  }
}
