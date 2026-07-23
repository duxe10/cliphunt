// Cloudflare Pages Function — POST /api/billing
// Starts a subscription checkout for the signed-in account. Two paths, best first:
//
//   1. FULL API (preferred): if STRIPE_SECRET_KEY + STRIPE_PRICE_STARTER/_PREMIUM are set, create
//      a Checkout Session server-side (mode: subscription). The account email is locked into the
//      session as client_reference_id + metadata, so the webhook (stripe-webhook.js) attaches the
//      subscription to the right account with certainty. This is the robust path — full control of
//      success/cancel URLs and reliable account linkage.
//   2. PAYMENT LINK fallback: if only STRIPE_PAYMENT_LINK_* are set, redirect to the pre-built
//      link with the account ref appended so the webhook can still match. Keeps checkout working
//      before the secret key is added.
//   3. Neither: honest 501.
//
// A subscription needs an account to attach to, so this endpoint requires a signed-in user (the
// middleware allows guests through generally, since 2026-07-23, so this checks for itself).
import { stripeRequest, encodeRef } from "./_stripe.js";

const PLANS = {
  starter: { name: "Starter", priceEnv: "STRIPE_PRICE_STARTER", linkEnv: "STRIPE_PAYMENT_LINK_STARTER" },
  premium: { name: "Premium", priceEnv: "STRIPE_PRICE_PREMIUM", linkEnv: "STRIPE_PAYMENT_LINK_PREMIUM" },
};

export async function onRequestPost(context) {
  const { request, env } = context;

  const user = context.data && context.data.user;
  if (!user) {
    return Response.json({ error: "Create a free account first — your subscription needs an account to attach to." }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const plan = PLANS[body.plan];
  if (!plan) return Response.json({ error: "Unknown plan" }, { status: 400 });

  if (user.plan === body.plan && user.subscriptionStatus === "active") {
    return Response.json({ error: `You're already on the ${plan.name} plan.` }, { status: 409 });
  }

  const origin = new URL(request.url).origin;
  const ref = encodeRef(user.email);

  // Path 1 — full Checkout Session API.
  if (env.STRIPE_SECRET_KEY && env[plan.priceEnv]) {
    try {
      const session = await stripeRequest(env, "POST", "/checkout/sessions", {
        mode: "subscription",
        "line_items": [{ price: env[plan.priceEnv], quantity: 1 }],
        client_reference_id: ref,
        customer_email: user.email,
        metadata: { email: user.email, plan: body.plan },
        subscription_data: { metadata: { email: user.email, plan: body.plan } },
        success_url: `${origin}/index.html?upgraded=1`,
        cancel_url: `${origin}/pricing.html`,
        allow_promotion_codes: "true",
      });
      return Response.json({ url: session.url });
    } catch (err) {
      console.log(`[billing] checkout session failed: ${err.message}`);
      return Response.json({ error: "Couldn't start checkout right now — please try again." }, { status: 502 });
    }
  }

  // Path 2 — pre-built Payment Link, with account ref + email so the webhook can still match.
  const link = env[plan.linkEnv];
  if (link) {
    const url = new URL(link);
    url.searchParams.set("client_reference_id", ref);
    url.searchParams.set("prefilled_email", user.email);
    return Response.json({ url: url.toString() });
  }

  // Path 3 — nothing configured yet.
  return Response.json({
    error: `Checkout for ${plan.name} isn't connected yet — payments are coming very soon. Get in touch and we'll set you up directly.`,
  }, { status: 501 });
}
