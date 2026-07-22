import test from "node:test";
import assert from "node:assert/strict";
import { claudeChat, extractJson } from "../functions/api/_claude.js";
import {
  onRequestPost,
  parseClaudeSegmentsResponse,
  SEGMENT_OUTPUT_SCHEMA,
  validateScriptCoverage,
} from "../functions/api/segment.js";

test("extractJson accepts a normal markdown JSON fence", () => {
  assert.equal(extractJson('```json\n{"segments":[]}\n```'), '{"segments":[]}');
});

test("extractJson accepts an unterminated markdown fence around complete JSON", () => {
  assert.equal(extractJson('```json\n{"segments":[]}'), '{"segments":[]}');
});

test("extractJson isolates JSON after prose and ignores braces in strings", () => {
  assert.equal(
    extractJson('Here is the result:\n{"text":"a } brace", "nested":{"ok":true}}\nDone.'),
    '{"text":"a } brace", "nested":{"ok":true}}',
  );
});

test("extractJson leaves genuinely truncated JSON to produce a structural parse error", () => {
  const extracted = extractJson('```json\n{"segments":[');
  assert.equal(extracted, '{"segments":[');
  assert.throws(() => JSON.parse(extracted), /JSON/);
});

test("segment response rejects max-token truncation before attempting JSON parsing", () => {
  assert.throws(
    () => parseClaudeSegmentsResponse({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"segments":[' }] }),
    /32,000-token output limit/,
  );
});

test("segment response rejects a stream missing its final stop reason", () => {
  assert.throws(
    () => parseClaudeSegmentsResponse({ stop_reason: null, content: [{ type: "text", text: '{"segments":[]}' }] }),
    /missing stop reason/,
  );
});

test("segment response parses a completed fenced payload", () => {
  const parsed = parseClaudeSegmentsResponse({
    stop_reason: "end_turn",
    content: [{ type: "text", text: '```json\n{"segments":[]}\n```' }],
  });
  assert.deepEqual(parsed, { segments: [] });
});

test("claudeChat sends native JSON schema alongside effort config", async () => {
  const originalFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    assert.equal(init.signal, signal);
    return new Response("{}", { status: 200 });
  };
  const signal = new AbortController().signal;
  try {
    const schema = { type: "object", properties: {}, additionalProperties: false };
    await claudeChat(
      { ANTHROPIC_API_KEY: "test-only" },
      { model: "test", system: "test", messages: [], max_tokens: 10, output_schema: schema, signal },
    );
    assert.equal(sent.output_config.effort, "low");
    assert.deepEqual(sent.output_config.format, { type: "json_schema", schema });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("segment schema uses only Anthropic-supported structural keywords", () => {
  const forbidden = new Set(["maxItems", "minItems", "maxLength", "minLength", "pattern"]);
  const visit = value => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbidden.has(key), false, `unsupported schema keyword: ${key}`);
      visit(child);
    }
  };
  visit(SEGMENT_OUTPUT_SCHEMA);
});

test("claudeChat reconstructs a streamed structured response", async () => {
  const originalFetch = globalThis.fetch;
  const events = [
    'data: {"type":"message_start","message":{"id":"msg_test"}}\n\n',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"{\\"segments\\":"}}\n\n',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"[]}"}}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
  ];
  globalThis.fetch = async (_url, init) => {
    assert.equal(JSON.parse(init.body).stream, true);
    return new Response(new ReadableStream({
      start(controller) {
        events.forEach(event => controller.enqueue(new TextEncoder().encode(event)));
        controller.close();
      },
    }), { status: 200 });
  };
  try {
    const response = await claudeChat(
      { ANTHROPIC_API_KEY: "test-only" },
      { model: "test", system: "test", messages: [], max_tokens: 10, stream: true },
    );
    assert.equal(response.ok, true);
    assert.deepEqual(await response.json(), {
      id: "msg_test",
      type: "message",
      stop_reason: "end_turn",
      content: [{ type: "text", text: '{"segments":[]}' }],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("script coverage accepts whitespace changes but rejects missing narration", () => {
  assert.doesNotThrow(() => validateScriptCoverage("One\n\ntwo.", [{ text: "One" }, { text: "two." }]));
  assert.throws(() => validateScriptCoverage("One two.", [{ text: "One" }]), /complete script exactly/);
});

test("segment endpoint streams a complete browser-facing JSON response", async () => {
  const originalFetch = globalThis.fetch;
  const modelPayload = JSON.stringify({ segments: [{
    text: "Hello world.", family: "feel", subject: null, categoryClaim: null, findable: null,
    query: "person greeting", reason: "visible greeting", visualMode: "stock",
    visualQueries: ["person greeting"], eraHint: null, visualGoal: "Show a greeting",
    coverageMode: "new", visualId: "v0", visualRef: null, continuityReason: null, noneKind: null,
  }] });
  const sse = [
    { type: "message_start", message: { id: "msg_endpoint" } },
    { type: "content_block_delta", delta: { type: "text_delta", text: modelPayload } },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
  globalThis.fetch = async () => new Response(sse, { status: 200 });
  try {
    const response = await onRequestPost({
      request: new Request("https://example.test/api/segment", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ script: "Hello world." }),
      }),
      env: { ANTHROPIC_API_KEY: "test-only" },
    });
    assert.equal(response.headers.get("content-encoding"), "identity");
    const data = JSON.parse(await response.text());
    assert.equal(data.error, undefined, data.error);
    assert.equal(data.segments.length, 1);
    assert.equal(data.segments[0].coverageMode, "new");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("segment endpoint never retries a failed paid model request", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("temporary upstream failure", { status: 500 });
  };
  try {
    const response = await onRequestPost({
      request: new Request("https://example.test/api/segment", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ script: "Hello world." }),
      }),
      env: { ANTHROPIC_API_KEY: "test-only" },
    });
    const data = JSON.parse(await response.text());
    assert.match(data.error, /temporary upstream failure/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("segment endpoint flushes immediately before the model finishes", async () => {
  const originalFetch = globalThis.fetch;
  let release;
  globalThis.fetch = async () => new Promise(resolve => { release = resolve; });
  try {
    const response = await onRequestPost({
      request: new Request("https://example.test/api/segment", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ script: "Hello world." }),
      }),
      env: { ANTHROPIC_API_KEY: "test-only" },
    });
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.equal(first.value.byteLength, 2048);
    await reader.cancel();
    release(new Response("cancelled", { status: 499 }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cancelling the browser response aborts the upstream model request", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamSignal;
  globalThis.fetch = async (_url, init) => {
    upstreamSignal = init.signal;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  };
  try {
    const response = await onRequestPost({
      request: new Request("https://example.test/api/segment", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ script: "Hello world." }),
      }),
      env: { ANTHROPIC_API_KEY: "test-only" },
    });
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    assert.equal(upstreamSignal.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Claude SSE parsing accepts CRLF and arbitrary byte boundaries", async () => {
  const originalFetch = globalThis.fetch;
  const events = [
    { type: "message_start", message: { id: "msg_crlf" } },
    { type: "content_block_delta", delta: { type: "text_delta", text: '{"segments":[]}' } },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
  ].map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join("");
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      const bytes = new TextEncoder().encode(events);
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    },
  }), { status: 200 });
  try {
    const response = await claudeChat(
      { ANTHROPIC_API_KEY: "test-only" },
      { model: "test", system: "test", messages: [], max_tokens: 10, stream: true },
      0,
    );
    assert.deepEqual(await response.json(), {
      id: "msg_crlf", type: "message", stop_reason: "end_turn",
      content: [{ type: "text", text: '{"segments":[]}' }],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
