// Cloudflare Pages Function — POST /api/billing
// Stripe-ready checkout stub. The chosen integration shape (from Stripe's own "design an
// integration" matrix): flat-rate pricing, Payment Link checkout, pay up front — the zero-backend
// path. Connecting the real Stripe account later is a two-step, ZERO-code-change operation:
//   1. In the Stripe dashboard, create the two subscription Payment Links
//      (Starter $19/mo, Premium $32.99/mo).
//   2. `npx wrangler pages secret put STRIPE_PAYMENT_LINK_STARTER` (paste the link), same for
//      STRIPE_PAYMENT_LINK_PREMIUM, then redeploy.
// Until those secrets exist, this returns 501 with an honest message and the pricing page shows
// a "not connected yet" note instead of a dead checkout.
//
// Session-gated by _middleware.js like everything else — you must be signed in to upgrade, which
// is also what lets a webhook later attach the subscription to the right account (the signed-in
// email can be passed as the Payment Link's client_reference_id/prefilled_email when connected).
const PLANS = {
  starter: { name: "Starter", priceLabel: "$19/month", env: "STRIPE_PAYMENT_LINK_STARTER" },
  premium: { name: "Premium", priceLabel: "$32.99/month", env: "STRIPE_PAYMENT_LINK_PREMIUM" },
};

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const plan = PLANS[body.plan];
  if (!plan) {
    return Response.json({ error: "Unknown plan" }, { status: 400 });
  }

  const link = env[plan.env];
  if (!link) {
    return Response.json({
      error: `Checkout for ${plan.name} isn't connected yet — payments are coming very soon. Get in touch and we'll set you up directly.`,
    }, { status: 501 });
  }

  // Prefill the customer's email on the Stripe-hosted page so the subscription lands attached to
  // the account they're signed in as.
  const user = context.data && context.data.user;
  const url = new URL(link);
  if (user && user.email) url.searchParams.set("prefilled_email", user.email);
  return Response.json({ url: url.toString() });
}
