// Cloudflare Pages Function — POST /api/auth
// Single endpoint, action-dispatched: {action: "signup"|"login"|"logout"|"me"}. Exempted from the
// session gate in _middleware.js (it IS the way you get a session). See _auth.js for the model.
import {
  hashPassword, verifyPassword, signSession, sessionCookieHeader, clearSessionCookieHeader,
  getSessionUser, ipTrialKey, TRIAL_SECONDS_MAX,
} from "./_auth.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.AUTH_KV || !env.SESSION_SECRET) {
    return Response.json({ error: "Auth is not configured on this deployment" }, { status: 500 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const action = body.action;

  if (action === "me") {
    const user = await getSessionUser(request, env);
    if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
    // Trial remaining reflects BOTH the account counter and the network-level record, so the UI
    // never promises budget the segment endpoint would then refuse.
    const ipKey = await ipTrialKey(request, env);
    const ipUsed = Number(await env.AUTH_KV.get(ipKey)) || 0;
    const used = Math.max(user.trialSecondsUsed || 0, ipUsed);
    return Response.json({
      email: user.email,
      trialSecondsUsed: Math.min(used, TRIAL_SECONDS_MAX),
      trialSecondsMax: TRIAL_SECONDS_MAX,
    });
  }

  if (action === "logout") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Set-Cookie": clearSessionCookieHeader() },
    });
  }

  const email = String(body.email || "").trim();
  const password = String(body.password || "");

  if (action === "signup") {
    if (!EMAIL_RE.test(email)) return Response.json({ error: "Enter a valid email address" }, { status: 400 });
    if (password.length < 8) return Response.json({ error: "Password must be at least 8 characters" }, { status: 400 });

    const key = `user:${email.toLowerCase()}`;
    if (await env.AUTH_KV.get(key)) {
      return Response.json({ error: "An account with this email already exists — sign in instead" }, { status: 409 });
    }

    const { hash, salt } = await hashPassword(password);
    const user = { email, passHash: hash, salt, createdAt: Date.now(), trialSecondsUsed: 0 };
    await env.AUTH_KV.put(key, JSON.stringify(user));

    const token = await signSession(env, email);
    return new Response(JSON.stringify({ email, trialSecondsUsed: 0, trialSecondsMax: TRIAL_SECONDS_MAX }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Set-Cookie": sessionCookieHeader(token) },
    });
  }

  if (action === "login") {
    const key = `user:${email.toLowerCase()}`;
    const raw = await env.AUTH_KV.get(key);
    // Same error for unknown email and wrong password — doesn't leak which emails have accounts.
    const fail = () => Response.json({ error: "Email or password is incorrect" }, { status: 401 });
    if (!raw) return fail();
    let user;
    try { user = JSON.parse(raw); } catch { return fail(); }
    if (!(await verifyPassword(password, user.salt, user.passHash))) return fail();

    const token = await signSession(env, user.email);
    const ipKey = await ipTrialKey(request, env);
    const ipUsed = Number(await env.AUTH_KV.get(ipKey)) || 0;
    const used = Math.max(user.trialSecondsUsed || 0, ipUsed);
    return new Response(JSON.stringify({
      email: user.email,
      trialSecondsUsed: Math.min(used, TRIAL_SECONDS_MAX),
      trialSecondsMax: TRIAL_SECONDS_MAX,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Set-Cookie": sessionCookieHeader(token) },
    });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
}
