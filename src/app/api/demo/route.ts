import { NextResponse } from "next/server";
import { DEMO_SCENARIOS } from "@/lib/bps/fixtures";

/**
 * Demo scenario catalogue.
 *
 * The evidence bundle ships with each scenario so the client can POST it to
 * /api/contracts/[id]/evidence and watch the real engine decide. The verdict is
 * never precomputed here -- only the *expected* decision is quoted, so a judge
 * can see the engine agree (or disagree) with what we claimed it would do.
 */
export async function GET() {
  const scenarios = DEMO_SCENARIOS.map((s) => ({
    id: s.id,
    title: s.title,
    description: s.description,
    contractId: s.contract.contractId,
    expectedDecision: s.expectedDecision,
    evidence: s.evidence,
  }));
  return NextResponse.json({ scenarios });
}
