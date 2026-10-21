// Tool definitions (what the model is asked to return) and validators (what the
// server actually accepts). The validators are the enforcement: model output is
// untrusted, and decisions arriving from the browser are too.

import { parseJsonLoosely } from "./json-repair.ts";

export const DIMENSIONS = [
  "problem_statement",
  "success_metrics",
  "scope",
  "requirements_acceptance_criteria",
  "edge_cases",
  "non_functional",
  "dependencies_risks_questions",
  "rollout_rollback",
] as const;
export const SEVERITIES = ["blocker", "gap", "nice_to_have"] as const;
export const VERDICTS = ["ready", "needs_targeted_fixes", "needs_significant_rework"] as const;
export const ISSUE_TYPES = ["story", "task"] as const;
export const ACTIONS = ["accept", "edit", "defer"] as const;

export type Dimension = (typeof DIMENSIONS)[number];
export type Severity = (typeof SEVERITIES)[number];
export type Verdict = (typeof VERDICTS)[number];
export type IssueType = (typeof ISSUE_TYPES)[number];
export type Action = (typeof ACTIONS)[number];

export type Finding = { dimension: Dimension; severity: Severity; section: string; quote: string | null; issue: string };
export type IdentifiedFinding = Finding & { id: string };
export type Review = {
  verdict: Verdict;
  summary: string;
  findings: Finding[];
  skipped_dimensions: { dimension: Dimension; reason: string }[];
  strengths: string | null;
};
export type Proposal = { finding_id: string; question: string; before: string | null; proposed_text: string };
export type Decision = { finding_id: string; action: Action; text: string | null };
export type SplitIssue = { type: IssueType; title: string; description: string; acceptance_criteria: string[] };
export type Split = { epic: { title: string; description: string }; issues: SplitIssue[] };

export class SchemaError extends Error {
  path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "SchemaError";
    this.path = path;
  }
}

type Obj = Record<string, unknown>;

function obj(v: unknown, path: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new SchemaError(path, "expected an object");
  return v as Obj;
}

function arr(v: unknown, path: string, max: number, min = 0): unknown[] {
  if (!Array.isArray(v)) throw new SchemaError(path, "expected an array");
  if (v.length > max) throw new SchemaError(path, `at most ${max} items allowed`);
  if (v.length < min) throw new SchemaError(path, `at least ${min} item(s) required`);
  return v;
}

function str(v: unknown, path: string, max: number): string {
  if (typeof v !== "string") throw new SchemaError(path, "expected a string");
  const s = v.trim();
  if (s.length === 0) throw new SchemaError(path, "must not be empty");
  if (s.length > max) throw new SchemaError(path, `at most ${max} characters allowed`);
  return s;
}

function optStr(v: unknown, path: string, max: number): string | null {
  if (v === undefined || v === null) return null;
  const s = typeof v === "string" ? v.trim() : v;
  if (s === "") return null;
  return str(s, path, max);
}

function oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw new SchemaError(path, `must be one of: ${allowed.join(", ")}`);
  }
  return v as T;
}

function parseFinding(f: unknown, p: string): Finding {
  const fo = obj(f, p);
  return {
    dimension: oneOf(fo.dimension, `${p}.dimension`, DIMENSIONS),
    severity: oneOf(fo.severity, `${p}.severity`, SEVERITIES),
    section: str(fo.section, `${p}.section`, 200),
    quote: optStr(fo.quote, `${p}.quote`, 400),
    issue: str(fo.issue, `${p}.issue`, 700),
  };
}

// Findings come back from the browser for the improve and finalize steps, so
// they are re-validated rather than trusted. Ids are re-assigned by position.
export function parseFindings(input: unknown): Finding[] {
  return arr(input, "findings", 20, 1).map((f, i) => parseFinding(f, `findings[${i}]`));
}

export function parseReview(input: unknown): Review {
  const o = obj(input, "review");
  return {
    verdict: oneOf(o.verdict, "verdict", VERDICTS),
    summary: str(o.summary, "summary", 300),
    findings: arr(o.findings, "findings", 20).map((f, i) => parseFinding(f, `findings[${i}]`)),
    skipped_dimensions: arr(o.skipped_dimensions ?? [], "skipped_dimensions", 8).map((s, i) => {
      const p = `skipped_dimensions[${i}]`;
      const so = obj(s, p);
      return { dimension: oneOf(so.dimension, `${p}.dimension`, DIMENSIONS), reason: str(so.reason, `${p}.reason`, 300) };
    }),
    strengths: optStr(o.strengths, "strengths", 400),
  };
}

// Ids are assigned by the server, never by the model, so later steps can trust them.
export function withIds(findings: Finding[]): IdentifiedFinding[] {
  return findings.map((f, i) => ({ id: `f${i + 1}`, ...f }));
}

