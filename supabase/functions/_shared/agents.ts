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
  parseSplit,
  type Decision,
  type IdentifiedFinding,
  type Proposal,
  type Split,
} from "./schemas.ts";

export const DEFAULT_MODEL = "claude-sonnet-5";

// A truncated tool call is invalid JSON, so these are sized generously.
export const MAX_TOKENS = { review: 2500, improve: 4000, finalize: 6000, split: 3000, revise: 3000 } as const;

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

function toolInput(response: MessageResponse, toolName: string): unknown {
  if (response.stop_reason === "max_tokens") throw new AgentOutputError("Response was cut off");
  const block = response.content.find(
    (b: ContentBlock): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use" && b.name === toolName,
  );
  if (!block) throw new AgentOutputError("Model did not call the expected tool");
  return block.input;
}

export const parseReviewResponse = (res: MessageResponse) => parseReview(toolInput(res, REVIEW_TOOL.name));
export const parseImproveResponse = (res: MessageResponse, validIds: ReadonlySet<string>) =>
  parseImprovement(toolInput(res, IMPROVE_TOOL.name), validIds);
export const parseFinalizeResponse = (res: MessageResponse) => parseFinalPrd(toolInput(res, FINALIZE_TOOL.name));
export const parseSplitResponse = (res: MessageResponse) => parseSplit(toolInput(res, SPLIT_TOOL.name));
