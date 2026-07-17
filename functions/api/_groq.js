// Shared Groq chat-completion helper. Underscore prefix excludes this from Cloudflare Pages'
// routing (import-only, same convention as _middleware.js), matching how stock-search.js already
// gets imported by evidence-search.js/reference-search.js.
//
// Every call site here used to hit fetch() directly and treat a 429 as a hard failure. That was
// fine when calls were click-paced, but stock-search-batch.js's hydration burst (see its header
// comment) made 429s a routine occurrence, not an edge case — so a short bounded retry belongs
// at the transport layer, once, rather than copy-pasted into every call site.
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export async function groqChat(env, { model, messages, temperature = 0.2, response_format = { type: "json_object" } }, maxRetries = 2) {
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, temperature, response_format }),
    });
    if (res.ok || !RETRY_STATUS.has(res.status) || attempt >= maxRetries) return res;
    // Groq sends Retry-After on 429s — honor it when present instead of guessing.
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 400 * 2 ** attempt + Math.random() * 200);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
