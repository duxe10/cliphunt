// Shared auth helpers — underscore prefix keeps this out of Pages routing (import-only), same
// convention as _groq.js/_claude.js/_serpapi.js. Everything here is WebCrypto only (PBKDF2 for
// passwords, HMAC-SHA256 for session cookies + IP hashing) — no dependencies, no build step,
// matching the rest of this codebase.
//
// Model:
// - Accounts live in AUTH_KV as `user:<email-lowercased>` -> JSON { email, passHash, salt,
//   createdAt, trialSecondsUsed }.
// - Sessions are STATELESS signed cookies (no KV read per request): `ch_session` =
//   base64url(payload).base64url(hmac). Payload { e: email, x: expiry-epoch-seconds }. Signed
//   with SESSION_SECRET. Tampering breaks the HMAC; expiry is inside the signed payload so it
//   can't be extended client-side.
// - One-time trial anti-abuse: consumed trial time is recorded BOTH on the account and against a
//   keyed hash of the caller's IP (`trial:<hmac(ip)>`). At spend time the check uses whichever of
//   the two is larger, so a fresh account from the same network can't reset the clock. The IP is
//   never stored raw — HMAC-keyed with SESSION_SECRET, so it can't be reversed or rainbow-tabled
//   from a KV dump.

const SESSION_COOKIE = "ch_session";
const SESSION_TTL_SEC = 60 * 60 * 24 * 30; // 30 days
const PBKDF2_ITERS = 100_000;

// 10 minutes of narration at the app's own READING_WORDS_PER_SEC estimate (2.5 wps, see app.js).
// This is the GUEST trial budget, tracked purely against the IP-hash record — the app is usable
// without an account. Creating a free account adds a real +5 minutes (the "sign up for more
// usage" nudge is honest, not hollow). Abuse math: spend is always recorded on the IP record and
// checks use max(account, IP), so no single network can ever exceed TRIAL_SECONDS_MAX_ACCOUNT in
// total, no matter how many fresh accounts or guest sessions it cycles through.
export const TRIAL_SECONDS_MAX = 600;
export const TRIAL_SECONDS_MAX_ACCOUNT = 900;
export const READING_WORDS_PER_SEC = 2.5;

const enc = new TextEncoder();

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecodeToString(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return atob(b64);
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return crypto.subtle.sign("HMAC", key, enc.encode(message));
}

export async function hashPassword(password, saltB64 = null) {
  const salt = saltB64
    ? Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0))
    : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERS, hash: "SHA-256" },
    keyMaterial, 256
  );
  return { hash: b64url(bits), salt: btoa(String.fromCharCode(...salt)) };
}

export async function verifyPassword(password, saltB64, expectedHash) {
  const { hash } = await hashPassword(password, saltB64);
  // Constant-time-ish compare — lengths are fixed (32-byte PBKDF2 output), so compare every char.
  if (hash.length !== expectedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ expectedHash.charCodeAt(i);
  return diff === 0;
}

export async function signSession(env, email) {
  const payload = JSON.stringify({ e: email, x: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC });
  const payloadB64 = b64url(enc.encode(payload));
  const sig = b64url(await hmac(env.SESSION_SECRET, payloadB64));
  return `${payloadB64}.${sig}`;
}

export async function verifySession(env, token) {
  if (!token || !env.SESSION_SECRET) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(await hmac(env.SESSION_SECRET, payloadB64));
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const payload = JSON.parse(b64urlDecodeToString(payloadB64));
    if (!payload.e || !payload.x || payload.x < Math.floor(Date.now() / 1000)) return null;
    return { email: payload.e };
  } catch {
    return null;
  }
}

export function readSessionCookie(request) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}

export function sessionCookieHeader(token) {
  // HttpOnly: JS can't read it; Secure: HTTPS only; SameSite=Lax: sent on same-origin requests
  // and top-level navigations, blocks cross-site POSTs (the CSRF vector that matters here).
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SEC}`;
}

export function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

// Resolves the logged-in user's full KV record, or null. Session cookie alone proves identity;
// the KV read gets the live trial counters (which the stateless cookie deliberately doesn't
// carry, so consuming trial time doesn't require re-issuing cookies).
export async function getSessionUser(request, env) {
  const session = await verifySession(env, readSessionCookie(request));
  if (!session) return null;
  const raw = await env.AUTH_KV.get(`user:${session.email.toLowerCase()}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Keyed hash of the caller's IP for the trial anti-abuse record — never the raw IP.
export async function ipTrialKey(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const sig = b64url(await hmac(env.SESSION_SECRET, `trial-ip:${ip}`));
  return `trial:${sig}`;
}

// Estimated spoken seconds for a script — same words-per-second model the frontend timeline uses.
export function scriptSeconds(script) {
  const words = String(script || "").trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words / READING_WORDS_PER_SEC);
}
