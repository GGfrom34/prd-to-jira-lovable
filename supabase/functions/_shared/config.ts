import { DEFAULT_MODEL } from "./agents.ts";
import { loadCaps, type Caps } from "./guardrails.ts";

export type Config = {
  anthropicKey: string;
  model: string;
  caps: Caps;
  visitorSalt: string;
  allowedOrigins: string[];
  supabaseUrl: string;
  serviceRoleKey: string;
  sheetUrl: string;
  sheetSecret: string;
  version: string;
  maxSessionsPerVisitor: number;
};

const REQUIRED = [
  "ANTHROPIC_API_KEY",
  "VISITOR_SALT",
  "ALLOWED_ORIGINS",
  "SUPABASE_URL",
  "SHEET_WEBHOOK_URL",
  "SHEET_SHARED_SECRET",
] as const;

// Supabase injects the new-style secret key as a JSON object keyed by name, and
// still injects the legacy service-role JWT during the transition. Prefer the
// new key and fall back to the legacy one.
export function resolveServiceKey(env: Record<string, string | undefined>): string | null {
  if (env.SUPABASE_SECRET_KEYS) {
    try {
      const keys = JSON.parse(env.SUPABASE_SECRET_KEYS) as Record<string, unknown>;
      const key = keys.default ?? Object.values(keys)[0];
      if (typeof key === "string" && key) return key;
    } catch {
      // fall through to the legacy key
    }
  }
  return env.SUPABASE_SERVICE_ROLE_KEY || null;
}

// Errors name the variables only, never their values, so they are safe to log.
export function loadConfig(env: Record<string, string | undefined>): Config {
  const missing: string[] = REQUIRED.filter((k) => !env[k]);
  const serviceKey = resolveServiceKey(env);
  if (!serviceKey) missing.push("SUPABASE_SECRET_KEYS or SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length > 0) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  if ((env.VISITOR_SALT as string).length < 16) throw new Error("VISITOR_SALT must be at least 16 characters");

  const maxSessions = Number(env.MAX_SESSIONS_PER_VISITOR_PER_DAY ?? "10");
  if (!Number.isInteger(maxSessions) || maxSessions <= 0) {
    throw new Error("MAX_SESSIONS_PER_VISITOR_PER_DAY must be a positive integer");
  }

  return {
    anthropicKey: env.ANTHROPIC_API_KEY as string,
    model: env.ANTHROPIC_MODEL || DEFAULT_MODEL,
    caps: loadCaps(env),
    visitorSalt: env.VISITOR_SALT as string,
    allowedOrigins: (env.ALLOWED_ORIGINS as string).split(",").map((o) => o.trim()).filter(Boolean),
    supabaseUrl: (env.SUPABASE_URL as string).replace(/\/+$/, ""),
    serviceRoleKey: serviceKey as string,
    sheetUrl: env.SHEET_WEBHOOK_URL as string,
    sheetSecret: env.SHEET_SHARED_SECRET as string,
    version: env.PROTOTYPE_VERSION || "0.1",
    maxSessionsPerVisitor: maxSessions,
  };
}
