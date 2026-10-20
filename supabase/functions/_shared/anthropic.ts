// Minimal Anthropic Messages API client over fetch, so it runs unchanged in
// Deno Edge Functions and in Node, with no SDK dependency.
import type { Usage } from "./guardrails.ts";

export type Tool = { name: string; description: string; input_schema: object };

export type MessageParams = {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: "user"; content: string }[];
  tools: Tool[];
  tool_choice: { type: "tool"; name: string };
};

export type ContentBlock =
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "text"; text: string };

export type MessageResponse = {
  content: ContentBlock[];
  stop_reason: string | null;
  usage: Usage;
};

export class AnthropicError extends Error {
  status: number;
  constructor(status: number, message: string, name = "AnthropicError") {
    super(message);
    this.name = name;
    this.status = status;
  }
}

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const TIMEOUT_MS = 100_000;

// Errors carry only Anthropic's own error message, never the request, because
// the request contains the visitor's PRD.
export async function createMessage(
  params: MessageParams,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MessageResponse> {
  const res = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      // keep the status-only message
    }
    // Exhausted credit arrives as a 400, and shares the "capacity reached" handling
    // with 429 so the visitor sees one consistent message.
    const rateLimited = res.status === 429 || (res.status === 400 && /credit balance/i.test(message));
    throw new AnthropicError(res.status, message, rateLimited ? "RateLimitError" : "AnthropicError");
  }

  return (await res.json()) as MessageResponse;
}
