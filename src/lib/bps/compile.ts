/**
 * Deterministic, rule-based natural-language -> Contract compiler.
 *
 * No LLM calls, no network. Pure string/regex classification over the
 * operator's source text. Refuses rather than inventing policy for tasks
 * that are not expressible with SUPPORTED_PREDICATES, or that are unsafe
 * or purely subjective.
 */
import { hashCanonical } from "./canonical";
import { SUPPORTED_PREDICATES } from "./predicates";
import type {
  AuthorizationFloor,
  Contract,
  ContractKind,
  PredicateNode,
  ProofPolicy,
} from "./types";

export type CompileResult =
  | { ok: true; contract: Contract; warnings: string[] }
  | {
      ok: false;
      refusal: string;
      reason: "unsupported_task" | "ambiguous" | "no_deadline" | "unsafe";
    };

export interface CompileInput {
  sourceText: string;
  reward: string;
  deadline: string;
  now?: Date;
}

// ---------------------------------------------------------------------------
// Safety / unsafe-task detection
// ---------------------------------------------------------------------------

const UNSAFE_PATTERNS: RegExp[] = [
  /\bdrive (my|their|his|her|our)\b.*\bcar\b/i,
  /\b(drive|operate)\b.*\b(vehicle|car|truck)\b/i,
  /\bmedicat(ion|e)\b/i,
  /\bprescription\b/i,
  /\bpill(s)?\b/i,
  /\b(insulin|dosage|dose)\b/i,
  /\b(child|kid|minor|baby|infant|toddler)\b/i,
  /\bbabysit\b/i,
  /\bfirearm|gun|weapon\b/i,
];

// ---------------------------------------------------------------------------
// Kind classification
// ---------------------------------------------------------------------------

const KIND_KEYWORDS: Record<ContractKind, RegExp[]> = {
  physical_delivery: [
    /\bdeliver(y|s|ed)?\b/i,
    /\bbring\b/i,
    /\btake\b.*\bto\b/i,
    /\bdrop(\s|-)?off\b/i,
    /\bpick up\b.*\band\b.*\bdrop\b/i,
  ],
  physical_observation: [
    /\bcheck\b/i,
    /\bcount\b/i,
    /\bverify\b/i,
    /\bstock\b/i,
    /\bobserve\b/i,
    /\bis there\b/i,
    /\bconfirm\b.*\b(is|are)\b/i,
    /\binspect\b/i,
  ],
  device_state_change: [
    /\bturn (off|on)\b/i,
    /\bswitch (off|on)\b/i,
    /\btoggle\b/i,
    /\bpower (off|on|down|up)\b/i,
    /\bshut (off|down)\b/i,
  ],
};

function classifyKind(text: string): ContractKind | null {
  const scores: Record<ContractKind, number> = {
    physical_delivery: 0,
    physical_observation: 0,
    device_state_change: 0,
  };
  for (const [kind, patterns] of Object.entries(KIND_KEYWORDS) as [
    ContractKind,
    RegExp[],
  ][]) {
    for (const p of patterns) if (p.test(text)) scores[kind] += 1;
  }
  const entries = Object.entries(scores) as [ContractKind, number][];
  entries.sort((a, b) => b[1] - a[1]);
  const [topKind, topScore] = entries[0];
  const [, secondScore] = entries[1];
  if (topScore === 0) return null;
  if (topScore === secondScore) return null; // ambiguous tie
  return topKind;
}

// ---------------------------------------------------------------------------
// Subjective / unverifiable language
// ---------------------------------------------------------------------------

const SUBJECTIVE_PHRASES: RegExp[] = [
  /\bgently\b/i,
  /\bpolitely\b/i,
  /\bnicely\b/i,
  /\bcarefully\b/i,
  /\bquickly\b/i,
  /\bquietly\b/i,
  /\bmake sure (they're|they are|he's|she's|it's|it looks) happy\b/i,
  /\bhappy\b/i,
  /\bbeautiful(ly)?\b/i,
  /\bclean(ly)?\b/i,
  /\bneat(ly)?\b/i,
  /\bprofessional(ly)?\b/i,
  /\bfriendly\b/i,
  /\bgood (job|quality)\b/i,
  /\bhigh quality\b/i,
  /\bwith care\b/i,
  /\bproperly\b/i,
];

