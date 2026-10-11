import { NextResponse } from "next/server";
import { z } from "zod";
import { settleContract } from "@/lib/bps/payments/settle";
import {
  assertSettleable,
  governingVerdict,
  getContract,
  LifecycleError,
  NotFoundError,
  recordSettlement,
  reserveSettlement,
  settlementAllowed,
} from "@/lib/bps/store";
import { requireAuth } from "@/lib/bps/auth";

const SettleSchema = z.object({
  /**
   * Optional. When absent, settleContract() derives the key from
   * `${contractId}:${verdict.evidenceHash}`, which is the stronger default:
   * it is tied to the exact evidence that was approved, so a caller cannot
   * bypass the double-payout guard by sending a fresh random key.
   */
  idempotencyKey: z.string().min(1).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const auth = await requireAuth(req, "agent");
  if (!auth.ok) return auth.response;

  // Settlement requires durable idempotency. The in-memory driver cannot
  // guarantee a payout happens exactly once across instances or cold starts,
  // so we refuse before doing any other work.
  if (!settlementAllowed()) {
    return NextResponse.json(
      {
        error: "ephemeral_state",
        message:
          "Payouts require durable storage: the double-payment guard relies on a database constraint " +
          "(the settlements primary key) that process memory cannot provide. Set BPS_DATABASE_URL to a " +
          "Postgres connection string to enable settlement.",
        missing: ["BPS_DATABASE_URL"],
      },
      { status: 503 },
    );
  }

  // An empty body is valid here -- every field is optional.
  const raw = await req.text();
  let body: unknown = {};
  if (raw.trim().length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "malformed_json", message: "Request body must be valid JSON." }, { status: 400 });
    }
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
    const record = await assertSettleable(id);
    // The verdict that governs this contract's state -- NOT the most recently
    // inserted one. A contract accumulates verdicts from several evidence
    // bundles, so picking by recency could hand settlement a REJECTED verdict
    // belonging to a different bundle while the contract sits at VERIFIED.
    const verdict = governingVerdict(record);
    if (!verdict) {
      return NextResponse.json(
        { error: "no_verdict", message: `Contract ${id} has no governing verdict on file.` },
        { status: 409 },
      );
    }

    if (!record.workerAddress) {
      return NextResponse.json(
        { error: "no_worker", message: `Contract ${id} has no accepted worker to pay out.` },
        { status: 409 },
      );
    }

    const idempotencyKey = parsed.data.idempotencyKey ?? `${id}:${verdict.evidenceHash}`;

    const { reserved, existing } = await reserveSettlement(id, idempotencyKey);

    if (!reserved) {
      // A duplicate/retry of a settlement already reserved (or completed) by
      // another request. Never attempt to pay again -- return what's on file.
      if (!existing) {
        return NextResponse.json(
          {
            error: "settlement_in_flight",
            message: `A settlement attempt for contract ${id} with idempotency key ${idempotencyKey} is already in progress.`,
          },
          { status: 409 },
        );
      }
      // A reservation still sitting at 'pending' means another request is
      // mid-flight against the facilitator. Reporting that as a 200 success
      // body is misleading -- the caller cannot tell it apart from a finished
      // settlement -- so say so with a 409 and let them poll.
      if (existing.status === "pending") {
        return NextResponse.json(
          {
            error: "settlement_in_flight",
            message: `Settlement for contract ${id} is already in progress under idempotency key ${idempotencyKey}. Poll GET this endpoint for the outcome.`,
            settlement: existing,
          },
          { status: 409 },
        );
      }
      return NextResponse.json({ settlement: existing, state: record.state }, { status: 200 });
    }

    const result = await settleContract({
      contract: record.contract,
      verdict,
      workerAddress: record.workerAddress,
      idempotencyKey,
    });

    // Persist and return exactly what the payments layer decided. Never invent
    // or alter a txHash or any other field here.
    const updated = await recordSettlement(id, idempotencyKey, result);

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
    const record = await getContract(id);
    return NextResponse.json({ settlement: record.settlement ?? null, state: record.state });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: "not_found", message: err.message }, { status: 404 });
    }
    throw err;
  }
}
