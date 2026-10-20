# Deploy runbook (own Supabase project)

About 45 minutes the first time. Steps marked **You** need your accounts or credentials. Steps marked **Claude** can be run by Claude Code once you have finished the step before them. Never paste a key into chat or into Lovable.

## 1. Anthropic (You)
1. In the Anthropic Console, create a **new Workspace** just for this prototype.
2. Set a **monthly spend limit** on that workspace. This is the outer wall: if anything in the backend is wrong, this still stops the spending.
3. Create an **API key inside that workspace**. Keep it somewhere private for step 4.

## 2. Supabase project (You)
1. Go to <https://supabase.com/dashboard> and create a **New project**. Choose an **EU region** (for example London or Frankfurt), because visitors' text is processed there. Save the database password somewhere safe.
2. Note the **project ref**: the short id in the dashboard URL (`supabase.com/dashboard/project/<ref>`).
3. You do **not** need to copy any API key for the frontend: the function is public by design. The function gets Supabase's secret key automatically; never copy that key anywhere.

## 3. Google Sheet (You)
1. Create a Google Sheet. Rename the first tab to `Responses` and add this header row: `survey_id | date_utc | version | q1 | q2 | q3 | q4 | q5`.
2. **Extensions > Apps Script**. Replace the contents with [`apps-script/Code.gs`](apps-script/Code.gs).
3. **Project Settings > Script properties**: add `SHARED_SECRET` with a long random value (this becomes `SHEET_SHARED_SECRET`).
4. **Deploy > New deployment > Web app**. Execute as: **Me**. Who has access: **Anyone**. Copy the web app URL (this becomes `SHEET_WEBHOOK_URL`).

## 4. Fill in your secrets file (You)
```bash
cp .env.example .env
```
Edit `.env` in your editor and fill in every empty value. `.env` is gitignored. Claude will run the next commands without reading this file.

## 5. Log in and link (You, then Claude)
Run this yourself, because it opens your browser to sign in:
```bash
npx supabase login
```
Tell Claude when it is done. Claude then runs, in this folder:
```bash
npx supabase init
npx supabase link --project-ref <ref>
```

## 6. Create the database tables (Claude or You)
Simplest: in the Supabase dashboard open **SQL Editor**, paste the whole of [`supabase/migrations/001_budget_and_sessions.sql`](supabase/migrations/001_budget_and_sessions.sql) and run it. Or Claude can run `npx supabase db push` (it asks for the database password from step 2).

Then, in the SQL Editor, schedule the daily purge that deletes old counters and sessions. Enable the `pg_cron` extension first (Database > Extensions):
```sql
select cron.schedule('prd-assistant-purge', '0 3 * * *', $$select purge_old(current_date - 1)$$);
```

## 7. Secrets and deploy (Claude)
```bash
npx supabase secrets set --env-file .env
npx supabase functions deploy api
```
`SUPABASE_URL` and the Supabase secret key are provided to the function automatically. The function is public (`verify_jwt = false` in `supabase/config.toml`).

## 8. Smoke test (Claude)
```bash
curl -s https://<ref>.supabase.co/functions/v1/api/status
```
Expected: `{"ok":true,"available":true}`. If you see `misconfigured`, a secret is missing. Check the function logs in the dashboard (they list missing variable names only). If you get a database error, the Supabase secret key may not be reaching the function as expected, which is the main unverified assumption.

## 9. Connect the frontend (You, in Lovable)
Paste the "switch to the real API" prompt from the chat, using `https://<ref>.supabase.co/functions/v1/api`. No key is needed. Then paste `test-prd-dog-sitters.md` into the preview. Real findings are tailored to that PRD and take 15 to 60 seconds per step.

## 10. Check the limits really work
- Lower `GLOBAL_DAILY_TOKEN_CAP` to a tiny value (for example 5000) with `npx supabase secrets set GLOBAL_DAILY_TOKEN_CAP=5000`, run one review, and confirm the capacity-reached message appears and `/status` reports `available: false`.
- Compare the tokens used in the Anthropic Console with `select scope, used from token_usage;` in the SQL Editor. They should be close.
- Submit the survey once and check one clean row appears in the Sheet with no free text.
- Restore the caps afterwards.

## Kill switch
```sql
update config set value = 'false' where key = 'enabled';
```
