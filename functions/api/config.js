// Cloudflare Pages Function — GET /api/config
// Exposes non-secret runtime config to the browser so WORKER_URL isn't hardcoded in app.js.
// WORKER_URL is a public endpoint, not a secret — the worker is guarded by HMAC signatures.
export function onRequestGet(context) {
  return Response.json({ workerUrl: context.env.WORKER_URL || null });
}
