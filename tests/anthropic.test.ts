import { test } from "node:test";
import assert from "node:assert/strict";
import { createMessage, type MessageParams } from "../supabase/functions/_shared/anthropic.ts";

const PARAMS: MessageParams = {
  model: "claude-sonnet-5",
  max_tokens: 100,
  system: "sys",
  messages: [{ role: "user", content: "SECRET PRD TEXT" }],
  tools: [{ name: "t", description: "d", input_schema: { type: "object" } }],
  tool_choice: { type: "tool", name: "t" },
};

function fakeFetch(status: number, body: unknown, seen?: { url?: string; init?: RequestInit }): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (seen) {
      seen.url = String(url);
      seen.init = init;
    }
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("createMessage posts to the Messages API with the key in a header, not the body", async () => {
  const seen: { url?: string; init?: RequestInit } = {};
  const reply = { content: [], stop_reason: "tool_use", usage: { input_tokens: 5, output_tokens: 6 } };
  const res = await createMessage(PARAMS, "sk-ant-test-key", fakeFetch(200, reply, seen));

  assert.equal(seen.url, "https://api.anthropic.com/v1/messages");
  const headers = seen.init?.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "sk-ant-test-key");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(String(seen.init?.body).includes("sk-ant-test-key"), false);
  assert.equal(JSON.parse(String(seen.init?.body)).model, "claude-sonnet-5");
  assert.deepEqual(res.usage, { input_tokens: 5, output_tokens: 6 });
});

test("a 429 becomes a RateLimitError so it shows the capacity message", async () => {
  await assert.rejects(
    createMessage(PARAMS, "k", fakeFetch(429, { error: { message: "rate limited" } })),
    (e: Error & { status?: number }) => e.name === "RateLimitError" && e.status === 429,
  );
});

test("exhausted credit (a 400) is also treated as a RateLimitError", async () => {
  await assert.rejects(
    createMessage(PARAMS, "k", fakeFetch(400, { error: { message: "Your credit balance is too low to access the API" } })),
    (e: Error) => e.name === "RateLimitError",
  );
});

test("other failures are plain AnthropicErrors and never echo the request", async () => {
  await assert.rejects(
    createMessage(PARAMS, "k", fakeFetch(500, { error: { message: "boom" } })),
    (e: Error & { status?: number }) => e.name === "AnthropicError" && e.status === 500 && !e.message.includes("SECRET"),
  );
  await assert.rejects(
    createMessage(PARAMS, "k", fakeFetch(502, "not json")),
    (e: Error) => e.message === "HTTP 502",
  );
});
