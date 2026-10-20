import { ApiError } from "./http.ts";

export const SURVEY_SCALE = { min: 1, max: 5, minLabel: "Strongly disagree", maxLabel: "Strongly agree" } as const;

export const SURVEY_QUESTIONS = [
  "The feedback on my PRD was useful.",
  "The suggested improvements were specific enough to act on.",
  "The proposed epic and ticket split matched how I would break the work down.",
  "This would save me time compared with doing it by hand.",
  "I would use a version of this that creates the Jira tickets for me.",
] as const;

// Strict on purpose: anything beyond a session id and five whole-number ratings
// is refused, so free text can never reach the sheet.
export function parseSurveyBody(body: Record<string, unknown>): number[] {
  for (const key of Object.keys(body)) {
    if (key !== "session_id" && key !== "answers") {
      throw new ApiError("invalid_input", "Only ratings can be submitted.");
    }
  }
  const answers = body.answers;
  if (!Array.isArray(answers) || answers.length !== SURVEY_QUESTIONS.length) {
    throw new ApiError("invalid_input", `Please answer all ${SURVEY_QUESTIONS.length} questions.`);
  }
  return answers.map((a) => {
    if (!Number.isInteger(a) || (a as number) < SURVEY_SCALE.min || (a as number) > SURVEY_SCALE.max) {
      throw new ApiError("invalid_input", `Each rating must be a whole number from ${SURVEY_SCALE.min} to ${SURVEY_SCALE.max}.`);
    }
    return a as number;
  });
}

export type SurveyRow = (string | number)[];

// Posts to the Apps Script web app. The shared secret goes in the body, not the
// URL, so it does not end up in access logs. Apps Script answers a POST with a
// redirect, which fetch follows.
export async function postSurveyRow(
  url: string,
  secret: string,
  row: SurveyRow,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ secret, row }),
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`sheet HTTP ${res.status}`);
  const body = (await res.json()) as { ok?: boolean };
  if (body.ok !== true) throw new Error("sheet rejected the row");
}
