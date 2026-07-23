// Pages Functions middleware — runs before EVERY /api/* handler. Since guest access (2026-07-23),
// this no longer blocks anonymous requests: it RESOLVES identity. A valid session cookie attaches
// the full user record to context.data.user; no session attaches null, and the request proceeds
// as a guest. Spend control lives where the spend happens — segment.js meters both guests (by
// IP-hash record) and accounts (by max(account, IP)); see _auth.js for the budget model.
// /api/auth is exempt (it's how sessions are created), and billing.js does its own user check
// (a subscription needs an account to attach to).
import { getSessionUser } from "./_auth.js";

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (url.pathname === "/api/auth") return context.next();

  // If auth infrastructure isn't configured (e.g. a preview deployment without the KV binding or
  // secret), fail closed with a clear message rather than silently open — the trial metering
  // depends on it.
  if (!env.AUTH_KV || !env.SESSION_SECRET) {
    return Response.json({ error: "Auth is not configured on this deployment" }, { status: 500 });
  }

  context.data.user = await getSessionUser(request, env);
  return context.next();
}
