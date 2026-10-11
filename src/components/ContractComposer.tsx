"use client";

import { useState } from "react";
import type { Contract } from "@/lib/bps/types";
import ProofGraph from "./ProofGraph";

const EXAMPLES = [
  "Deliver a blue folder from Room A to Room B before 4pm today.",
  "Confirm the warehouse loading dock door is closed by 9pm and send proof.",
  "Pick up a signed package from the front desk and hand it to the night manager.",
];

type ComposerState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "refused"; message: string }
  | { status: "compiled"; contract: Contract };

export default function ContractComposer({
  onCompiled,
}: {
  onCompiled?: (contract: Contract) => void;
}) {
  const [sourceText, setSourceText] = useState("");
  const [reward, setReward] = useState("5.00");
  const [deadline, setDeadline] = useState("");
  const [state, setState] = useState<ComposerState>({ status: "idle" });

  async function submit() {
    if (!sourceText.trim()) return;
    setState({ status: "loading" });
    try {
      const res = await fetch("/api/contracts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceText,
          reward,
          deadline: deadline || undefined,
        }),
      });

      if (res.status === 422) {
        const body = await res.json().catch(() => null);
        setState({
          status: "refused",
          message: body?.refusal ?? "This task could not be compiled into an executable policy.",
        });
        return;
      }

      if (!res.ok) {
        setState({ status: "error", message: `Server returned ${res.status}.` });
        return;
      }

      const body = await res.json().catch(() => null);
      if (!body?.contract) {
        setState({ status: "error", message: "Malformed response from server." });
        return;
      }
      setState({ status: "compiled", contract: body.contract as Contract });
      onCompiled?.(body.contract as Contract);
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Network error contacting /api/contracts.",
      });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] p-4">
        <label className="text-xs font-semibold uppercase tracking-wide text-[color:var(--muted)]">
          Describe the task
        </label>
        <textarea
          value={sourceText}
          onChange={(e) => setSourceText(e.target.value)}
          placeholder="Deliver a blue folder from Room A to Room B before 4pm."
          rows={3}
          className="w-full resize-none rounded-lg border border-[color:var(--border)] bg-[color:var(--background)] p-3 text-sm outline-none focus:border-[color:var(--accent)]"
        />
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setSourceText(ex)}
              className="rounded-full border border-[color:var(--border)] px-3 py-1 text-xs text-[color:var(--muted)] transition-colors hover:border-[color:var(--accent)] hover:text-[color:var(--foreground)]"
            >
              {ex.length > 40 ? ex.slice(0, 40) + "…" : ex}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-[color:var(--muted)]">Reward (AUSD)</label>
            <input
              value={reward}
              onChange={(e) => setReward(e.target.value)}
              className="w-28 rounded-lg border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1.5 text-sm outline-none focus:border-[color:var(--accent)]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-[color:var(--muted)]">Deadline</label>
            <input
              type="datetime-local"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              className="rounded-lg border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1.5 text-sm outline-none focus:border-[color:var(--accent)]"
            />
          </div>
          <button
            type="button"
            onClick={submit}
            disabled={state.status === "loading" || !sourceText.trim()}
            className="ml-auto self-end rounded-lg bg-[color:var(--accent)] px-4 py-2 text-sm font-semibold text-[#06120c] transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {state.status === "loading" ? "Compiling…" : "Compile contract"}
          </button>
        </div>
      </div>

      {state.status === "refused" && (
        <div className="rounded-xl border border-[color:var(--warning)]/50 bg-[color:var(--warning)]/10 p-4 text-sm text-[color:var(--warning)]">
          <p className="font-semibold">Refused to compile</p>
          <p className="mt-1 opacity-90">{state.message}</p>
        </div>
      )}

      {state.status === "error" && (
        <div className="rounded-xl border border-[color:var(--danger)]/50 bg-[color:var(--danger)]/10 p-4 text-sm text-[color:var(--danger)]">
          <p className="font-semibold">Something went wrong</p>
          <p className="mt-1 opacity-90">{state.message}</p>
        </div>
      )}

      {state.status === "compiled" && (
        <div className="flex flex-col gap-4 rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Compiled policy</h3>
            <span className="font-mono text-[10px] text-[color:var(--muted)]">
              {state.contract.policyHash.slice(0, 20)}…
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs text-[color:var(--muted)] sm:grid-cols-4">
            <Field label="Kind" value={state.contract.kind} />
            <Field label="Reward" value={`${state.contract.reward.amount} ${state.contract.reward.currency}`} />
            <Field label="Deadline" value={new Date(state.contract.deadline).toLocaleString()} />
            <Field label="Contract ID" value={state.contract.contractId.slice(0, 10) + "…"} />
          </div>

          {state.contract.unverifiable.length > 0 && (
            <div className="rounded-lg border border-[color:var(--warning)]/40 bg-[color:var(--warning)]/10 p-3 text-xs text-[color:var(--warning)]">
              <p className="font-semibold">Cannot be verified</p>
              <ul className="mt-1 list-inside list-disc space-y-0.5 opacity-90">
                {state.contract.unverifiable.map((u, i) => (
                  <li key={i}>{u}</li>
                ))}
              </ul>
            </div>
          )}

          <ProofGraph policy={state.contract.policy} />
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="uppercase tracking-wide opacity-70">{label}</span>
      <span className="text-[color:var(--foreground)]">{value}</span>
    </div>
  );
}
