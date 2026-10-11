"use client";

import { useEffect, useState } from "react";
import type { Contract, Decision, EvidenceBundle, Verdict } from "@/lib/bps/types";
import ProofGraph from "./ProofGraph";
import SettlementStrip from "./SettlementStrip";

interface DemoScenario {
  id: string;
  title: string;
  description: string;
  expectedDecision: Decision;
  contractId?: string;
  evidence?: EvidenceBundle;
}

type ScenariosState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; scenarios: DemoScenario[] };

type RunState =
  | { status: "idle" }
  | { status: "loading"; scenarioId: string }
  | { status: "error"; scenarioId: string; message: string }
  | { status: "done"; scenarioId: string; contract: Contract; verdict: Verdict };

export default function DemoRunner() {
  const [scenarios, setScenarios] = useState<ScenariosState>({ status: "loading" });
  const [run, setRun] = useState<RunState>({ status: "idle" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/demo");
        if (!res.ok) {
          if (!cancelled) {
            setScenarios({ status: "error", message: `Server returned ${res.status}.` });
          }
          return;
        }
        const body = await res.json().catch(() => null);
        const list = Array.isArray(body) ? body : body?.scenarios;
        if (!Array.isArray(list)) {
          if (!cancelled) setScenarios({ status: "error", message: "Malformed response from /api/demo." });
          return;
        }
        if (!cancelled) setScenarios({ status: "loaded", scenarios: list as DemoScenario[] });
      } catch (err) {
        if (!cancelled) {
          setScenarios({
            status: "error",
            message: err instanceof Error ? err.message : "Network error contacting /api/demo.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function runScenario(scenario: DemoScenario) {
    setRun({ status: "loading", scenarioId: scenario.id });
    try {
      if (!scenario.contractId) {
        setRun({
          status: "error",
          scenarioId: scenario.id,
          message: "This scenario has no contractId attached — cannot fetch its contract.",
        });
        return;
      }

      const contractRes = await fetch(`/api/contracts/${scenario.contractId}`);
      if (!contractRes.ok) {
        setRun({
          status: "error",
          scenarioId: scenario.id,
          message: `Could not load contract (${contractRes.status}).`,
        });
        return;
      }
      const contractBody = await contractRes.json().catch(() => null);
      const contract = contractBody?.contract as Contract | undefined;
      if (!contract) {
        setRun({ status: "error", scenarioId: scenario.id, message: "Malformed contract response." });
        return;
      }

      if (!scenario.evidence) {
        setRun({
          status: "error",
          scenarioId: scenario.id,
          message: "This scenario has no evidence bundle attached.",
        });
        return;
      }

      const evidenceRes = await fetch(`/api/contracts/${scenario.contractId}/evidence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scenario.evidence),
      });
      if (!evidenceRes.ok) {
        setRun({
          status: "error",
          scenarioId: scenario.id,
          message: `Evidence submission failed (${evidenceRes.status}).`,
        });
        return;
      }
      // The route wraps the verdict: { verdict: Verdict }.
      const evidenceBody = (await evidenceRes.json().catch(() => null)) as
        | { verdict?: Verdict }
        | null;
      const verdict = evidenceBody?.verdict ?? null;
      if (!verdict?.decision) {
        setRun({ status: "error", scenarioId: scenario.id, message: "Malformed verdict response." });
        return;
      }

      setRun({ status: "done", scenarioId: scenario.id, contract, verdict });
    } catch (err) {
      setRun({
        status: "error",
        scenarioId: scenario.id,
        message: err instanceof Error ? err.message : "Network error running scenario.",
      });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {scenarios.status === "loading" && (
        <p className="text-sm text-[color:var(--muted)]">Loading demo scenarios…</p>
      )}

      {scenarios.status === "error" && (
        <div className="rounded-xl border border-[color:var(--danger)]/50 bg-[color:var(--danger)]/10 p-4 text-sm text-[color:var(--danger)]">
          <p className="font-semibold">Could not load /api/demo</p>
          <p className="mt-1 opacity-90">{scenarios.message}</p>
        </div>
      )}

      {scenarios.status === "loaded" && scenarios.scenarios.length === 0 && (
        <p className="text-sm text-[color:var(--muted)]">No demo scenarios available yet.</p>
      )}

      {scenarios.status === "loaded" && scenarios.scenarios.length > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          {scenarios.scenarios.map((s) => {
            const isRunning = run.status === "loading" && run.scenarioId === s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => runScenario(s)}
                disabled={isRunning}
                className="flex-1 min-w-[220px] rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] p-3 text-left transition-colors hover:border-[color:var(--accent)] disabled:opacity-60"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold">{s.title}</p>
                  <span className="rounded border border-[color:var(--border)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[color:var(--muted)]">
                    expect {s.expectedDecision}
                  </span>
                </div>
                <p className="mt-1 text-xs text-[color:var(--muted)]">{s.description}</p>
                <p className="mt-2 text-xs font-medium text-[color:var(--accent)]">
                  {isRunning ? "Running…" : "Run scenario →"}
                </p>
              </button>
            );
          })}
        </div>
      )}

      {run.status === "error" && (
        <div className="rounded-xl border border-[color:var(--danger)]/50 bg-[color:var(--danger)]/10 p-4 text-sm text-[color:var(--danger)]">
          <p className="font-semibold">Scenario run failed</p>
          <p className="mt-1 opacity-90">{run.message}</p>
        </div>
      )}

      {run.status === "done" && (
        <div className="flex flex-col gap-4 rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] p-4">
          <ProofGraph policy={run.contract.policy} verdict={run.verdict} />
          <SettlementStrip contractId={run.contract.contractId} verdict={run.verdict} />
        </div>
      )}
    </div>
  );
}
