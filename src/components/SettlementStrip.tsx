"use client";

import { useState } from "react";
import type { Verdict } from "@/lib/bps/types";

interface SettleResponse {
  status: "settled" | "refused_unverified" | "unconfigured" | "failed";
  txHash?: string;
  explorerUrl?: string;
  missing?: string[];
}

type StripState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "done"; result: SettleResponse };

export default function SettlementStrip({
  contractId,
  verdict,
}: {
  contractId: string;
  verdict: Verdict;
}) {
  const [state, setState] = useState<StripState>({ status: "idle" });
  const canSettle = verdict.decision === "APPROVED";

  async function settle() {
    setState({ status: "loading" });
    try {
      const res = await fetch(`/api/contracts/${contractId}/settle`, { method: "POST" });
      if (!res.ok) {
        setState({ status: "error", message: `Server returned ${res.status}.` });
        return;
      }
      // The route wraps the result: { settlement: SettleResponse, state }.
      const envelope = (await res.json().catch(() => null)) as
        | { settlement?: SettleResponse }
        | null;
      const body = envelope?.settlement ?? null;
      if (!body?.status) {
        setState({ status: "error", message: "Malformed response from /settle." });
        return;
      }
      setState({ status: "done", result: body });
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Network error contacting /settle.",
      });
    }
  }

  return (
    <div className="rounded-xl border border-[color:var(--border)] bg-[color:var(--surface)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Settlement</h3>
          <p className="text-xs text-[color:var(--muted)]">
            AUSD over x402 · Base Sepolia
          </p>
        </div>
        <button
          type="button"
          onClick={settle}
          disabled={!canSettle || state.status === "loading"}
          className="rounded-lg bg-[color:var(--accent)] px-4 py-2 text-sm font-semibold text-[#06120c] transition-opacity hover:opacity-90 disabled:opacity-30"
        >
          {state.status === "loading" ? "Settling…" : "Settle contract"}
        </button>
      </div>

      {!canSettle && (
        <p className="mt-2 text-xs text-[color:var(--muted)]">
          Settlement is only authorized on an APPROVED verdict. This contract is {verdict.decision}.
        </p>
      )}

      {state.status === "error" && (
        <p className="mt-3 rounded-lg border border-[color:var(--danger)]/50 bg-[color:var(--danger)]/10 p-3 text-xs text-[color:var(--danger)]">
          {state.message}
        </p>
      )}

      {state.status === "done" && (
        <div className="mt-3 rounded-lg border p-3 text-xs">
          {state.result.status === "settled" && (
            <div className="border-[color:var(--accent)]/50 bg-[color:var(--accent-dim)] -m-3 rounded-lg p-3 text-[color:var(--foreground)]">
              <p className="font-semibold">Settled</p>
              {state.result.txHash && state.result.explorerUrl ? (
                <a
                  href={state.result.explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-block font-mono text-[color:var(--accent)] underline"
                >
                  {state.result.txHash.slice(0, 18)}…
                </a>
              ) : (
                <p className="mt-1 opacity-80">No transaction hash returned.</p>
              )}
            </div>
          )}

          {state.result.status === "unconfigured" && (
            <div className="border-[color:var(--warning)]/50 bg-[color:var(--warning)]/10 -m-3 rounded-lg p-3 text-[color:var(--warning)]">
              <p className="font-semibold">Settlement not configured</p>
              <p className="mt-1 opacity-90">
                Missing environment variables — no payment was simulated or faked.
              </p>
              {state.result.missing && state.result.missing.length > 0 && (
                <ul className="mt-1 list-inside list-disc font-mono">
                  {state.result.missing.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {state.result.status === "refused_unverified" && (
            <div className="border-[color:var(--danger)]/50 bg-[color:var(--danger)]/10 -m-3 rounded-lg p-3 text-[color:var(--danger)]">
              <p className="font-semibold">Refused</p>
              <p className="mt-1 opacity-90">
                The payments layer refused to move funds against an unverified verdict.
              </p>
            </div>
          )}

          {state.result.status === "failed" && (
            <div className="border-[color:var(--danger)]/50 bg-[color:var(--danger)]/10 -m-3 rounded-lg p-3 text-[color:var(--danger)]">
              <p className="font-semibold">Settlement failed</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
