import { NextResponse } from "next/server";
import { z } from "zod";
import { compileContract } from "@/lib/bps/compile";
import { createFundedContract, listContracts } from "@/lib/bps/store";

const CreateContractSchema = z.object({
  sourceText: z.string().min(1, "sourceText is required"),
  reward: z.string().min(1, "reward is required"),
  deadline: z.string().min(1, "deadline is required"),
});

export async function GET() {
  const summaries = listContracts().map((record) => ({
    contractId: record.contract.contractId,
    kind: record.contract.kind,
    state: record.state,
    reward: record.contract.reward,
    deadline: record.contract.deadline,
    createdAt: record.contract.createdAt,
    sourceText: record.contract.sourceText,
    workerAddress: record.workerAddress,
  }));
  return NextResponse.json({ contracts: summaries });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "malformed_json", message: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsed = CreateContractSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", message: "Request body failed validation.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const result = compileContract(parsed.data);

  if (!result.ok) {
    return NextResponse.json(
      { error: "compiler_refusal", refusal: result.refusal, reason: result.reason },
      { status: 422 },
    );
  }

  const record = createFundedContract(result.contract, result.warnings);

  return NextResponse.json(
    {
      contract: record.contract,
      state: record.state,
      warnings: record.warnings,
      events: record.events,
    },
    { status: 201 },
  );
}
