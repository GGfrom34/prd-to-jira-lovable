// Builds the Claude request for each step and validates what comes back.
// Pure functions: no network, no database.
import type { ContentBlock, MessageParams, MessageResponse } from "./anthropic.ts";
import {
  FINALIZER_SYSTEM,
  IMPROVER_SYSTEM,
  REVIEWER_SYSTEM,
  REVISER_SYSTEM,
  SPLITTER_SYSTEM,
  wrapUntrusted,
} from "./prompts/prompts.ts";
import {
  FINALIZE_TOOL,
  IMPROVE_TOOL,
  REVIEW_TOOL,
  SPLIT_TOOL,
  parseFinalPrd,
  parseImprovement,
  parseReview,
  SchemaError,
  normaliseToSchema,
  parseSplit,
  type Decision,
  type IdentifiedFinding,
  type Proposal,
  type Split,
} from "./schemas.ts";

export const DEFAULT_MODEL = "claude-sonnet-5";

// A truncated tool call is invalid JSON, so these are sized generously.
export const MAX_TOKENS = { review: 4500, improve: 6000, finalize: 6000, split: 4000, revise: 4000 } as const;

export type AgentRequest = { params: MessageParams; inputChars: number };

export class AgentOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentOutputError";
  }
}

function request(
  model: string,
  maxTokens: number,
  system: string,
  user: string,
  tool: { name: string; description: string; input_schema: object },
): AgentRequest {
  return {
    inputChars: system.length + user.length,
    params: {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
      // Not strict: strict mode hides the length limits from the model, and it then
      // sometimes runs on until the output cap. Label and shape slips are repaired
      // by normaliseToSchema instead.
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
    },
  };
}

export function buildReviewRequest(prd: string, model = DEFAULT_MODEL): AgentRequest {
  return request(model, MAX_TOKENS.review, REVIEWER_SYSTEM, `Review this PRD.\n\n${wrapUntrusted("prd", prd)}`, REVIEW_TOOL);
}

export function buildImproveRequest(prd: string, findings: IdentifiedFinding[], model = DEFAULT_MODEL): AgentRequest {
  const user = `Propose fixes for these findings.\n\n${wrapUntrusted("prd", prd)}\n\n${wrapUntrusted("findings", JSON.stringify(findings, null, 2))}`;
  return request(model, MAX_TOKENS.improve, IMPROVER_SYSTEM, user, IMPROVE_TOOL);
}

export type FinalizeChange = {
  finding_id: string;
  action: "accept" | "edit" | "defer";
  before: string | null;
  text: string;
};

// Turns the PM's decisions into the exact edits the finalizer applies. An edit
// uses the PM's own text; an accept uses the proposal; a defer carries the
// finding's issue so it can be logged as an open question.
export function resolveChanges(
  findings: IdentifiedFinding[],
  proposals: Proposal[],
  decisions: Decision[],
): FinalizeChange[] {
  const proposalById = new Map(proposals.map((p) => [p.finding_id, p]));
  const findingById = new Map(findings.map((f) => [f.id, f]));
  return decisions.map((d) => {
    const proposal = proposalById.get(d.finding_id);
    const finding = findingById.get(d.finding_id);
    if (d.action === "defer") {
      if (!finding) throw new AgentOutputError(`Unknown finding ${d.finding_id}`);
      return { finding_id: d.finding_id, action: "defer", before: null, text: finding.issue };
    }
    if (!proposal) throw new AgentOutputError(`No proposal for finding ${d.finding_id}`);
    return {
      finding_id: d.finding_id,
      action: d.action,
      before: proposal.before,
      text: d.action === "edit" ? (d.text as string) : proposal.proposed_text,
    };
  });
}

export function buildFinalizeRequest(prd: string, changes: FinalizeChange[], model = DEFAULT_MODEL): AgentRequest {
  const user = `Apply these changes.\n\n${wrapUntrusted("prd", prd)}\n\n${wrapUntrusted("changes", JSON.stringify(changes, null, 2))}`;
  return request(model, MAX_TOKENS.finalize, FINALIZER_SYSTEM, user, FINALIZE_TOOL);
}

