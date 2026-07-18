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
//
// "thinking"/"effort" — two wrong shapes tried and rejected live before landing here (each one a
// real billed call, not free to get wrong): first `thinking:{type:"adaptive",effort:"low"}`
// ("Extra inputs are not permitted" — effort isn't nested inside thinking), then a bare top-level
// `effort:"low"` ("Extra inputs are not permitted" again — not top-level either). The actual
// Messages API reference (the parameter-by-parameter endpoint schema, not a conceptual guide
// page — that distinction is exactly what went wrong the first two times) puts it inside
// "output_config": `{ output_config: { effort: "low" } }`. "thinking" stays a separate top-level
// field — GET /v1/models' capability listing for claude-sonnet-5 confirms only
// `"types":{"adaptive"}` is valid here (not "enabled", so it can't be set to "disabled").
// Requesting "low" effort explicitly rather than leaving it to the model, since thinking tokens
// are real billed spend on a small account — this is a cost control, not just a reliability fix.
// Callers must still budget max_tokens generously enough that low-effort thinking PLUS the
// actual answer both fit — see call-site comments for specific values.
export async function claudeChat(env, { model, system, messages, max_tokens }, maxRetries = 2) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model, system, messages, max_tokens,
        thinking: { type: "adaptive" },
        output_config: { effort: "low" },
      }),
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

// Confirmed live: a successful response's actual JSON answer isn't reliably content[0] — a
// reasoning-capable model like claude-sonnet-5 can put a non-"text" block (e.g. "thinking")
// first, and content[0].text is then undefined. Blindly reading content[0].text let that fail
// SILENTLY: undefined -> extractJson("") -> "" -> the "{}" fallback at each call site -> valid
// but EMPTY parsed JSON -> "Model did not return a segments array", with no hint that the real
// text was sitting a block or two later. Find the actual text block by type instead of position.
// Throws (rather than returning undefined) so a genuinely textless response fails loudly with a
// clear message, instead of silently degrading into that same confusing downstream error.
export function extractText(data) {
  const block = (data.content || []).find((b) => b.type === "text");
  if (!block) throw new Error(`No text content block in Claude response (got: ${(data.content || []).map((b) => b.type).join(", ") || "none"})`);
  return block.text;
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
