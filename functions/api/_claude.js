// Shared Anthropic (Claude) chat helper. Underscore prefix excludes this from Cloudflare Pages'
// routing (import-only), same convention as _groq.js. Mirrors _groq.js's fetch+retry shape, but
// the Anthropic Messages API is a genuinely different shape from Groq's OpenAI-compatible one:
// system prompt is a top-level "system" field (not a system-role message), token cap is
// "max_tokens" (not "max_completion_tokens"), there's no "response_format: json_object" mode, and
// a successful response's text lives at content[0].text (not choices[0].message.content). Callers
// still ask for strict JSON via the prompt itself (same "Return strict JSON only, no prose, no
// markdown fences" instruction already used for Groq) and should run extractJson() on the result
// before JSON.parse, since Claude occasionally wraps output in a ```json fence despite that
// instruction.
//
// Cost note (2026-07-18): this project is on a small, real, billed Anthropic balance (not a free
// tier like Groq) — deliberately scoped to segmentation and evidence-search's intent extraction
// only, the two highest-value reasoning call sites, not a wholesale Groq replacement. No
// automatic retry-on-malformed-JSON here (unlike _groq.js's json_validate_failed handling) since
// each retry is a real cost on a tight budget — a parse failure surfaces as an error instead of
// silently re-spending.
const RETRY_STATUS = new Set([429, 500, 502, 503, 529]); // 529 = Anthropic's "overloaded"

// Same reasoning as _groq.js's MAX_WAIT_MS: a 429's meaning varies (brief per-minute burst vs a
// harder quota wall), so cap how long this will ever wait rather than trusting Retry-After blind.
const MAX_WAIT_MS = 2000;

// No "temperature" param — confirmed live, claude-sonnet-5 rejects it outright
// ("`temperature` is deprecated for this model"), unlike Groq/older Claude models where it's a
// normal sampling knob. Not made conditional/model-specific here since every current call site
// uses claude-sonnet-5 — revisit if a call site ever needs a different model that DOES support it.
export async function claudeChat(env, { model, system, messages, max_tokens }, maxRetries = 2) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, system, messages, max_tokens }),
    });
    if (res.ok) return res;
    if (attempt >= maxRetries) return res;

    if (RETRY_STATUS.has(res.status)) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 400 * 2 ** attempt + Math.random() * 200;
      if (waitMs > MAX_WAIT_MS) return res; // not a brief burst — fail now, don't spend a wait on it
      await sleep(waitMs);
      continue;
    }

    return res;
  }
}

// Claude is instructed to return raw JSON with no markdown fences, but strips this defensively
// anyway — occasionally wraps output in ```json ... ``` despite the instruction. Grabs the
// fenced body if present, otherwise returns the text unchanged for JSON.parse to handle (and
// fail loudly on, if it's actually malformed rather than just fenced).
export function extractJson(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text || "");
  return (fenced ? fenced[1] : text || "").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
