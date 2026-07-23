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
// image_type=photo is Google's OWN filter, applied server-side before results ever reach here —
// confirmed live it's not reliable: a short-form-video platform's video frame gets indexed by
// Google Images as an "image" result same as any real photo, with nothing in the response
// distinguishing the two. Being IN the images_results array does not mean it's actually a
// photograph. TikTok is blocked outright — it's exclusively short-form video, so a result from it
// here is never a real standalone photo, no exceptions to weigh. Other platforms that are
// overwhelmingly video (Reels/Shorts) but do have genuine photo posts too (Instagram, Facebook)
// are deliberately left unblocked rather than guessed at from a domain alone — a title/domain
// pattern can't reliably tell a real photo post from a video thumbnail on those.
const VIDEO_PLATFORM_RE = /tiktok\.com|youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|twitch\.tv/i;
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
      .filter((r) => !VIDEO_PLATFORM_RE.test(r.link) && !VIDEO_PLATFORM_RE.test(r.source || ""))
      .filter((r) => !GIF_RE.test(r.original || ""))
      .slice(0, MAX_IMAGES)
      .map((r, i) => ({
        // Google Images results carry no natural stable identifier the way a YouTube videoId or
        // Pexels id does — a request-scoped index, same as this app's other from-scratch id
        // (evidence-search.js's rerankCandidates). Lets evidence-search.js's own rerank pass
        // (the actual relevance/medium judgment — this file only does cheap mechanical
        // pre-filtering) track scores back to candidates.
        id: `photo-${i}`,
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

const MAX_ARTICLES = 6;

// Deliberately narrow (see evidence-search.js's mediaType:"article" prompt guidance) — reserved
// for a claim that's ABOUT press/media narrative itself (what was reported, what a nickname was,
// what pundits said), not a fourth default source searched on every claim. Plain Google web
// search (not google_news) — a news-vertical search is recency-biased and unreliable for older
// stories a claim might reference from years or decades back; a real archived article/blog post
// about an old story is still a normal organic web result.
export async function searchNewsArticles(env, query) {
  if (!env.SERPAPI_KEY || !query || !query.trim()) return [];
  try {
    const url =
      `https://serpapi.com/search.json?engine=google&safe=active` +
      `&q=${encodeURIComponent(query.trim())}&api_key=${env.SERPAPI_KEY}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`[serpapi] article HTTP ${res.status} for query=${JSON.stringify(query)}`);
      return [];
    }
    const data = await res.json();
    const raw = Array.isArray(data.organic_results) ? data.organic_results : [];
    const articles = raw
      .filter((r) => r.title && r.link)
      .filter((r) => !BLOCKED_DOMAIN_RE.test(r.link) && !BLOCKED_DOMAIN_RE.test(r.source || r.displayed_link || ""))
      .filter((r) => !VIDEO_PLATFORM_RE.test(r.link) && !VIDEO_PLATFORM_RE.test(r.source || r.displayed_link || ""))
      .slice(0, MAX_ARTICLES)
      .map((r, i) => ({
        // Same request-scoped id pattern as searchGoogleImages — organic web results carry no
        // natural stable identifier either.
        id: `article-${i}`,
        title: r.title || "",
        snippet: r.snippet || "",
        domain: r.source || r.displayed_link || "",
        // Articles are link-only same as everything else in this app — no scraping/redistributing
        // the actual page content, just a title/snippet (already public search-result metadata)
        // and a link out to the real source.
        pageUrl: r.link,
      }));
    console.log(
      `[serpapi] article query=${JSON.stringify(query)} raw=${raw.length} kept=${articles.length}`
    );
    return articles;
  } catch (err) {
    console.log(`[serpapi] article search failed: ${err.message}`);
    return [];
  }
}
