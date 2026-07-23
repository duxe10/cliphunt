// Cloudflare Pages Function — POST /api/stripe-webhook
// The piece that makes subscriptions AUTOMATIC: Stripe calls this on every subscription lifecycle
// event, and it flips the account's plan/status in KV with no manual step. Signature-verified with
// STRIPE_WEBHOOK_SECRET (see _stripe.js) — an unverified body is rejected 400 so a spoofed request
// can never grant a plan.
//
// Exempt from the session gate: Stripe isn't a logged-in user. _middleware.js resolves identity
// but doesn't block, and this endpoint authenticates via the signature instead. It also needs the
// RAW body for signature verification, so it reads request.text() before any parsing.
//
// Account linkage: checkout sessions carry client_reference_id = base64url(email) AND
// metadata.email (see billing.js), so the account is found with certainty. A stripecust:<id> ->
// email map is written on activation so later subscription.updated/deleted events (which only
// carry the customer id) can find the account too.
import { constructStripeEvent, decodeRef } from "./_stripe.js";
import { PLAN_SECONDS } from "./_auth.js";

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.STRIPE_WEBHOOK_SECRET || !env.AUTH_KV) {
    return Response.json({ error: "Webhook not configured" }, { status: 500 });
  }

  const raw = await request.text();
  let event;
  try {
    event = await constructStripeEvent(raw, request.headers.get("Stripe-Signature"), env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log(`[stripe-webhook] rejected: ${err.message}`);
    return Response.json({ error: `Webhook signature verification failed` }, { status: 400 });
  }

  try {
    await handleEvent(env, event);
  } catch (err) {
    // Log and 500 so Stripe retries — better a retry than a silently dropped activation.
    console.log(`[stripe-webhook] handling ${event.type} failed: ${err.message}`);
    return Response.json({ error: "Handler error" }, { status: 500 });
  }
  return Response.json({ received: true });
}

async function loadUserByEmail(env, email) {
  if (!email) return null;
  const raw = await env.AUTH_KV.get(`user:${email.toLowerCase()}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function saveUser(env, user) {
  await env.AUTH_KV.put(`user:${user.email.toLowerCase()}`, JSON.stringify(user));
}

async function handleEvent(env, event) {
  const obj = event.data && event.data.object ? event.data.object : {};

  switch (event.type) {
    case "checkout.session.completed": {
      // Activation. Prefer the base64url ref (immune to the customer editing their email on the
      // Stripe page), fall back to metadata/customer email.
      const email =
        decodeRef(obj.client_reference_id) ||
        (obj.metadata && obj.metadata.email) ||
        obj.customer_email ||
        (obj.customer_details && obj.customer_details.email);
      const plan = (obj.metadata && obj.metadata.plan) || null;
      const user = await loadUserByEmail(env, email);
      if (!user) { console.log(`[stripe-webhook] no account for ${email}`); return; }

      user.plan = PLAN_SECONDS[plan] ? plan : user.plan || "starter";
      user.subscriptionStatus = "active";
      if (obj.customer) user.stripeCustomerId = obj.customer;
      if (obj.subscription) user.stripeSubscriptionId = obj.subscription;
      await saveUser(env, user);
      if (obj.customer) await env.AUTH_KV.put(`stripecust:${obj.customer}`, user.email.toLowerCase());
      console.log(`[stripe-webhook] activated ${user.plan} for ${user.email}`);
      return;
    }

    case "customer.subscription.updated": {
      // Status changes (active/past_due/canceled) and plan swaps. Match by customer id.
      const email = obj.customer ? await env.AUTH_KV.get(`stripecust:${obj.customer}`) : null;
      const user = await loadUserByEmail(env, email);
      if (!user) return;
      user.subscriptionStatus = obj.status || user.subscriptionStatus;
      const planFromMeta = obj.metadata && obj.metadata.plan;
      if (PLAN_SECONDS[planFromMeta]) user.plan = planFromMeta;
      await saveUser(env, user);
      console.log(`[stripe-webhook] ${user.email} -> ${user.plan}/${user.subscriptionStatus}`);
      return;
    }

    case "customer.subscription.deleted": {
      const email = obj.customer ? await env.AUTH_KV.get(`stripecust:${obj.customer}`) : null;
      const user = await loadUserByEmail(env, email);
      if (!user) return;
      user.subscriptionStatus = "canceled";
      user.plan = null;
      await saveUser(env, user);
      console.log(`[stripe-webhook] canceled subscription for ${user.email}`);
      return;
    }

    default:
      // Everything else (invoices, payment intents) is acknowledged but ignored.
      return;
  }
}
