// Pages Functions middleware — runs before EVERY /api/* handler. This is the actual enforcement
// point for "signed in users only": the frontend redirects to login.html for UX, but nothing
// client-side is trusted — every paid/quota-spending endpoint (segment, evidence-search,
// reference-search, stock-search*, transcribe, stock-download) refuses here without a valid
// signed session cookie. /api/auth is the one exemption (it's how you GET a session).
//
// The verified user record is attached to context.data.user so downstream handlers (segment.js's
// trial accounting) don't re-verify or re-fetch it.
import { getSessionUser } from "./_auth.js";

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (url.pathname === "/api/auth") return context.next();

  // If auth infrastructure isn't configured (e.g. a preview deployment without the KV binding or
  // secret), fail closed with a clear message rather than silently open.
  if (!env.AUTH_KV || !env.SESSION_SECRET) {
    return Response.json({ error: "Auth is not configured on this deployment" }, { status: 500 });
  }

  const user = await getSessionUser(request, env);
  if (!user) {
    return Response.json({ error: "Sign in to use ClipHunt" }, { status: 401 });
  }

  context.data.user = user;
  return context.next();
}
