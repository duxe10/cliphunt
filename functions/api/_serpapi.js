// Shared SerpAPI (Google Images) helper — underscore prefix keeps it out of Pages routing,
// import-only, same convention as _groq.js/_claude.js.
//
// Free plan: 250 searches/month, no card — every evidence "Find footage" click spends one, so
// this is the first quota to watch if real users show up (identical searches within an hour hit
// SerpAPI's cache and are free). Upgrade path is $25/mo for 1,000. Key lives in the SERPAPI_KEY
// Cloudflare Pages secret (redeploy after setting it, same as every other key).
//
// searchGoogleImages NEVER throws and is deliberately not key-guarded at call sites — images are
// an additive result set on top of the YouTube pipeline, so a missing key, quota exhaustion, or
// any fetch/parse failure resolves to [] rather than failing the click (same fail-open philosophy
// as reference-search.js's searchPexelsReaction).

// image_type=photo makes GOOGLE filter out animated gifs/clipart/lineart at the source;
// imgsz=l drops icons and tiny thumbnails that would render as junk in a 72px card.
const FIXED_PARAMS = "engine=google_images&image_type=photo&imgsz=l&safe=active";

// Deterministic result filters — code-level backstop behind Google's own type filter, same
// pattern as reference-search.js's JUNK_TITLE_RE. Pinterest is an aggregator (results point at
// pins, not the actual source); the stock-agency domains only ever surface watermarked preview
// images, useless to an editor.
const BLOCKED_DOMAIN_RE = /pinterest\.|gettyimages\.|alamy\.|shutterstock\.|istockphoto\.|dreamstime\.|123rf\.|depositphotos\./i;
const GIF_RE = /\.gif(\?|$)/i;

const MAX_IMAGES = 8;

export async function searchGoogleImages(env, query) {
  if (!env.SERPAPI_KEY || !query || !query.trim()) return [];
  try {
    const url =
      `https://serpapi.com/search.json?${FIXED_PARAMS}` +
      `&q=${encodeURIComponent(query.trim())}&api_key=${env.SERPAPI_KEY}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`[serpapi] HTTP ${res.status} for query=${JSON.stringify(query)}`);
      return [];
    }
    const data = await res.json();
    const raw = Array.isArray(data.images_results) ? data.images_results : [];
    const images = raw
      .filter((r) => r.thumbnail && r.link)
      .filter((r) => !BLOCKED_DOMAIN_RE.test(r.link) && !BLOCKED_DOMAIN_RE.test(r.source || ""))
      .filter((r) => !GIF_RE.test(r.original || ""))
      .slice(0, MAX_IMAGES)
      .map((r) => ({
        // thumbnail is Google-hosted (encrypted-tbn/data:) — safe to display. The full-res
        // `original` is deliberately NOT returned: displaying it would hotlink an arbitrary
        // site's copyrighted image, the exact thing the link-only rule exists to avoid. The
        // card links out to the source PAGE instead.
        thumb: r.thumbnail,
        pageUrl: r.link,
        title: r.title || "",
        domain: r.source || "",
      }));
    console.log(
      `[serpapi] query=${JSON.stringify(query)} raw=${raw.length} kept=${images.length}`
    );
    return images;
  } catch (err) {
    console.log(`[serpapi] failed: ${err.message}`);
    return [];
  }
}
