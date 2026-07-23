import test from "node:test";
import assert from "node:assert/strict";
import { stripeFormEncode, constructStripeEvent, encodeRef, decodeRef } from "../functions/api/_stripe.js";
import { onRequestPost as webhookPost } from "../functions/api/stripe-webhook.js";
import { onRequestPost as segmentPost } from "../functions/api/segment.js";
import { PLAN_SECONDS, isSubscribed, monthlyUsageKey } from "../functions/api/_auth.js";

const enc = new TextEncoder();

function mockKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => { store.set(k, v); },
  };
}

// Build a validly-signed Stripe webhook request body + header, the way Stripe does.
async function signedEvent(secret, event) {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { payload, header: `t=${t},v1=${hex}` };
}

test("stripeFormEncode produces PHP-style nested keys for objects and arrays", () => {
  const out = stripeFormEncode({
    mode: "subscription",
    line_items: [{ price: "price_123", quantity: 1 }],
    metadata: { email: "a@b.com" },
  });
  assert.ok(out.includes("mode=subscription"));
  assert.ok(out.includes("line_items%5B0%5D%5Bprice%5D=price_123"));
  assert.ok(out.includes("metadata%5Bemail%5D=a%40b.com"));
});

test("encodeRef/decodeRef round-trips an email through client_reference_id-safe chars", () => {
  const email = "creator+tag@example.co.uk";
  const ref = encodeRef(email);
  assert.match(ref, /^[A-Za-z0-9_-]+$/); // no @, ., +, /, =
  assert.equal(decodeRef(ref), email);
});

test("constructStripeEvent accepts a correctly-signed body and rejects a tampered one", async () => {
  const secret = "whsec_test";
  const { payload, header } = await signedEvent(secret, { type: "ping", id: "evt_1" });
  const event = await constructStripeEvent(payload, header, secret);
  assert.equal(event.type, "ping");

  await assert.rejects(() => constructStripeEvent(payload + " ", header, secret), /Signature verification failed/);
  await assert.rejects(() => constructStripeEvent(payload, "t=1,v1=deadbeef", secret), /timestamp outside tolerance/);
});

test("webhook activates the plan for the right account on checkout.session.completed", async () => {
  const secret = "whsec_test";
  const kv = mockKV({ "user:buyer@example.test": JSON.stringify({ email: "buyer@example.test", trialSecondsUsed: 0 }) });
  const { payload, header } = await signedEvent(secret, {
    type: "checkout.session.completed",
    data: { object: {
      client_reference_id: encodeRef("buyer@example.test"),
      metadata: { email: "buyer@example.test", plan: "premium" },
      customer: "cus_123",
      subscription: "sub_123",
    } },
  });
  const res = await webhookPost({
    request: new Request("https://example.test/api/stripe-webhook", {
      method: "POST", headers: { "Stripe-Signature": header }, body: payload,
    }),
    env: { STRIPE_WEBHOOK_SECRET: secret, AUTH_KV: kv },
  });
  assert.equal(res.status, 200);
  const user = JSON.parse(kv.store.get("user:buyer@example.test"));
  assert.equal(user.plan, "premium");
  assert.equal(user.subscriptionStatus, "active");
  assert.equal(user.stripeCustomerId, "cus_123");
  // Reverse map written so later customer.subscription.* events can find the account.
  assert.equal(kv.store.get("stripecust:cus_123"), "buyer@example.test");
});

test("webhook cancels the plan on customer.subscription.deleted, matched by customer id", async () => {
  const secret = "whsec_test";
  const kv = mockKV({
    "user:buyer@example.test": JSON.stringify({ email: "buyer@example.test", plan: "premium", subscriptionStatus: "active", stripeCustomerId: "cus_123" }),
    "stripecust:cus_123": "buyer@example.test",
  });
  const { payload, header } = await signedEvent(secret, {
    type: "customer.subscription.deleted",
    data: { object: { customer: "cus_123", status: "canceled" } },
  });
  await webhookPost({
    request: new Request("https://example.test/api/stripe-webhook", {
      method: "POST", headers: { "Stripe-Signature": header }, body: payload,
    }),
    env: { STRIPE_WEBHOOK_SECRET: secret, AUTH_KV: kv },
  });
  const user = JSON.parse(kv.store.get("user:buyer@example.test"));
  assert.equal(user.subscriptionStatus, "canceled");
  assert.equal(user.plan, null);
});

test("webhook rejects an unsigned request with 400 (a spoof can't grant a plan)", async () => {
  const kv = mockKV({ "user:x@example.test": JSON.stringify({ email: "x@example.test" }) });
  const res = await webhookPost({
    request: new Request("https://example.test/api/stripe-webhook", {
      method: "POST", headers: {}, body: JSON.stringify({ type: "checkout.session.completed", data: { object: {} } }),
    }),
    env: { STRIPE_WEBHOOK_SECRET: "whsec_test", AUTH_KV: kv },
  });
  assert.equal(res.status, 400);
});

// A subscribed account meters MONTHLY against its plan quota, not the one-time trial, and is not
// blocked by the IP record (they're paying).
test("a subscribed account meters monthly and ignores an exhausted IP trial record", async () => {
  const originalFetch = globalThis.fetch;
  const modelPayload = JSON.stringify({ segments: [{
    text: "Hello world.", family: "feel", subject: null, categoryClaim: null,
    query: "greeting", reason: "greeting", visualMode: "stock", visualQueries: ["greeting"],
    eraHint: null, visualGoal: null, coverageMode: "new", visualId: "v0", visualRef: null,
    continuityReason: null, noneKind: null,
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
    // IP trial fully spent — a free user would be blocked, but a subscriber isn't.
    await kv.put(await ipTrialKey(req, testEnv), "9999");
    const user = { email: "sub@example.test", plan: "premium", subscriptionStatus: "active" };
    const res = await segmentPost({ request: req, env: testEnv, data: { user } });
    const data = JSON.parse(await res.text());
    assert.equal(data.error, undefined, data.error);
    // Consumed against the monthly key, not the trial/IP records.
    assert.equal(kv.store.get(monthlyUsageKey("sub@example.test")), "1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a subscribed account is refused once its monthly plan quota is exhausted", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("model must not be called"); };
  try {
    const kv = mockKV();
    const user = { email: "sub@example.test", plan: "starter", subscriptionStatus: "active" };
    await kv.put(monthlyUsageKey("sub@example.test"), String(PLAN_SECONDS.starter));
    const res = await segmentPost({
      request: new Request("https://example.test/api/segment", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ script: "Hello world." }),
      }),
      env: { ANTHROPIC_API_KEY: "test-only", AUTH_KV: kv, SESSION_SECRET: "test-secret" },
      data: { user },
    });
    assert.equal(res.status, 402);
    const data = await res.json();
    assert.match(data.error, /resets on the 1st/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("isSubscribed only counts an active status with a known plan", () => {
  assert.equal(isSubscribed({ plan: "premium", subscriptionStatus: "active" }), true);
  assert.equal(isSubscribed({ plan: "premium", subscriptionStatus: "canceled" }), false);
  assert.equal(isSubscribed({ plan: "bogus", subscriptionStatus: "active" }), false);
  assert.equal(isSubscribed(null), false);
});
