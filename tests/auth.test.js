import test from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword, verifyPassword, signSession, verifySession, scriptSeconds, TRIAL_SECONDS_MAX,
  TRIAL_SECONDS_MAX_ACCOUNT,
} from "../functions/api/_auth.js";
import { onRequestPost as segmentPost } from "../functions/api/segment.js";

const env = { SESSION_SECRET: "test-secret" };

function mockKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => { store.set(k, v); },
  };
}

test("password hash verifies with the right password and rejects the wrong one", async () => {
  const { hash, salt } = await hashPassword("correct horse battery");
  assert.equal(await verifyPassword("correct horse battery", salt, hash), true);
  assert.equal(await verifyPassword("wrong password", salt, hash), false);
});

test("same password with different salts produces different hashes", async () => {
  const a = await hashPassword("same password");
  const b = await hashPassword("same password");
  assert.notEqual(a.hash, b.hash);
});

test("session sign/verify roundtrip works and tampering breaks it", async () => {
  const token = await signSession(env, "user@example.test");
  const session = await verifySession(env, token);
  assert.equal(session.email, "user@example.test");

  // Flip one character of the payload — the HMAC must reject it.
  const tampered = (token[0] === "A" ? "B" : "A") + token.slice(1);
  assert.equal(await verifySession(env, tampered), null);
  // Garbage and empty tokens are cleanly null, never throws.
  assert.equal(await verifySession(env, "not-a-token"), null);
  assert.equal(await verifySession(env, null), null);
});

test("scriptSeconds estimates at 2.5 words per second, matching the frontend timeline", () => {
  const words150 = Array(150).fill("word").join(" ");
  assert.equal(scriptSeconds(words150), 60);
  assert.equal(scriptSeconds(""), 0);
});

// The actual enforcement: an exhausted trial refuses BEFORE any model call — globalThis.fetch is
// deliberately poisoned to prove the paid call never fires.
test("segment endpoint refuses an exhausted trial without calling the model", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("model must not be called for an exhausted trial"); };
  try {
    const response = await segmentPost({
      request: new Request("https://example.test/api/segment", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ script: "Hello world." }),
      }),
      env: { ANTHROPIC_API_KEY: "test-only", AUTH_KV: mockKV(), SESSION_SECRET: "test-secret" },
      data: { user: { email: "t@example.test", trialSecondsUsed: TRIAL_SECONDS_MAX_ACCOUNT } },
    });
    assert.equal(response.status, 402);
    const data = await response.json();
    assert.match(data.error, /trial is used up/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Anti-abuse: a brand-new account (0 seconds used) is still refused when the network-level
// record says the trial was already consumed from this IP — the "same user coming back with a
// fresh email" case.
test("a fresh account cannot reset the trial when the IP-level record is exhausted", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("model must not be called"); };
  try {
    // First, find what key the endpoint will derive for this request's IP ("unknown" in tests) by
    // seeding after one legitimate check — instead, seed via the same helper the endpoint uses.
    const { ipTrialKey } = await import("../functions/api/_auth.js");
    const req = new Request("https://example.test/api/segment", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ script: "Hello world." }),
    });
    const testEnv = { ANTHROPIC_API_KEY: "test-only", AUTH_KV: mockKV(), SESSION_SECRET: "test-secret" };
    const key = await ipTrialKey(req, testEnv);
    await testEnv.AUTH_KV.put(key, String(TRIAL_SECONDS_MAX_ACCOUNT));

    const response = await segmentPost({
      request: req,
      env: testEnv,
      data: { user: { email: "fresh-account@example.test", trialSecondsUsed: 0 } },
    });
    assert.equal(response.status, 402);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Success consumes budget on BOTH records (account + IP), and only after generation succeeded.
