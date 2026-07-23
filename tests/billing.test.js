import test from "node:test";
import assert from "node:assert/strict";
import { onRequestPost } from "../functions/api/billing.js";

function ctx(body, env = {}, user = { email: "buyer@example.test" }) {
  return {
    request: new Request("https://example.test/api/billing", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }),
    env,
    data: { user },
  };
}

test("billing returns an honest 501 while Stripe isn't connected", async () => {
  const res = await onRequestPost(ctx({ plan: "starter" }));
  assert.equal(res.status, 501);
  const data = await res.json();
  assert.match(data.error, /isn't connected yet/);
});

test("billing rejects an unknown plan", async () => {
  const res = await onRequestPost(ctx({ plan: "enterprise" }));
  assert.equal(res.status, 400);
});

test("billing returns the payment link with the signed-in email prefilled once connected", async () => {
  const res = await onRequestPost(ctx(
    { plan: "premium" },
    { STRIPE_PAYMENT_LINK_PREMIUM: "https://buy.stripe.com/test_abc123" },
  ));
  assert.equal(res.status, 200);
  const data = await res.json();
  const url = new URL(data.url);
  assert.equal(url.origin + url.pathname, "https://buy.stripe.com/test_abc123");
  assert.equal(url.searchParams.get("prefilled_email"), "buyer@example.test");
});
