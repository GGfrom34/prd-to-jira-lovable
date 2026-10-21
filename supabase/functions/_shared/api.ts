// The whole HTTP API as one function of (Request, Deps) -> Response. All I/O is
// injected, so the same code runs in the Edge Function and in the Node tests.
import {
  buildFinalizeRequest,
  buildImproveRequest,
  buildReviewRequest,
  buildReviseRequest,
  buildSplitRequest,
  parseFinalizeResponse,
  parseImproveResponse,
  parseReviewResponse,
  parseSplitResponse,
  resolveChanges,
  AgentOutputError,
  type AgentRequest,
} from "./agents.ts";
import type { MessageParams, MessageResponse } from "./anthropic.ts";
import type { Config } from "./config.ts";
import type { Db, Step } from "./db.ts";
import { MAX_FEEDBACK_CHARS, MAX_PRD_CHARS, describeError, estimateTokens, utcDay, visitorKey, withBudget } from "./guardrails.ts";
import {
  ApiError,
  clientIp,
  corsHeaders,
  errorResponse,
  jsonResponse,
  readJson,
  routeOf,
} from "./http.ts";
import { validateJiraLink } from "./jira-link.ts";
import { SURVEY_QUESTIONS, SURVEY_SCALE, parseSurveyBody, type SurveyRow } from "./survey.ts";
import { SchemaError, parseDecisions, parseFindings, parseImprovement, parseSplit, withIds } from "./schemas.ts";

export type Deps = {
  config: Config;
  db: Db;
  claude: (params: MessageParams) => Promise<MessageResponse>;
  appendSurveyRow: (row: SurveyRow) => Promise<void>;
  now: () => Date;
  randomId: () => string;
};

export const MAX_BODY_CHARS = 100_000;
// Attempts per Claude step when the reply is malformed.
export const MAX_ATTEMPTS = 2;
// The improved PRD can be longer than the pasted one, up to the finalizer's output cap.
export const MAX_IMPROVED_PRD_CHARS = 20_000;
// Enough headroom for the first Claude call, so the landing page does not invite a paste it cannot serve.
export const MIN_CAPACITY_TOKENS = 15_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Body = Record<string, unknown>;
type Ctx = { day: string; visitor: string };

function sessionId(body: Body): string {
  const id = body.session_id;
  if (typeof id !== "string" || !UUID.test(id)) throw new ApiError("invalid_input", "Missing or invalid session.");
  return id;
}

function prdText(value: unknown, max: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError("invalid_input", "Please paste your PRD first.");
  }
  if (value.length > max) {
    throw new ApiError("invalid_input", `Your PRD is too long. Please keep it under ${max.toLocaleString("en-US")} characters.`);
  }
  return value;
}

// Input that fails validation is the visitor's to fix. The message names the
// field and rule only, never the visitor's text.
function validated<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof SchemaError) throw new ApiError("invalid_input", e.message);
    throw e;
  }
}

async function context(req: Request, deps: Deps): Promise<Ctx> {
  const day = utcDay(deps.now());
  return { day, visitor: await visitorKey(clientIp(req.headers), day, deps.config.visitorSalt) };
}