test("a successful segmentation consumes trial budget on the account and the IP record", async () => {
  const originalFetch = globalThis.fetch;
  const modelPayload = JSON.stringify({ segments: [{
    text: "Hello world.", family: "feel", subject: null, categoryClaim: null,
    query: "person greeting", reason: "greeting", visualMode: "stock",
    visualQueries: ["person greeting"], eraHint: null, visualGoal: null,
    coverageMode: "new", visualId: "v0", visualRef: null, continuityReason: null, noneKind: null,
  }] });
  const sse = [
    { type: "message_start", message: { id: "m" } },
    { type: "content_block_delta", delta: { type: "text_delta", text: modelPayload } },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
  ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  globalThis.fetch = async () => new Response(sse, { status: 200 });
  try {
    const kv = mockKV();
    const response = await segmentPost({
      request: new Request("https://example.test/api/segment", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ script: "Hello world." }),
      }),
      env: { ANTHROPIC_API_KEY: "test-only", AUTH_KV: kv, SESSION_SECRET: "test-secret" },
      data: { user: { email: "consume@example.test", trialSecondsUsed: 0 } },
    });
    const data = JSON.parse(await response.text());
    assert.equal(data.error, undefined, data.error);
    // "Hello world." = 2 words -> ceil(2/2.5) = 1 second consumed, written to both records.
    const userRecord = JSON.parse(kv.store.get("user:consume@example.test"));
    assert.equal(userRecord.trialSecondsUsed, 1);
    const ipEntries = [...kv.store.keys()].filter((k) => k.startsWith("trial:"));
    assert.equal(ipEntries.length, 1);
    assert.equal(kv.store.get(ipEntries[0]), "1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// A FAILED generation must not consume any budget.
test("a failed segmentation consumes no trial budget", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("upstream failure", { status: 500 });
  try {
    const kv = mockKV();
    const response = await segmentPost({
      request: new Request("https://example.test/api/segment", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ script: "Hello world." }),
      }),
      env: { ANTHROPIC_API_KEY: "test-only", AUTH_KV: kv, SESSION_SECRET: "test-secret" },
      data: { user: { email: "failed@example.test", trialSecondsUsed: 0 } },
    });
    const data = JSON.parse(await response.text());
    assert.match(data.error, /upstream failure/);
    assert.equal(kv.store.has("user:failed@example.test"), false);
    assert.equal([...kv.store.keys()].filter((k) => k.startsWith("trial:")).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Guest access (2026-07-23) ──
// The app is usable with no account at all: guests get TRIAL_SECONDS_MAX tracked purely on the
// IP-hash record; accounts get TRIAL_SECONDS_MAX_ACCOUNT (+5 min — the honest half of the
// "sign up for more usage" banner).

test("a guest (no user) can segment, consuming the IP record only", async () => {
  const originalFetch = globalThis.fetch;
  const modelPayload = JSON.stringify({ segments: [{
    text: "Hello world.", family: "feel", subject: null, categoryClaim: null,
    query: "person greeting", reason: "greeting", visualMode: "stock",
    visualQueries: ["person greeting"], eraHint: null, visualGoal: null,
    coverageMode: "new", visualId: "v0", visualRef: null, continuityReason: null, noneKind: null,
  }] });
  const sse = [
    { type: "message_start", message: { id: "m" } },
    { type: "content_block_delta", delta: { type: "text_delta", text: modelPayload } },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
  ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  globalThis.fetch = async () => new Response(sse, { status: 200 });
  try {
    const kv = mockKV();
    const response = await segmentPost({
      request: new Request("https://example.test/api/segment", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ script: "Hello world." }),
      }),
      env: { ANTHROPIC_API_KEY: "test-only", AUTH_KV: kv, SESSION_SECRET: "test-secret" },
      data: { user: null },
    });
    const data = JSON.parse(await response.text());
    assert.equal(data.error, undefined, data.error);
    // No account record is written for a guest — only the IP record.
    assert.equal([...kv.store.keys()].filter((k) => k.startsWith("user:")).length, 0);
    const ipEntries = [...kv.store.keys()].filter((k) => k.startsWith("trial:"));
    assert.equal(ipEntries.length, 1);
    assert.equal(kv.store.get(ipEntries[0]), "1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a guest is refused at the GUEST cap even though an account would still have headroom", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("model must not be called"); };
  try {
    const { ipTrialKey } = await import("../functions/api/_auth.js");
    const req = new Request("https://example.test/api/segment", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ script: "Hello world." }),
    });
    const testEnv = { ANTHROPIC_API_KEY: "test-only", AUTH_KV: mockKV(), SESSION_SECRET: "test-secret" };
    await testEnv.AUTH_KV.put(await ipTrialKey(req, testEnv), String(TRIAL_SECONDS_MAX));
    const response = await segmentPost({ request: req, env: testEnv, data: { user: null } });
    assert.equal(response.status, 402);
    const data = await response.json();
    assert.match(data.error, /[Ss]ign up free/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("signing up genuinely unlocks more: same IP record, account gets the bigger cap", async () => {
  const originalFetch = globalThis.fetch;
  const modelPayload = JSON.stringify({ segments: [{
    text: "Hello world.", family: "feel", subject: null, categoryClaim: null,
    query: "person greeting", reason: "greeting", visualMode: "stock",
    visualQueries: ["person greeting"], eraHint: null, visualGoal: null,
    coverageMode: "new", visualId: "v0", visualRef: null, continuityReason: null, noneKind: null,
  }] });
  const sse = [
    { type: "message_start", message: { id: "m" } },
    { type: "content_block_delta", delta: { type: "text_delta", text: modelPayload } },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
  ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  globalThis.fetch = async () => new Response(sse, { status: 200 });
  try {
    const { ipTrialKey } = await import("../functions/api/_auth.js");
    const req = new Request("https://example.test/api/segment", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ script: "Hello world." }),
    });
    const kv = mockKV();
    const testEnv = { ANTHROPIC_API_KEY: "test-only", AUTH_KV: kv, SESSION_SECRET: "test-secret" };
    // IP already at the guest cap — a guest would be refused (previous test), but an account
    // still has the +5min headroom.
    await kv.put(await ipTrialKey(req, testEnv), String(TRIAL_SECONDS_MAX));
    const response = await segmentPost({
      request: req, env: testEnv,
      data: { user: { email: "upgraded@example.test", trialSecondsUsed: 0 } },
    });
    const data = JSON.parse(await response.text());
    assert.equal(data.error, undefined, data.error);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
