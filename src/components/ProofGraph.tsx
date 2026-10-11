"use client";

import { useState } from "react";
import type {
  PredicateResult,
  ProofPolicy,
  TrustTier,
  Verdict,
} from "@/lib/bps/types";

const TIER_LABEL: Record<TrustTier, string> = {
  CRYPTOGRAPHIC: "Cryptographic",
  INDEPENDENT: "Independent",
  INFERRED: "Inferred",
  SELF_REPORTED: "Self-reported",
};

const TIER_STYLE: Record<TrustTier, string> = {
  CRYPTOGRAPHIC:
    "border-solid border-2 border-[color:var(--accent)] bg-[color:var(--accent-dim)] text-[color:var(--foreground)] shadow-[0_0_0_1px_var(--accent)]",
  INDEPENDENT:
    "border-solid border-2 border-[color:var(--border-strong)] bg-[color:var(--surface-raised)] text-[color:var(--foreground)]",
  INFERRED:
    "border-dashed border-2 border-[color:var(--border-strong)] bg-[color:var(--surface)] text-[color:var(--muted)]",
  SELF_REPORTED:
    "border-dotted border-2 border-[color:var(--muted-2)] bg-transparent text-[color:var(--muted-2)] opacity-70",
};

function outcomeStyle(outcome: PredicateResult["outcome"] | "PENDING") {
  switch (outcome) {
    case "PASS":
      return "text-[color:var(--accent)]";
    case "FAIL":
      return "text-[color:var(--danger)]";
    case "INDETERMINATE":
      return "text-[color:var(--warning)]";
    default:
      return "text-[color:var(--muted)] bps-pending";
  }
}

function outcomeLabel(outcome: PredicateResult["outcome"] | "PENDING") {
  if (outcome === "PENDING") return "PENDING";
  return outcome;
}

function combinatorLabel(policy: ProofPolicy): string {
  if (policy.op === "ALL") return "ALL of";
  if (policy.op === "ANY") return "ANY of";
  if (policy.op === "NOT") return "NOT";
  if (policy.op === "ATLEAST") return `AT LEAST ${policy.n} of`;
  return "";
}

function PredicateLeaf({
  node,
  result,
}: {
  node: Extract<ProofPolicy, { op: "PRED" }>;
  result?: PredicateResult;
}) {
  const [open, setOpen] = useState(false);
  const tier = result?.tier;
  const outcome = result?.outcome ?? "PENDING";

  return (
    <div
      className={`rounded-lg px-3 py-2.5 text-sm transition-all duration-300 ${
        tier ? TIER_STYLE[tier] : "border-2 border-dashed border-[color:var(--border)] bg-transparent"
      } ${result ? "bps-resolve" : ""}`}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 text-left"
        disabled={!result}
      >
        <span className="min-w-0 truncate font-medium">{node.label}</span>
        <span className="flex shrink-0 items-center gap-2">
          {tier && (
            <span className="rounded border border-current/30 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide opacity-80">
              {TIER_LABEL[tier]}
            </span>
          )}
          <span className={`text-[11px] font-bold tracking-wide ${outcomeStyle(outcome)}`}>
            {outcomeLabel(outcome)}
          </span>
        </span>
      </button>
      {open && result && (
        <div className="mt-2 space-y-1 border-t border-[color:var(--border)] pt-2 text-xs text-[color:var(--muted)]">
          <p>{result.reason}</p>
          {result.usedEvidence.length > 0 && (
            <p className="truncate font-mono text-[10px] opacity-80">
              evidence: {result.usedEvidence.join(", ")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function PolicyNode({
  policy,
  resultsById,
  depth = 0,
}: {
  policy: ProofPolicy;
  resultsById: Map<string, PredicateResult>;
  depth?: number;
}) {
  if (policy.op === "PRED") {
    return <PredicateLeaf node={policy} result={resultsById.get(policy.id)} />;
  }

  const children = policy.op === "NOT" ? [policy.of] : policy.of;

  return (
    <div
      className={`rounded-xl border p-3 ${
        depth === 0
          ? "border-[color:var(--border-strong)] bg-[color:var(--surface)]"
          : "border-[color:var(--border)] bg-[color:var(--surface)]/60"
      }`}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded bg-[color:var(--surface-raised)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-[color:var(--muted)]">
          {combinatorLabel(policy)}
        </span>
      </div>
      <div className="flex flex-col gap-2 border-l border-[color:var(--border)] pl-3">
        {children.map((child, i) => (
          <PolicyNode
            key={policy.op === "PRED" ? i : i}
            policy={child}
            resultsById={resultsById}
            depth={depth + 1}
          />
        ))}
      </div>
    </div>
  );
}

const DECISION_STYLE: Record<Verdict["decision"], string> = {
  APPROVED:
    "border-[color:var(--accent)] bg-[color:var(--accent-dim)] text-[color:var(--foreground)]",
  REJECTED: "border-[color:var(--danger)]/60 bg-[color:var(--danger)]/10 text-[color:var(--danger)]",
  REVIEW: "border-[color:var(--warning)]/60 bg-[color:var(--warning)]/10 text-[color:var(--warning)]",
};

function DecisionBanner({ verdict }: { verdict: Verdict }) {
  return (
    <div className={`bps-resolve rounded-xl border-2 p-4 ${DECISION_STYLE[verdict.decision]}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-bold tracking-tight">{verdict.decision}</h3>
        <div className="flex gap-3 text-xs font-mono opacity-80">
          {Object.entries(verdict.satisfiedTierCounts).map(([tier, n]) => (
            <span key={tier}>
              {TIER_LABEL[tier as TrustTier]}: {n}
            </span>
          ))}
        </div>
      </div>
      {verdict.decision === "REVIEW" && (
        <p className="mt-1 text-xs font-medium opacity-90">
          Policy passed, but the evidence quality is below the authorization floor. No funds move automatically.
        </p>
      )}
      <ul className="mt-2 space-y-1 text-sm opacity-90">
        {verdict.authorizationNotes.map((note, i) => (
          <li key={i}>{note}</li>
        ))}
      </ul>
    </div>
  );
}

export function TierLegend() {
  return (
    <div className="flex flex-wrap gap-3 text-[11px] text-[color:var(--muted)]">
      {(Object.keys(TIER_LABEL) as TrustTier[]).map((tier) => (
        <div key={tier} className="flex items-center gap-1.5">
          <span className={`inline-block h-3 w-3 rounded ${TIER_STYLE[tier]}`} />
          <span>{TIER_LABEL[tier]}</span>
        </div>
      ))}
      <span className="opacity-70">— an AI&apos;s opinion is not proof.</span>
    </div>
  );
}

export default function ProofGraph({
  policy,
  verdict,
}: {
  policy: ProofPolicy;
  verdict?: Verdict | null;
}) {
  const resultsById = new Map<string, PredicateResult>();
  if (verdict) {
    for (const r of verdict.results) resultsById.set(r.id, r);
  }

  return (
    <div className="flex flex-col gap-4">
      <TierLegend />
      {verdict && <DecisionBanner verdict={verdict} />}
      <PolicyNode policy={policy} resultsById={resultsById} />
    </div>
  );
}
