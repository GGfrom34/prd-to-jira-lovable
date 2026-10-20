// Supabase Edge Function entrypoint. Everything with logic lives in _shared/ and
// is tested under Node; this file only wires real dependencies into it.
import { handle, type Deps } from "../_shared/api.ts";
import { createMessage } from "../_shared/anthropic.ts";
import { loadConfig, type Config } from "../_shared/config.ts";
import { rpcDb } from "../_shared/db.ts";
import { ApiError, corsHeaders, errorResponse } from "../_shared/http.ts";
import { postSurveyRow } from "../_shared/survey.ts";

let config: Config | null = null;
try {
  config = loadConfig(Deno.env.toObject());
} catch (e) {
  // The message lists variable names only, never values.
  console.error("config_invalid", e instanceof Error ? e.message : "unknown");
}

const deps: Deps | null = config
  ? {
      config,
      db: rpcDb(config.supabaseUrl, config.serviceRoleKey),
      claude: (params) => createMessage(params, (config as Config).anthropicKey),
      appendSurveyRow: (row) => postSurveyRow((config as Config).sheetUrl, (config as Config).sheetSecret, row),
      now: () => new Date(),
      randomId: () => crypto.randomUUID(),
    }
  : null;

Deno.serve((req) => {
  if (!deps) return errorResponse(new ApiError("misconfigured"), corsHeaders(null, []));
  return handle(req, deps);
});