export function parseImprovement(input: unknown, validIds: ReadonlySet<string>): Proposal[] {
  const o = obj(input, "improvement");
  const seen = new Set<string>();
  return arr(o.proposals, "proposals", 20).map((p, i) => {
    const path = `proposals[${i}]`;
    const po = obj(p, path);
    const id = str(po.finding_id, `${path}.finding_id`, 20);
    if (!validIds.has(id)) throw new SchemaError(`${path}.finding_id`, "unknown finding id");
    if (seen.has(id)) throw new SchemaError(`${path}.finding_id`, "duplicate finding id");
    seen.add(id);
    return {
      finding_id: id,
      question: str(po.question, `${path}.question`, 300),
      before: optStr(po.before, `${path}.before`, 1500),
      proposed_text: str(po.proposed_text, `${path}.proposed_text`, 2500),
    };
  });
}

// Decisions come from the browser, so this is a trust boundary.
export function parseDecisions(input: unknown, validIds: ReadonlySet<string>): Decision[] {
  const seen = new Set<string>();
  return arr(input, "decisions", 20).map((d, i) => {
    const path = `decisions[${i}]`;
    const o = obj(d, path);
    const id = str(o.finding_id, `${path}.finding_id`, 20);
    if (!validIds.has(id)) throw new SchemaError(`${path}.finding_id`, "unknown finding id");
    if (seen.has(id)) throw new SchemaError(`${path}.finding_id`, "duplicate finding id");
    seen.add(id);
    const action = oneOf(o.action, `${path}.action`, ACTIONS);
    const text = action === "edit" ? str(o.text, `${path}.text`, 2500) : null;
    return { finding_id: id, action, text };
  });
}

export function parseFinalPrd(input: unknown): { prd_markdown: string } {
  const o = obj(input, "final");
  return { prd_markdown: str(o.prd_markdown, "prd_markdown", 20_000) };
}

export function parseSplit(input: unknown): Split {
  const o = obj(input, "split");
  const epic = obj(o.epic, "epic");
  return {
    epic: { title: str(epic.title, "epic.title", 120), description: str(epic.description, "epic.description", 3000) },
    issues: arr(o.issues, "issues", 15, 1).map((it, i) => {
      const p = `issues[${i}]`;
      const io = obj(it, p);
      return {
        type: oneOf(io.type, `${p}.type`, ISSUE_TYPES),
        title: str(io.title, `${p}.title`, 120),
        description: str(io.description, `${p}.description`, 2000),
        acceptance_criteria: arr(io.acceptance_criteria ?? [], `${p}.acceptance_criteria`, 10).map((c, j) =>
          str(c, `${p}.acceptance_criteria[${j}]`, 300),
        ),
      };
    }),
  };
}

type JsonSchema = {
  type?: string | string[];
  enum?: readonly unknown[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  maxItems?: number;
  maxLength?: number;
};

type EnumRule = [RegExp, string];
type EnumTable = { allowed: readonly string[]; rules: EnumRule[]; fallback: string };

// Labels the model sometimes invents outside the allowed lists, mapped to the
// nearest valid one. The label only drives how a finding is displayed, so a
// close mapping is better than discarding a reply that is otherwise fine.
const ENUM_TABLES: EnumTable[] = [
  {
    allowed: VERDICTS,
    rules: [[/significant|rework/, "needs_significant_rework"], [/targeted|fix|minor/, "needs_targeted_fixes"], [/ready|good|approv/, "ready"]],
    fallback: "needs_targeted_fixes",
  },
  {
    allowed: SEVERITIES,
    rules: [[/block|critical|high|major|severe/, "blocker"], [/nice|low|minor|suggest|optional/, "nice_to_have"], [/gap|medium|moderate|warn/, "gap"]],
    fallback: "gap",
  },
  {
    allowed: DIMENSIONS,
    rules: [
      [/metric|success|kpi|measur/, "success_metrics"],
      [/rollout|rollback|launch|release/, "rollout_rollback"],
      [/non_?functional|nfr|perform|secur|privacy|safety|trust|compliance|gdpr|accessib|reliab|availab|retention|data/, "non_functional"],
      [/edge|error|failure|cancel|dispute|abuse|concurren/, "edge_cases"],
      [/depend|risk|question|assum/, "dependencies_risks_questions"],
      [/scope|boundar/, "scope"],
      [/accept|criteria|requirement|story|feature/, "requirements_acceptance_criteria"],
      [/problem|context|goal|audience|user/, "problem_statement"],
    ],
    fallback: "dependencies_risks_questions",
  },
  {
    allowed: ISSUE_TYPES,
    rules: [[/task|chore|tech|infra|spike|sub/, "task"], [/story|feature|bug/, "story"]],
    fallback: "story",
  },
];

export function coerceEnum(value: string, allowed: readonly unknown[]): string | null {
  const canonical = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const exact = allowed.find((a) => a === canonical);
  if (typeof exact === "string") return exact;
  const table = ENUM_TABLES.find((t) => t.allowed.length === allowed.length && t.allowed.every((a, i) => a === allowed[i]));
  if (!table) return null;
  for (const [pattern, label] of table.rules) if (pattern.test(canonical)) return label;
  return table.fallback;
}

// Repairs harmless quirks in the model's tool input before it is validated: an
// array or object sent as JSON text is decoded, and strings and lists longer
// than the schema allows are clipped rather than failing a reply that has
// already been paid for, and labels outside an enum are mapped to the nearest
// valid one. Only used on model output; visitor input stays strict.
export function normaliseToSchema(value: unknown, schema: JsonSchema): unknown {
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (typeof value === "string" && !types.includes("string") && (types.includes("array") || types.includes("object"))) {
    try {
      value = parseJsonLoosely(value);
    } catch {
      return value;
    }
  }
  if (Array.isArray(value) && types.includes("array")) {
    const items = typeof schema.maxItems === "number" ? value.slice(0, schema.maxItems) : value;
    const itemSchema = schema.items;
    return itemSchema ? items.map((v) => normaliseToSchema(v, itemSchema)) : items;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value) && types.includes("object") && schema.properties) {
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in out) out[key] = normaliseToSchema(out[key], sub);
    }
    return out;
  }
  if (typeof value === "string" && Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    const label = coerceEnum(value, schema.enum);
    if (label !== null) return label;
  }
  if (typeof value === "string" && types.includes("string") && typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    return value.slice(0, schema.maxLength - 1) + "…";
  }
  return value;
}