// Claims the step, runs one Claude call under the budget, validates its output
// and advances the step. Any failure releases the claim so the visitor can retry.
async function runAiStep<T>(
  deps: Deps,
  ctx: Ctx,
  session: string,
  allowed: readonly Step[],
  next: Step,
  req: AgentRequest,
  parse: (res: MessageResponse) => T,
): Promise<T> {
  const begun = await deps.db.beginStep(session, allowed);
  if (begun !== "ok") throw new ApiError(begun);

  let finished = false;
  try {
    // The model occasionally returns a malformed reply (a missing field, a list
    // flattened or sent as broken text). One more attempt almost always fixes it.
    // Each attempt is reserved and settled separately, so the caps still hold, and
    // only a malformed reply is retried, never an API error or a cap denial.
    let parsed: T | undefined;
    for (let attempt = 1; parsed === undefined; attempt++) {
      const result = await withBudget({
        store: deps.db,
        day: ctx.day,
        visitor: ctx.visitor,
        session,
        estimate: estimateTokens(req.inputChars, req.params.max_tokens),
        caps: deps.config.caps,
        call: async () => {
          const res = await deps.claude(req.params);
          return { value: res, usage: res.usage };
        },
      });
      if (!result.ok) throw new ApiError(result.reason, undefined, result.detail);

      try {
        parsed = parse(result.value);
      } catch (e) {
        if (attempt >= MAX_ATTEMPTS) {
          // Schema paths and rules name no user text, so they are safe to return for debugging.
          const safe = e instanceof SchemaError || e instanceof AgentOutputError;
          throw new ApiError("upstream_error", undefined, safe ? `${e.name}: ${e.message}` : describeError(e));
        }
      }
    }
    await deps.db.finishStep(session, next);
    finished = true;
    return parsed;
  } finally {
    if (!finished) await deps.db.abortStep(session).catch(() => undefined);
  }
}

async function simpleStep(deps: Deps, session: string, allowed: readonly Step[], next: Step): Promise<void> {
  const begun = await deps.db.beginStep(session, allowed);
  if (begun !== "ok") throw new ApiError(begun);
  await deps.db.finishStep(session, next);
}

type Handler = (req: Request, deps: Deps) => Promise<unknown>;

const getHandlers: Record<string, Handler> = {
  async status(_req, deps) {
    const available = await deps.db.capacityAvailable(utcDay(deps.now()), deps.config.caps.global, MIN_CAPACITY_TOKENS);
    return { available };
  },
  async survey() {
    return { questions: SURVEY_QUESTIONS, scale: SURVEY_SCALE };
  },
};

