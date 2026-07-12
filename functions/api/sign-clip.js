// Cloudflare Pages Function — POST /api/sign-clip
// Mints a signed worker `/clip?mode=excerpt` URL for a USER-CHOSEN [start,end] range, so the
// browser can trim ANY candidate (rescues generic/no-quote beats and failed matches that
// otherwise only offer the full video).
//
// CRITICAL — HMAC parity: the signature must equal worker/lib/sign.js `signClip` byte-for-byte
// or the worker's /clip rejects it. That signs `${videoId}|${start}|${end}|${mode}|${exp}` and
// /clip re-verifies using the EXACT string forms of each query param. So we sign the same 2-decimal
// start/end strings we place in the query, mode "excerpt", exp as integer seconds. WORKER_TOKEN
// never reaches the browser.
const MAX_EXCERPT_SEC = 60; // mirror the worker's MAX_EXCERPT_SEC

export async function onRequestPost(context) {
  const { request, env } = context;

  let videoId, start, end;
  try {
    ({ videoId, start, end } = await request.json());
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!videoId || typeof videoId !== "string") {
    return Response.json({ error: "videoId required" }, { status: 400 });
  }
  const s0 = Number(start);
  const e0 = Number(end);
  if (!Number.isFinite(s0) || !Number.isFinite(e0) || s0 < 0) {
    return Response.json({ error: "Invalid start/end" }, { status: 400 });
  }
  const len = e0 - s0;
  if (!(len > 0) || len > MAX_EXCERPT_SEC) {
    return Response.json({ error: `Range must be greater than 0 and at most ${MAX_EXCERPT_SEC}s` }, { status: 400 });
  }
  if (!env.WORKER_TOKEN) {
    return Response.json({ error: "WORKER_TOKEN is not set on this Cloudflare project" }, { status: 500 });
  }
  if (!env.WORKER_URL) {
    return Response.json({ error: "WORKER_URL is not set on this Cloudflare project" }, { status: 500 });
  }

  // Exact forms the worker signs/verifies: 2-decimal start/end, mode "excerpt", integer-second exp.
  const s = s0.toFixed(2);
  const e = e0.toFixed(2);
  const mode = "excerpt";
  const exp = Math.floor(Date.now() / 1000) + 3600; // link valid 1h, matching /match's clipExp
  const payload = `${videoId}|${s}|${e}|${mode}|${exp}`;
  const sig = await hmacHex(payload, env.WORKER_TOKEN);

  const base = (env.WORKER_URL || "").trim().replace(/\/$/, "");
  const qs = new URLSearchParams({ videoId, start: s, end: e, mode, exp: String(exp), sig });
  return Response.json({ clipUrl: `${base}/clip?${qs.toString()}` });
}

// HMAC-SHA256 hex — byte-identical to the worker's Node `crypto.createHmac(...).digest("hex")`.
async function hmacHex(payload, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