export function buildSplitRequest(prd: string, model = DEFAULT_MODEL): AgentRequest {
  return request(model, MAX_TOKENS.split, SPLITTER_SYSTEM, `Propose the breakdown.\n\n${wrapUntrusted("prd", prd)}`, SPLIT_TOOL);
}

export function buildReviseRequest(prd: string, previous: Split, feedback: string, model = DEFAULT_MODEL): AgentRequest {
  const user = `Revise the breakdown.\n\n${wrapUntrusted("prd", prd)}\n\n${wrapUntrusted("breakdown", JSON.stringify(previous, null, 2))}\n\n${wrapUntrusted("feedback", feedback)}`;
  return request(model, MAX_TOKENS.revise, REVISER_SYSTEM, user, SPLIT_TOOL);
}

// Sizes only (list lengths and the longest string), never content, so it is safe to report.
function describeShape(input: unknown): string {
  let longest = 0;
  const lists: string[] = [];
  const walk = (x: unknown, key: string): void => {
    if (typeof x === "string") longest = Math.max(longest, x.length);
    else if (Array.isArray(x)) {
      lists.push(`${key}:${x.length}`);
      x.forEach((item) => walk(item, key));
    } else if (typeof x === "object" && x !== null) {
      for (const [k, v] of Object.entries(x)) walk(v, k);
    }
  };
  walk(input, "root");
  return `${lists.join(" ")} longest string ${longest} chars`.trim();
}

// For text that looks like JSON, where the first parse error is: a position and a
// character code, never the text itself.
function jsonProbe(text: string): string {
  if (!/^\s*[[{]/.test(text)) return "";
  try {
    JSON.parse(text);
    return ",json-ok";
  } catch (e) {
    const m = /position (\d+)/.exec(String(e));
    const pos = m ? Number(m[1]) : -1;
    // -1 when the text simply ended, so there is no character at that position.
    return `,json-error@${pos}:code${pos >= 0 && pos < text.length ? text.charCodeAt(pos) : -1}`;
  }
}

// Top-level field names with their type and size, never values.
function describeFields(input: unknown): string {
  if (typeof input !== "object" || input === null) return `input is ${typeof input}`;
  return Object.entries(input)
    .map(([key, v]) => {
      if (typeof v === "string") return `${key}=string(${v.length}${jsonProbe(v)})`;
      if (Array.isArray(v)) return `${key}=array(${v.length})`;
      return `${key}=${v === null ? "null" : typeof v}`;
    })
    .join(" ");
}

function toolInput(response: MessageResponse, tool: { name: string; input_schema: object }): { input: unknown; fields: string } {
  const block = response.content.find(
    (b: ContentBlock): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use" && b.name === tool.name,
  );
  if (response.stop_reason === "max_tokens") {
    throw new AgentOutputError(`Response was cut off (${response.usage.output_tokens} output tokens; ${describeShape(block?.input)}; ${describeFields(block?.input)})`);
  }
  if (!block) throw new AgentOutputError("Model did not call the expected tool");
  return { input: normaliseToSchema(block.input, tool.input_schema), fields: describeFields(block.input) };
}

// A validation failure also says what shape the model actually sent, to make
// intermittent model-output problems diagnosable without logging any content.
function parseTool<T>(res: MessageResponse, tool: { name: string; input_schema: object }, parse: (input: unknown) => T): T {
  const { input, fields } = toolInput(res, tool);
  try {
    return parse(input);
  } catch (e) {
    if (e instanceof SchemaError) throw new SchemaError(e.path, `${e.message.slice(e.path.length + 2)} [sent: ${fields}]`);
    throw e;
  }
}

export const parseReviewResponse = (res: MessageResponse) => parseTool(res, REVIEW_TOOL, parseReview);
export const parseImproveResponse = (res: MessageResponse, validIds: ReadonlySet<string>) =>
  parseTool(res, IMPROVE_TOOL, (input) => parseImprovement(input, validIds));
export const parseFinalizeResponse = (res: MessageResponse) => parseTool(res, FINALIZE_TOOL, parseFinalPrd);
export const parseSplitResponse = (res: MessageResponse) => parseTool(res, SPLIT_TOOL, parseSplit);
