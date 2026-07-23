// Cloudflare Pages Function — POST /api/auth
// Single endpoint, action-dispatched: {action: "signup"|"login"|"logout"|"me"}. Exempted from the
// session gate in _middleware.js (it IS the way you get a session). See _auth.js for the model.
import {
  hashPassword, verifyPassword, signSession, sessionCookieHeader, clearSessionCookieHeader,
  getSessionUser, ipTrialKey, TRIAL_SECONDS_MAX, TRIAL_SECONDS_MAX_ACCOUNT,
  isSubscribed, PLAN_SECONDS, monthlyUsageKey,
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
    // Trial remaining reflects BOTH the account counter and the network-level record, so the UI
    // never promises budget the segment endpoint would then refuse. Guests get a 200 with their
    // own (IP-tracked, smaller) budget — the app is usable without an account.
    const ipKey = await ipTrialKey(request, env);
    const ipUsed = Number(await env.AUTH_KV.get(ipKey)) || 0;
    if (!user) {
      return Response.json({
        anonymous: true,
        trialSecondsUsed: Math.min(ipUsed, TRIAL_SECONDS_MAX),
        trialSecondsMax: TRIAL_SECONDS_MAX,
      });
    }
    // Subscribed accounts report their monthly plan quota instead of the trial.
    if (isSubscribed(user)) {
      const cap = PLAN_SECONDS[user.plan];
      const monthUsed = Number(await env.AUTH_KV.get(monthlyUsageKey(user.email))) || 0;
      return Response.json({
        email: user.email,
        plan: user.plan,
        subscriptionStatus: user.subscriptionStatus,
        planSecondsUsed: Math.min(monthUsed, cap),
        planSecondsMax: cap,
      });
    }
    const used = Math.max(user.trialSecondsUsed || 0, ipUsed);
    return Response.json({
      email: user.email,
      plan: user.plan || null,
      subscriptionStatus: user.subscriptionStatus || null,
      trialSecondsUsed: Math.min(used, TRIAL_SECONDS_MAX_ACCOUNT),
      trialSecondsMax: TRIAL_SECONDS_MAX_ACCOUNT,
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
    // Report the IP-aware number from the very first response — a fresh account on a network
    // that already consumed trial time inherits it (see _auth.js), and the signup response
    // shouldn't promise budget that "me"/segment would then contradict a second later.
    const ipKey = await ipTrialKey(request, env);
    const ipUsed = Number(await env.AUTH_KV.get(ipKey)) || 0;
    return new Response(JSON.stringify({
      email,
      trialSecondsUsed: Math.min(ipUsed, TRIAL_SECONDS_MAX_ACCOUNT),
      trialSecondsMax: TRIAL_SECONDS_MAX_ACCOUNT,
    }), {
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
      trialSecondsUsed: Math.min(used, TRIAL_SECONDS_MAX_ACCOUNT),
      trialSecondsMax: TRIAL_SECONDS_MAX_ACCOUNT,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Set-Cookie": sessionCookieHeader(token) },
    });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
}
