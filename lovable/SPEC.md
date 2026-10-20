# Lovable spec: PRD Assistant

## Part A: for you (not for Lovable)

**How to use this file**
1. Create the Lovable project and connect it to its own GitHub repo (not the portfolio repo). Put this file in the repo root so Lovable can see it, or paste Part B into Project knowledge.
2. Build the UI against the mock API first (section 8), so you do not need the backend deployed. Switch to the real API by setting two environment variables.
3. Paste the kickoff prompt below as your first message.

**Kickoff prompt (paste into Lovable)**
> Build the frontend described in SPEC.md, Part B. Start with the mock API (`VITE_USE_MOCK=true`) so everything works without a backend. Follow the "Hard rules" section exactly. Do not create or change anything under `supabase/`, and do not add authentication, a database, analytics, cookies, web fonts or any browser storage.

**Before you go live**
- Add the Lovable preview URL, the published URL and any custom domain to the backend's `ALLOWED_ORIGINS` secret. Requests from an unlisted origin fail with a CORS error.
- Set `VITE_API_BASE_URL` to `https://<project-ref>.supabase.co/functions/v1/api`. The API is public, so the frontend needs no key at all.
- Fill the placeholder for Anthropic's data-retention link in the privacy notice (section 6). I have not invented a URL.
- Check whether Lovable overwrites hand-edited files under `supabase/`, and whether a free-plan "built with Lovable" badge loads anything third-party. Both are unverified.
- The five survey questions come from the backend (`survey.ts`). Edit their wording there, not in the frontend.
- Skipping the survey is allowed (a quiet link). Remove it if you want every visitor to answer.

---

## Part B: the spec for Lovable

### 1. What you are building
A single-page web app for product managers. The visitor pastes a PRD, gets quality feedback, accepts or edits suggested fixes, signs off the improved PRD, reviews a proposed split into one Epic and several Story/Task issues (with one chance to ask for changes), pastes a Jira project link, is told this prototype cannot create the tickets, and then answers five 1-5 rating questions.

