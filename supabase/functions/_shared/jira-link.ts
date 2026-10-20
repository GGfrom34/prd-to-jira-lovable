import { ApiError } from "./http.ts";

const HOST = /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/;
const PATHS = ["/jira/", "/browse/", "/projects/"];

// Shape check only. The link is never fetched and never stored: this prototype
// does not integrate with Jira, and the URL names the visitor's organisation.
export function validateJiraLink(raw: unknown): void {
  const fail = () => new ApiError("invalid_input", "Please paste a link to your Jira project, like https://your-team.atlassian.net/jira/software/projects/ABC.");
  if (typeof raw !== "string" || raw.length > 300) throw fail();
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw fail();
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw fail();
  if (!HOST.test(url.hostname)) throw fail();
  if (!PATHS.some((p) => url.pathname.startsWith(p))) throw fail();
}