const text = (maxLength: number, description?: string) =>
  description ? { type: "string", maxLength, description } : { type: "string", maxLength };
const nullableText = (maxLength: number, description?: string) =>
  description ? { type: ["string", "null"], maxLength, description } : { type: ["string", "null"], maxLength };

// Strict mode drops the numeric limits from what the model sees, so the field
// descriptions carry the length guidance. Replies that run long anyway are
// clipped on the way back by normaliseToSchema.

export const REVIEW_TOOL = {
  name: "report_findings",
  description: "Report the PRD review: a verdict and findings grouped by severity.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "summary", "findings", "skipped_dimensions"],
    properties: {
      verdict: { type: "string", enum: [...VERDICTS] },
      summary: text(300, "One sentence, under 200 characters."),
      findings: {
        type: "array",
        maxItems: 20,
        description: "At most 12 findings. Merge closely related gaps into one finding and list the most severe first.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["dimension", "severity", "section", "issue"],
          properties: {
            dimension: {
              type: "string",
              enum: [...DIMENSIONS],
              description: "The closest of the eight rubric dimensions. If a gap fits none exactly, use dependencies_risks_questions.",
            },
            severity: { type: "string", enum: [...SEVERITIES] },
            section: text(200, "The PRD section, under 60 characters."),
            quote: nullableText(400, "A short verbatim excerpt under 150 characters, or null."),
            issue: text(700, "One or two sentences, under 300 characters."),
          },
        },
      },
      skipped_dimensions: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["dimension", "reason"],
          properties: { dimension: { type: "string", enum: [...DIMENSIONS] }, reason: text(300, "Under 150 characters.") },
        },
      },
      strengths: nullableText(400, "One short sentence, or null."),
    },
  },
} as const;

export const IMPROVE_TOOL = {
  name: "propose_fixes",
  description: "Propose one fix per finding: a question for the PM and a draft replacement text.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["proposals"],
    properties: {
      proposals: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["finding_id", "question", "proposed_text"],
          properties: {
            finding_id: text(20),
            question: text(300, "One short question, under 150 characters."),
            before: nullableText(1500, "The shortest exact excerpt that identifies the text being replaced, under 300 characters, or null."),
            proposed_text: text(2500, "A concise draft, under 600 characters."),
          },
        },
      },
    },
  },
} as const;

export const FINALIZE_TOOL = {
  name: "return_prd",
  description: "Return the complete updated PRD as markdown.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["prd_markdown"],
    properties: { prd_markdown: text(20_000) },
  },
} as const;

export const SPLIT_TOOL = {
  name: "propose_breakdown",
  description: "Propose one Epic and the Story/Task issues it should be split into.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["epic", "issues"],
    properties: {
      epic: {
        type: "object",
        additionalProperties: false,
        required: ["title", "description"],
        properties: { title: text(120, "Under 80 characters."), description: text(3000, "Under 800 characters.") },
      },
      issues: {
        type: "array",
        minItems: 1,
        maxItems: 15,
        description: "At most 10 issues.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["type", "title", "description", "acceptance_criteria"],
          properties: {
            type: { type: "string", enum: [...ISSUE_TYPES] },
            title: text(120, "Under 80 characters."),
            description: text(2000, "Under 400 characters."),
            acceptance_criteria: {
              type: "array",
              maxItems: 10,
              description: "At most 6 criteria, each under 150 characters.",
              items: text(300),
            },
          },
        },
      },
    },
  },
} as const;