const postHandlers: Record<string, Handler> = {
  async session(req, deps) {
    const { visitor } = await context(req, deps);
    const id = await deps.db.startSession(visitor, deps.config.maxSessionsPerVisitor);
    if (id === null) throw new ApiError("too_many_sessions");
    return { session_id: id };
  },

  async review(req, deps) {
    const body = await readJson(req, MAX_BODY_CHARS);
    const session = sessionId(body);
    const prd = prdText(body.prd, MAX_PRD_CHARS);
    const ctx = await context(req, deps);
    const review = await runAiStep(deps, ctx, session, ["new"], "reviewed", buildReviewRequest(prd, deps.config.model), parseReviewResponse);
    return { ...review, findings: withIds(review.findings) };
  },

  async improve(req, deps) {
    const body = await readJson(req, MAX_BODY_CHARS);
    const session = sessionId(body);
    const prd = prdText(body.prd, MAX_PRD_CHARS);
    const findings = withIds(validated(() => parseFindings(body.findings)));
    const ids = new Set(findings.map((f) => f.id));
    const ctx = await context(req, deps);
    const proposals = await runAiStep(
      deps,
      ctx,
      session,
      ["reviewed"],
      "improved",
      buildImproveRequest(prd, findings, deps.config.model),
      (res) => parseImproveResponse(res, ids),
    );
    return { proposals };
  },

  async finalize(req, deps) {
    const body = await readJson(req, MAX_BODY_CHARS);
    const session = sessionId(body);
    const prd = prdText(body.prd, MAX_PRD_CHARS);
    const findings = withIds(validated(() => parseFindings(body.findings)));
    const ids = new Set(findings.map((f) => f.id));
    const proposals = validated(() => parseImprovement({ proposals: body.proposals }, ids));
    const decisions = validated(() => parseDecisions(body.decisions, ids));
    if (decisions.length === 0) throw new ApiError("invalid_input", "Choose what to do with at least one suggestion.");
    let changes;
    try {
      changes = resolveChanges(findings, proposals, decisions);
    } catch {
      throw new ApiError("invalid_input", "A decision refers to a suggestion that does not exist.");
    }
    const ctx = await context(req, deps);
    return runAiStep(deps, ctx, session, ["improved"], "finalized", buildFinalizeRequest(prd, changes, deps.config.model), parseFinalizeResponse);
  },

  async "sign-off"(req, deps) {
    const session = sessionId(await readJson(req, MAX_BODY_CHARS));
    await simpleStep(deps, session, ["reviewed", "finalized"], "signed_off");
    return { signed_off: true };
  },

  async split(req, deps) {
    const body = await readJson(req, MAX_BODY_CHARS);
    const session = sessionId(body);
    const prd = prdText(body.prd, MAX_IMPROVED_PRD_CHARS);
    const ctx = await context(req, deps);
    return runAiStep(deps, ctx, session, ["signed_off"], "split_proposed", buildSplitRequest(prd, deps.config.model), parseSplitResponse);
  },

  async "revise-split"(req, deps) {
    const body = await readJson(req, MAX_BODY_CHARS);
    const session = sessionId(body);
    const prd = prdText(body.prd, MAX_IMPROVED_PRD_CHARS);
    const previous = validated(() => parseSplit(body.previous));
    const feedback = typeof body.feedback === "string" ? body.feedback.trim() : "";
    if (feedback === "") throw new ApiError("invalid_input", "Please tell us what to change.");
    if (feedback.length > MAX_FEEDBACK_CHARS) {
      throw new ApiError("invalid_input", `Your feedback is too long. Please keep it under ${MAX_FEEDBACK_CHARS} characters.`);
    }
    const ctx = await context(req, deps);
    return runAiStep(
      deps,
      ctx,
      session,
      ["split_proposed"],
      "split_revised",
      buildReviseRequest(prd, previous, feedback, deps.config.model),
      parseSplitResponse,
    );
  },

  async "submit-link"(req, deps) {
    const body = await readJson(req, MAX_BODY_CHARS);
    const session = sessionId(body);
    validateJiraLink(body.url);
    await simpleStep(deps, session, ["split_proposed", "split_revised"], "link_submitted");
    return { accepted: true };
  },

  async "submit-survey"(req, deps) {
    const body = await readJson(req, MAX_BODY_CHARS);
    const session = sessionId(body);
    const answers = parseSurveyBody(body);

    const begun = await deps.db.beginStep(session, ["link_submitted"]);
    if (begun !== "ok") throw new ApiError(begun);
    let finished = false;
    try {
      // The row holds a random id and the UTC date, nothing that identifies the visitor or session.
      const row: SurveyRow = [deps.randomId(), utcDay(deps.now()), deps.config.version, ...answers];
      try {
        await deps.appendSurveyRow(row);
      } catch {
        throw new ApiError("sheet_error");
      }
      await deps.db.finishStep(session, "surveyed");
      finished = true;
    } finally {
      if (!finished) await deps.db.abortStep(session).catch(() => undefined);
    }
    return { thanks: true };
  },
};

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const cors = corsHeaders(req.headers.get("origin"), deps.config.allowedOrigins);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  try {
    const route = routeOf(new URL(req.url).pathname);
    const known = route in getHandlers || route in postHandlers;
    if (!known) throw new ApiError("not_found");

    const table = req.method === "GET" ? getHandlers : req.method === "POST" ? postHandlers : null;
    const handler = table?.[route];
    if (!handler) throw new ApiError("method_not_allowed");

    const result = await handler(req, deps);
    return jsonResponse({ ok: true, ...(result as object) }, 200, cors);
  } catch (e) {
    if (e instanceof ApiError) return errorResponse(e, cors);
    // Name only: messages from upstream libraries could echo request content.
    console.error("unhandled_error", e instanceof Error ? e.name : "unknown");
    return errorResponse(new ApiError("internal"), cors);
  }
}
