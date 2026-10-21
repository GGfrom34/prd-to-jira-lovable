import { MESSAGES, type FailReason } from "./guardrails.ts";

export type ErrorCode =
  | FailReason
  | "invalid_input"
  | "wrong_step"
  | "busy"
  | "too_many_sessions"
  | "sheet_error"
  | "payload_too_large"
  | "not_found"
  | "method_not_allowed"
  | "misconfigured"
  | "internal";

const EXTRA_MESSAGES: Record<Exclude<ErrorCode, FailReason>, string> = {
  invalid_input: "That request wasn't valid. Please check it and try again.",
  wrong_step: "That step isn't available right now. Please follow the steps in order.",
  busy: "Your previous request is still running. Please wait a moment.",
  too_many_sessions: "Too many sessions started from your connection today. Please come back tomorrow.",
  sheet_error: "We couldn't save your feedback. Please try again.",
  payload_too_large: "That request was too large.",
  not_found: "Not found.",
  method_not_allowed: "Method not allowed.",
  misconfigured: "This prototype is temporarily unavailable.",
  internal: "Something went wrong. Please try again.",
};

const STATUS: Record<ErrorCode, number> = {
  global_cap: 429,
  visitor_cap: 429,
  session_cap: 429,
  rate_limited: 429,
  too_many_sessions: 429,
  disabled: 503,
  misconfigured: 503,
  no_session: 404,
  not_found: 404,
  upstream_error: 502,
  sheet_error: 502,
  invalid_input: 400,
  wrong_step: 409,
  busy: 409,
  payload_too_large: 413,
  method_not_allowed: 405,
  internal: 500,
};

export class ApiError extends Error {
  code: ErrorCode;
  detail?: string;
  constructor(code: ErrorCode, message?: string, detail?: string) {
    super(message ?? messageFor(code));
    this.name = "ApiError";
    this.code = code;
    this.detail = detail;
  }
}

export function messageFor(code: ErrorCode): string {
  return code in MESSAGES ? MESSAGES[code as FailReason] : EXTRA_MESSAGES[code as keyof typeof EXTRA_MESSAGES];
}

export function statusFor(code: ErrorCode): number {
  return STATUS[code];
}

export function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  const base: Record<string, string> = { vary: "Origin" };
  if (origin && allowed.includes(origin)) {
    base["access-control-allow-origin"] = origin;
    base["access-control-allow-methods"] = "GET, POST, OPTIONS";
    base["access-control-allow-headers"] = "content-type, authorization, apikey, x-client-info";
    base["access-control-max-age"] = "86400";
  }
  return base;
}

export function jsonResponse(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}

export function errorResponse(err: ApiError, extra: Record<string, string> = {}): Response {
  const error: { code: string; message: string; detail?: string } = { code: err.code, message: err.message };
  if (err.detail) error.detail = err.detail;
  return jsonResponse({ ok: false, error }, statusFor(err.code), extra);
}

export async function readJson(req: Request, maxChars: number): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxChars) throw new ApiError("payload_too_large");
  const text = await req.text();
  if (text.length > maxChars) throw new ApiError("payload_too_large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError("invalid_input", "Request body must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ApiError("invalid_input", "Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

// Cloudflare's header cannot be forged by the client. The others are fallbacks
// and need checking against the real deployment.
export function clientIp(headers: Headers): string {
  const cf = headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const real = headers.get("x-real-ip");
  if (real) return real.trim();
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return "unknown";
}

// Works both for /functions/v1/api/<route> and for a bare /api/<route>.
export function routeOf(pathname: string): string {
  const m = pathname.match(/(?:^|\/)api(?:\/(.*))?$/);
  const route = m ? (m[1] ?? "") : pathname.replace(/^\/+/, "");
  return route.replace(/\/+$/, "");
}