function detectUnverifiable(text: string): string[] {
  const found: string[] = [];
  for (const p of SUBJECTIVE_PHRASES) {
    const m = text.match(p);
    if (m) found.push(m[0].toLowerCase());
  }
  return [...new Set(found)];
}

// ---------------------------------------------------------------------------
// Slot extraction (simple, honest regex windows)
// ---------------------------------------------------------------------------

function extractObject(text: string): string | undefined {
  // "deliver the X to", "bring X to", "check if there is X", "count X"
  const patterns = [
    /\b(?:deliver|bring|take|drop off)\s+(?:the\s+|a\s+|an\s+)?([a-z0-9 ,'-]+?)\s+(?:to|at|from)\b/i,
    /\b(?:check|count|verify|inspect)\s+(?:if\s+there\s+is\s+|if\s+there\s+are\s+|the\s+|whether\s+there\s+is\s+)?([a-z0-9 ,'-]+?)(?:\s+(?:in|at|on)\b|[.,]|$)/i,
    /\b(?:turn|switch|power)\s+(?:off|on|down|up)\s+(?:the\s+)?([a-z0-9 ,'-]+?)(?:\s+(?:in|at|on)\b|[.,]|$)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1]) return m[1].trim();
  }
  return undefined;
}

function extractLocation(text: string, preposition: "to" | "at" | "from"): string | undefined {
  const re = new RegExp(`\\b${preposition}\\s+(?:the\\s+)?([a-z0-9 ,'-]+?)(?:\\s+(?:by|before|at)\\b|[.,]|$)`, "i");
  const m = text.match(re);
  return m?.[1]?.trim();
}

// ---------------------------------------------------------------------------
// Predicate helpers (never emit anything outside SUPPORTED_PREDICATES)
// ---------------------------------------------------------------------------

function pred(
  id: string,
  predicate: PredicateNode["predicate"],
  args: Record<string, unknown>,
  label: string,
): PredicateNode {
  if (!SUPPORTED_PREDICATES.includes(predicate)) {
    throw new Error(`compiler attempted to emit unsupported predicate "${predicate}"`);
  }
  return { op: "PRED", id, predicate, args, label };
}

// ---------------------------------------------------------------------------
// Policy builders — one per kind, structurally distinct on purpose
// ---------------------------------------------------------------------------

function buildDeliveryPolicy(objectId: string | undefined): ProofPolicy {
  const nodes: ProofPolicy[] = [
    pred("sig_pickup", "signature_valid", { role: "pickup" }, "Pickup counterparty signed the issued nonce"),
    pred("fresh_pickup", "challenge_fresh", { role: "pickup" }, "Pickup nonce is unspent and within window"),
    pred(
      "sig_recipient",
      "signature_valid",
      { role: "recipient" },
      "Recipient signed the issued nonce",
    ),
    pred(
      "fresh_recipient",
      "challenge_fresh",
      { role: "recipient" },
      "Recipient nonce is unspent and within window",
    ),
    pred("distinct", "distinct_signers", { n: 2 }, "Pickup and recipient are distinct keys"),
    pred(
      "order",
      "ordered_timestamps",
      { before: "pickup", after: "recipient" },
      "Pickup happened before recipient confirmation",
    ),
    pred("deadline", "within_deadline", {}, "Delivered before the deadline"),
  ];
  if (objectId) {
    nodes.push(pred("object", "object_id_match", { objectId }, `Delivered object matches "${objectId}"`));
  }
  return { op: "ALL", of: nodes };
}

function buildObservationPolicy(objectId: string | undefined): ProofPolicy {
  const cryptoBranch: ProofPolicy = {
    op: "ALL",
    of: [
      pred("sig_witness", "signature_valid", { role: "witness" }, "Witness signed the issued nonce"),
      pred("fresh_witness", "challenge_fresh", { role: "witness" }, "Witness nonce is unspent and within window"),
    ],
  };
  const aiLeaf: ProofPolicy = pred(
    "ai_claim",
    "ai_assertion",
    { claim: "observation_holds" },
    "Model's read of the submitted evidence (inferred, never sufficient alone)",
  );
  const corroborationLeaves: ProofPolicy[] = [
    pred("uniq", "evidence_unique", {}, "Submitted evidence was not reused from a prior job"),
    pred("geo", "geo_within", {}, "Reported location is near the observation site"),
  ];
  if (objectId) {
    corroborationLeaves.push(
      pred("obj", "object_id_match", { objectId }, `Observed item matches "${objectId}"`),
    );
  }
  return {
    op: "ALL",
    of: [
      { op: "ANY", of: [cryptoBranch, aiLeaf] },
      { op: "ATLEAST", n: 2, of: corroborationLeaves },
    ],
  };
}

function buildDeviceStatePolicy(objectId: string | undefined): ProofPolicy {
  const nodes: ProofPolicy[] = [
    pred("sig_witness", "signature_valid", { role: "witness" }, "Witness signed the issued nonce"),
    pred("fresh_witness", "challenge_fresh", { role: "witness" }, "Witness nonce is unspent and within window"),
    pred("deadline", "within_deadline", {}, "State change completed before the deadline"),
    pred(
      "ai_state",
      "ai_assertion",
      { claim: "device_state_confirmed" },
      "Model's read of submitted photo evidence of the device state",
    ),
  ];
  if (objectId) {
    nodes.push(pred("object", "object_id_match", { objectId }, `Device matches "${objectId}"`));
  }
  return { op: "ALL", of: nodes };
}

function floorFor(kind: ContractKind): AuthorizationFloor {
  switch (kind) {
    case "physical_delivery":
      return { minCryptographic: 2, minIndependent: 0, rejectInferredOnly: true };
    case "physical_observation":
      return { minCryptographic: 1, minIndependent: 2, rejectInferredOnly: true };
    case "device_state_change":
      return { minCryptographic: 1, minIndependent: 0, rejectInferredOnly: true };
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function compileContract(input: CompileInput): CompileResult {
  const { sourceText, reward, deadline } = input;
  const text = sourceText.trim();

  if (!deadline || Number.isNaN(Date.parse(deadline))) {
    return {
      ok: false,
      reason: "no_deadline",
      refusal: "No valid deadline was provided, so completion cannot be bounded in time.",
    };
  }

  for (const pattern of UNSAFE_PATTERNS) {
    if (pattern.test(text)) {
      return {
        ok: false,
        reason: "unsafe",
        refusal:
          "This task involves a category (vehicle operation, medication, or a minor) that BPS will not issue a verifiable physical contract for, regardless of available predicates.",
      };
    }
  }

  const kind = classifyKind(text);
  if (!kind) {
    return {
      ok: false,
      reason: "unsupported_task",
      refusal:
        "The task description does not match a supported contract kind (delivery, observation, or device state change), so no executable proof policy can be generated.",
    };
  }

  const objectPhrase = extractObject(text);
  const pickup = extractLocation(text, "from");
  const destination = extractLocation(text, "to") ?? extractLocation(text, "at");
  const unverifiable = detectUnverifiable(text);

  // A task whose entire success criterion is subjective, with no verifiable
  // object/location slot to anchor a predicate, cannot be made executable.
  if (!objectPhrase && unverifiable.length > 0 && kind === "physical_observation") {
    return {
      ok: false,
      reason: "ambiguous",
      refusal:
        "The task's success criteria are entirely subjective (e.g. quality/mood words) and no concrete observable object was identified, so no executable check can be written.",
    };
  }

  let policy: ProofPolicy;
  switch (kind) {
    case "physical_delivery":
      policy = buildDeliveryPolicy(objectPhrase);
      break;
    case "physical_observation":
      policy = buildObservationPolicy(objectPhrase);
      break;
    case "device_state_change":
      policy = buildDeviceStatePolicy(objectPhrase);
      break;
  }

  const policyHash = hashCanonical(policy);
  const contractId = `job_${hashCanonical({ sourceText: text, deadline }).slice(0, 8)}`;
  const createdAt = (input.now ?? new Date()).toISOString();

  const warnings: string[] = [];
  if (!objectPhrase) warnings.push("Could not extract a specific object/subject noun phrase from the text.");
  if (kind === "physical_delivery" && !destination) {
    warnings.push("Could not extract an explicit destination location.");
  }
  if (kind === "physical_delivery" && !pickup) {
    warnings.push("Could not extract an explicit pickup location.");
  }

  const contract: Contract = {
    contractId,
    kind,
    sourceText: text,
    reward: { amount: reward, currency: "AUSD" },
    deadline,
    policy,
    policyHash,
    authorizationFloor: floorFor(kind),
    unverifiable,
    createdAt,
  };

  return { ok: true, contract, warnings };
}
