# prd-to-jira-lovable

[![Tests](https://github.com/GGfrom34/prd-to-jira-lovable/actions/workflows/test.yml/badge.svg)](https://github.com/GGfrom34/prd-to-jira-lovable/actions/workflows/test.yml)

This repo will support a Frontend prototype built with Lovable. The prototype is targeted at Product Managers and its goal is to help them efficiently convert Product Requirement Documents (PRDs) into well scoped Jira epic and issue tickets. 

Paste a PRD, get feedback, improve it, sign it off, get an epic/ticket split, submit a Jira link, then rate the tool. A Lovable frontend calls one Supabase Edge Function (`supabase/functions/api`). Claude calls are capped per session, per visitor and globally per day.

## Commands

```bash
npm install
npm test               # 154 tests, no network, no API key
npm run typecheck
npm run sync-prompts   # regenerate prompts from the portfolio repo's .claude agents and skill
npm run eval           # opt-in: real model checks, spends tokens, needs ANTHROPIC_API_KEY
```

## Deploying

The full step-by-step runbook is in [DEPLOY.md](DEPLOY.md). In short:

1. **Supabase project**: apply `supabase/migrations/001_budget_and_sessions.sql` (SQL editor or `supabase db push`).
2. **Google Sheet**: add a `Responses` tab with the header `survey_id | date_utc | version | q1 | q2 | q3 | q4 | q5`. Open Extensions > Apps Script, paste `apps-script/Code.gs`, add the script property `SHARED_SECRET`, and deploy as a web app (Execute as: me, Access: anyone). The deployment URL is `SHEET_WEBHOOK_URL`.
3. **Secrets** (`supabase secrets set NAME=value`):

   | Name | Notes |
   |---|---|
   | `ANTHROPIC_API_KEY` | A dedicated key in its own workspace, with a Console spend limit as the outer wall |
   | `VISITOR_SALT` | 16+ random characters |
   | `ALLOWED_ORIGINS` | Comma-separated exact origins of the Lovable preview and published site |
   | `SHEET_WEBHOOK_URL`, `SHEET_SHARED_SECRET` | From step 2 |
   | `GLOBAL_DAILY_TOKEN_CAP`, `VISITOR_DAILY_TOKEN_CAP`, `SESSION_TOKEN_CAP` | Optional. Defaults 600000 / 120000 / 60000 |
   | `MAX_SESSIONS_PER_VISITOR_PER_DAY`, `ANTHROPIC_MODEL`, `PROTOTYPE_VERSION` | Optional |

   `SUPABASE_URL` and the Supabase secret key (`SUPABASE_SECRET_KEYS`, or the legacy `SUPABASE_SERVICE_ROLE_KEY`) are provided to Edge Functions automatically.
4. **Deploy**: `supabase functions deploy api`.
5. **Schedule a purge**: run `select purge_old(current_date - 1);` daily (Supabase Cron).

## Endpoints

`GET /status`, `GET /survey`, `POST /session`, `/review`, `/improve`, `/finalize`, `/sign-off`, `/split`, `/revise-split`, `/submit-link`, `/submit-survey`. Every POST except `/session` takes the `session_id` from `/session`. The function is public (`verify_jwt = false` in `supabase/config.toml`), so the frontend sends no key; abuse is limited by the token caps, allowed origins and per-visitor limits.

The kill switch is `update config set value = 'false' where key = 'enabled';`.

## Frontend (Lovable)

The frontend is built in Lovable against the API above. The full screen-by-screen spec and API contract are in [lovable/SPEC.md](lovable/SPEC.md).