All intelligence lives in a backend API (section 4). The frontend only collects input, calls the API and shows results. Use React, TypeScript and Tailwind (Lovable's defaults).

### 2. Hard rules (these override everything else)
1. **Never call Anthropic or any AI provider from the browser.** The only network target is `VITE_API_BASE_URL`.
2. **Hold all visitor content in React state only.** No `localStorage`, `sessionStorage`, IndexedDB, cookies or URL parameters for the PRD, findings, proposals, split, Jira link, session id or ratings. A refresh intentionally starts over.
3. **No analytics, trackers, third-party scripts, embeds or CDN-hosted web fonts.** Use the system font stack. (Fetching fonts from a third party discloses the visitor's IP, which this project avoids for privacy reasons.)
4. **Never log request or response bodies** (`console.log` of anything the visitor typed or received is forbidden).
5. **Render all returned text as plain text or sanitised Markdown.** No `dangerouslySetInnerHTML`, no raw HTML in Markdown (do not enable `rehype-raw`).
6. **The survey has no free-text inputs.** Only five 1-5 rating controls.
7. **Do not create or modify anything under `supabase/`**, and do not add Supabase Auth, tables or functions. The backend is hand-maintained.
8. **The frontend holds no keys or secrets.** The API is public and protected by usage caps and an allowed-origins list, so there is nothing secret to put in the browser. Never add an API key, anon key or token to the code.

### 3. Environment variables
| Name | Purpose |
|---|---|
| `VITE_API_BASE_URL` | Base URL of the API, no trailing slash |
| `VITE_USE_MOCK` | `true` uses the mock API in section 8 instead of the network |

### 4. API contract
Every POST sends `Content-Type: application/json`. Send no `Authorization` or `apikey` header. Every response is JSON:
- Success: `{ "ok": true, ...fields }`
- Failure: `{ "ok": false, "error": { "code": string, "message": string } }`, with an HTTP status.

#### Types
```ts
type Dimension = "problem_statement" | "success_metrics" | "scope" | "requirements_acceptance_criteria"
  | "edge_cases" | "non_functional" | "dependencies_risks_questions" | "rollout_rollback";
type Severity = "blocker" | "gap" | "nice_to_have";
type Verdict = "ready" | "needs_targeted_fixes" | "needs_significant_rework";

interface Finding { id: string; dimension: Dimension; severity: Severity; section: string; quote: string | null; issue: string }
interface Review { verdict: Verdict; summary: string; findings: Finding[];
  skipped_dimensions: { dimension: Dimension; reason: string }[]; strengths: string | null }
interface Proposal { finding_id: string; question: string; before: string | null; proposed_text: string }
interface Decision { finding_id: string; action: "accept" | "edit" | "defer"; text?: string }
interface SplitIssue { type: "story" | "task"; title: string; description: string; acceptance_criteria: string[] }
interface Split { epic: { title: string; description: string }; issues: SplitIssue[] }
```

#### Endpoints
| Method and path | Request body | Success fields |
|---|---|---|
| `GET /status` | none | `available: boolean` |
| `GET /survey` | none | `questions: string[]` (5), `scale: { min, max, minLabel, maxLabel }` |
| `POST /session` | none | `session_id: string` |
| `POST /review` | `session_id`, `prd` | `Review` fields (spread into the response) |
| `POST /improve` | `session_id`, `prd`, `findings: Finding[]` | `proposals: Proposal[]` |
| `POST /finalize` | `session_id`, `prd`, `findings`, `proposals`, `decisions: Decision[]` | `prd_markdown: string` |
| `POST /sign-off` | `session_id` | `signed_off: true` |
| `POST /split` | `session_id`, `prd` | `Split` fields (`epic`, `issues`) |
| `POST /revise-split` | `session_id`, `prd`, `previous: Split`, `feedback: string` | `Split` fields |
| `POST /submit-link` | `session_id`, `url` | `accepted: true` |
| `POST /submit-survey` | `session_id`, `answers: number[]` (5) | `thanks: true` |

#### Rules the server enforces (mirror them in the UI so visitors never hit them)
- `prd` is at most **12,000** characters for `/review`, `/improve` and `/finalize`, and at most **20,000** for `/split` and `/revise-split`. Count with JavaScript `string.length`. Never truncate silently.
- `feedback` is 1 to 500 characters. Edited decision `text` is at most 2,500.
- Send `findings` and `proposals` back **exactly as received, in the same order** (the server numbers findings by position).
- `decisions`: 1 to 20 items, one per finding id at most. `edit` requires `text`. `accept` and `edit` need a matching proposal; `defer` works on any finding.
- A whole request body must be under about 100,000 characters.
- Steps are forward-only. Allowed order: `session` then `review`, then either `sign-off` (skipping fixes) or `improve` then `finalize` then `sign-off`, then `split`, then optionally one `revise-split`, then `submit-link`, then `submit-survey`. After `improve` you must `finalize` (with at least one decision, which can be Defer) before signing off.
- `revise-split` works once per session. `submit-survey` works once.
- `submit-link` accepts only `https://<name>.atlassian.net/` links whose path starts with `/jira/`, `/browse/` or `/projects/`. The link is not fetched or stored.

#### Errors
Show `error.message` to the visitor as given. Branch behaviour on `error.code`:

| `code` | HTTP | What the UI does |
|---|---|---|
| `invalid_input` | 400 | Show the message next to the field or action, keep the visitor's input |
| `global_cap`, `rate_limited` | 429 | Full-screen **capacity reached** state (section 7) |
| `visitor_cap` | 429 | Full-screen **allowance reached** state |
| `session_cap` | 429 | Message plus a "Start a new session" button |
| `too_many_sessions` | 429 | Message only |
| `disabled`, `misconfigured` | 503 | Full-screen **temporarily unavailable** state |
| `upstream_error`, `sheet_error` | 502 | Message plus a "Try again" button that repeats the same call, keeping all input |
| `busy` | 409 | "Still running" message; keep controls disabled for 5 seconds, then allow retry |
| `wrong_step`, `no_session` | 409, 404 | "Something got out of sync" message plus a "Start again" button |
| `payload_too_large`, `internal`, network failure, timeout | 413, 500 | Generic message plus "Try again" |

Never retry automatically: every retry can spend the visitor's limited allowance.

### 5. Screens and behaviour
One route (`/`). The step lives in memory, with no browser-history entries per step. Show a progress indicator with six labels: **Paste, Review, Improve, Sign off, Split, Finish**. Visitors cannot navigate backwards. On every step change, move keyboard focus to the new step's heading. Show a browser "Leave site?" prompt (`beforeunload`) once a PRD has been pasted.

While a request is in flight: disable the triggering button, show a spinner and an `aria-live="polite"` status line, and set a client timeout of **150 seconds**. AI calls usually take 15-60 seconds. Use these status lines:
`/review` "Reviewing your PRD against eight quality checks..." · `/improve` "Drafting fixes..." · `/finalize` "Applying your choices..." · `/split` "Proposing how to split the work..." · `/revise-split` "Revising the split..."

**Screen 0: Paste**
- On load call `GET /status`. If `available` is false, show the capacity-reached state and no form.
- Heading, one-sentence value statement, a numbered "How it works" list of the six steps, and the privacy notice (section 6) with a required checkbox: "I understand I should not paste confidential or personal data."
- A large textarea with a live counter `n / 12,000`. Over the limit: counter turns red, button disabled, text kept.
- Button **Review my PRD**, disabled until the textarea has text, is within the limit and the box is ticked. On click: `POST /session`, then `POST /review`.

**Screen 1: Review**
- Verdict badge (`ready` "Ready to build from", `needs_targeted_fixes` "Needs targeted fixes", `needs_significant_rework` "Needs significant rework"), then `summary`.
- Findings grouped under **Blockers**, **Gaps**, **Nice-to-haves**. Each shows the dimension as a human label (for example "Success metrics"), the `section`, the `quote` in a quote style when present, and the `issue`. Convey severity with a label and icon as well as colour.
- If `skipped_dimensions` is non-empty, a collapsed "Checks skipped" list with reasons. If `strengths` is present, a short "What's working" note.
- Actions: if there is at least one blocker or gap, primary **Suggest fixes** (`POST /improve`) and secondary **Sign off as is** (`POST /sign-off`, then Screen 3 with the original PRD). When there are blockers, "Sign off as is" shows a confirmation: "This PRD still has blockers. Sign off anyway?". If there are no blockers or gaps, show only **Sign off**.

**Screen 2: Improve**
- One card per proposal, in order. Each card shows: the finding (severity, issue); the `question` as the card's prompt; **Before** (`before`, or the italic text "Not in your PRD yet" when null); and an editable textarea prefilled with `proposed_text`.
- Highlight any `[square-bracketed]` text in the textarea's preview line and show a note: "Contains assumptions in [brackets]. Check them before accepting."
- A three-way control per card: **Accept as written**, **Use my edit**, **Defer**. Editing the textarea selects **Use my edit** automatically. **Defer** shows "Will be listed as an open question". Cards for blockers and gaps start undecided; nice-to-have cards may be left undecided and are then left out of `decisions`.
- Findings that have no proposal are listed in a "No suggestion drafted" section, each with a **Defer** checkbox only.
- Button **Apply my choices** is enabled when every blocker and gap has a choice and there is at least one decision overall. It sends `POST /finalize` with the `decisions` array (`accept`, `edit` with `text`, or `defer`). Then go to Screen 3 with `prd_markdown`.
- If `proposals` came back empty, show only the Defer-only list; the visitor must defer at least one finding to continue.

**Screen 3: Sign off**
- Show the PRD text in an editable monospace textarea with a Preview tab (sanitised Markdown), a live counter `n / 20,000`, **Copy** and **Download .md** buttons.
- If the text contains `[bracketed]` assumptions, show: "N assumptions in [brackets] remain. Edit them above before signing off."
- Primary **Sign off this PRD**. If the visitor has not already signed off, call `POST /sign-off`; then call `POST /split` with the text currently in the box. If `/sign-off` succeeds but `/split` fails, the retry must call only `/split` (remember that sign-off is done).
- Over 20,000 characters disables the button.

**Screen 4: Split**
- An Epic card (title, description) and a list of issues. Each issue shows a Story or Task badge, title, description and its acceptance criteria as a bullet list (omit the list when empty).
- **Copy as Markdown** button producing: `# <epic title>`, the epic description, then `## [Story|Task] <title>`, the description and `- ` bullets.
- Feedback box ("What would you change about this split?"), 500-character counter, button **Revise once**. After a successful revise, replace the split with the revised one, hide the feedback box and show "You've used your one revision."
- Primary **Looks good, continue** (no API call), moving to Screen 5.

**Screen 5: Jira link, then explainer**
- Label "Where should these tickets go? Paste a link to your Jira project." with a text input. Example placeholder: `https://your-team.atlassian.net/jira/software/projects/ABC`. Submit calls `POST /submit-link`; on `invalid_input` show the message under the field.
- After success, replace the form with the explainer (exact copy in section 6) and keep the **Copy as Markdown** button visible. Primary **Share quick feedback**.

**Screen 6: Survey, then thanks**
- Call `GET /survey` when the screen opens. Render each question with five radio buttons from `scale.min` to `scale.max`, labelled at the ends with `scale.minLabel` and `scale.maxLabel`. All five are required. Use a native radio group per question (keyboard accessible), laid out vertically on mobile.
- Copy under the form: "Anonymous. This stores only your five ratings and the date."
- Button **Submit feedback** calls `POST /submit-survey` with `answers` in question order. A quiet **Skip** link goes to the thanks screen without calling the API.
- Thanks screen: short thank-you and **Start over**, which clears all state and returns to Screen 0 (a new session is created on the next review).

### 6. Copy
**Privacy notice (Screen 0)**
> Your PRD is sent to Anthropic's Claude API to produce feedback, and nothing you paste is stored by this prototype. Please don't paste confidential or personal data. Only a usage counter and, if you choose to answer it, five 1-5 ratings are kept. Your IP address is never stored: a one-way hash that changes every day is used to limit usage and is deleted after two days. Anthropic's handling of API data is described in [link to Anthropic's current data retention terms].

**Explainer (Screen 5, after the link is accepted)**
> **This prototype stops here.** It doesn't have a Jira integration, so it hasn't created any tickets. Your link was only checked for its format, wasn't opened and hasn't been saved. A full version would connect to Jira through Atlassian's MCP server and create the Epic and issues for you. For now, copy the breakdown above into Jira yourself.

**Capacity reached:** "Today's capacity for this prototype has been used up. Please come back after 00:00 UTC."
**Allowance reached:** "You've reached today's usage allowance. Please come back after 00:00 UTC."
**Temporarily unavailable:** "This prototype is temporarily unavailable."
**Footer (all screens):** "A prototype. AI-generated feedback can be wrong, so review everything before you rely on it." Add a placeholder line for the author name and contact.

Use British English. Plain, direct, friendly tone. Buttons are verbs.

### 7. Full-screen states
Capacity reached, allowance reached and temporarily unavailable each show the message, no form, and no retry button (retrying cannot help). Capacity reached must also be shown if any call returns `global_cap` or `rate_limited`, even mid-flow, because the allowance for the day is gone.

### 8. Mock API (build this first)
Create `src/lib/api.ts` as the only module that talks to the network, exposing one typed function per endpoint. When `VITE_USE_MOCK=true` it returns canned data after a 1.5-second delay. Add a dev-only query parameter `?mockError=<code>` that makes the next AI call fail with that error code, so every error state can be tried. Keep the real and mock implementations behind the same interface.

Mock data (use these exact shapes):
```ts
const mockReview = {
  verdict: "needs_targeted_fixes",
  summary: "Clear problem and scope, but no success metric and no rollout plan.",
  findings: [
    { id: "f1", dimension: "success_metrics", severity: "blocker", section: "Goals", quote: "Let a visitor save the household profile", issue: "No measurable target or measurement window." },
    { id: "f2", dimension: "requirements_acceptance_criteria", severity: "gap", section: "Feature 2: Load a saved profile", quote: null, issue: "No acceptance criteria." },
    { id: "f3", dimension: "rollout_rollback", severity: "gap", section: "Whole PRD", quote: null, issue: "No rollout or rollback plan." },
    { id: "f4", dimension: "non_functional", severity: "nice_to_have", section: "Non-functional requirements", quote: null, issue: "Accessibility is not mentioned." }
  ],
  skipped_dimensions: [],
  strengths: "The problem statement is concrete."
};
const mockProposals = [
  { finding_id: "f1", question: "What number would tell you this worked, and over what time window?", before: null, proposed_text: "Success metric: at least [20%] of returning visitors load a saved profile within [30 days] of launch." },
  { finding_id: "f2", question: "What should happen when there are no saved profiles?", before: "The visitor can open a list of their saved profiles and pick one.", proposed_text: "Acceptance criteria:\n- With no saved profiles, the control shows \"No saved profiles yet\".\n- Selecting a profile fills the input but does not send it." },
  { finding_id: "f3", question: "Does this ship behind a flag?", before: null, proposed_text: "Rollout: ships in one PR with no flag. Rollback is a revert." }
];
const mockSplit = {
  epic: { title: "Saved searches", description: "Let visitors save and reload a household profile.\nSource: PRD: Saved Searches" },
  issues: [
    { type: "story", title: "Save a profile", description: "Visitors can name and save a profile after a recommendation.", acceptance_criteria: ["Save button appears only after a result", "Duplicate names ask to confirm overwrite"] },
    { type: "story", title: "Load a saved profile", description: "Visitors can pick a saved profile to refill the input.", acceptance_criteria: ["Empty state is shown with no profiles"] },
    { type: "task", title: "Accessibility for the controls", description: "Keyboard operable and labelled.", acceptance_criteria: [] }
  ]
};
```
`mockFinalize` returns the visitor's PRD text with each accepted or edited `text` appended under a `## Updates` heading, so the flow is visibly end to end.

### 9. Visual design
- Clean and professional for a product-manager audience. Light theme, one accent colour, generous whitespace, system font stack, rounded cards.
- Single centred column, maximum width about 760px, mobile-first. Textareas are at least 12 rows on desktop.
- WCAG AA contrast. Visible focus rings. Every control reachable and operable by keyboard. Loading and error messages announced through `aria-live`. Do not rely on colour alone to convey severity or state.
- Respect `prefers-reduced-motion` (no spinner animation beyond a simple fade).

### 10. Acceptance checklist
- [ ] With `VITE_USE_MOCK=true`, the whole flow works from paste to thanks.
- [ ] Each `?mockError=` code shows the behaviour in the error table, and the visitor's input survives retryable errors.
- [ ] The Paste button stays disabled for blank text, over 12,000 characters, or an unticked notice box.
- [ ] Improve cannot be submitted until every blocker and gap has a choice.
- [ ] The revise box disappears after one use. The survey cannot be submitted with an unanswered question, and has no free-text field.
- [ ] Refreshing the page loses everything and returns to Screen 0.
- [ ] DevTools shows no `localStorage`, `sessionStorage`, cookies or third-party requests.
- [ ] The built bundle contains no AI provider URL and no key or secret of any kind.
- [ ] The app is usable at 375px width and fully by keyboard.
- [ ] With the real API (`VITE_USE_MOCK=false`): `GET /status` succeeds from the Lovable preview origin (CORS), and a full real run completes.
