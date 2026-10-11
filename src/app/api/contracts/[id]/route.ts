import { NextResponse } from "next/server";
import { getContract, latestVerdict, NotFoundError } from "@/lib/bps/store";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const record = await getContract(id);
    return NextResponse.json({
      contract: record.contract,
      state: record.state,
      warnings: record.warnings,
      workerAddress: record.workerAddress,
      challenges: record.challenges,
      evidenceCount: record.evidence.length,
      verdict: latestVerdict(record) ?? null,
      verdicts: record.verdicts,
      settlement: record.settlement ?? null,
      events: record.events,
    });
  } catch (err) {
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: "not_found", message: err.message }, { status: 404 });
    }
    throw err;
  }
}
