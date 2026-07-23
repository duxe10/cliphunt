// Minimal Stripe REST helper — plain fetch, no SDK (the Node Stripe SDK doesn't run on Cloudflare
// Workers, and we only need two calls). Uses the STANDARD secret key (STRIPE_SECRET_KEY), which
// has full API access by default — no restricted-key permission selection to fiddle with.
//
// Two responsibilities: (1) create subscription Checkout Sessions server-side (billing.js) so the
// account, plan, and email are locked into the session and flow reliably into the webhook; (2)
// verify incoming webhook signatures (stripe-webhook.js) with the webhook signing secret. All
// WebCrypto, all form-encoded, matching the dependency-free style of the rest of this codebase.

const enc = new TextEncoder();

// Stripe's API is form-encoded with PHP-style nested keys: metadata[email]=x,
// line_items[0][price]=y. This encodes nested objects/arrays into that shape.
export function stripeFormEncode(obj, prefix = "") {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") {
      const nested = stripeFormEncode(v, key);
      if (nested) parts.push(nested);
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
    }
  }
  return parts.join("&");
}

export async function stripeRequest(env, method, path, params) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params ? stripeFormEncode(params) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Stripe error ${res.status}`);
  return data;
}

// Verifies a Stripe webhook's `Stripe-Signature` header against the raw request body. Returns the
// parsed event on success, throws on any failure (bad signature, stale timestamp, malformed
// header) — the caller returns 400 so Stripe retries. Implements Stripe's documented scheme:
// signed_payload = `${t}.${rawBody}`, expected = hex(HMAC-SHA256(signed_payload, secret)), compared
// constant-time against the v1 signature, with a 5-minute timestamp tolerance for replay defence.
export async function constructStripeEvent(rawBody, sigHeader, secret) {
  if (!sigHeader) throw new Error("Missing Stripe-Signature header");
  const parts = Object.fromEntries(
    sigHeader.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i), p.slice(i + 1)];
    })
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) throw new Error("Malformed Stripe-Signature header");

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(t));
  if (!Number.isFinite(age) || age > 300) throw new Error("Stripe signature timestamp outside tolerance");

  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${rawBody}`));
  const expected = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");

  if (expected.length !== v1.length) throw new Error("Signature length mismatch");
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  if (diff !== 0) throw new Error("Signature verification failed");

  return JSON.parse(rawBody);
}

// client_reference_id must be alphanumeric + - _ only (no @ or .), so the account email is
// base64url-encoded into it and decoded back in the webhook. This is the reliable account link —
// independent of whatever email the customer types on the Stripe page.
export function encodeRef(email) {
  return btoa(email).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function decodeRef(ref) {
  try {
    return atob(String(ref || "").replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
}
