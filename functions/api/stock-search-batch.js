// Cloudflare Pages Function — POST /api/stock-search-batch
// Batched sibling of stock-search.js, used only by app.js's hydrateClips() auto-hydrate path.
//
// hydrateClips() used to call /api/stock-search once PER "feel" segment, all fired at once via
// Promise.all — a script with 10-15 feel segments meant 10-15 concurrent Groq rerank calls on
// EVERY workspace load (including reloads of the same unchanged project), bursting past Groq's
// per-minute rate limit and surfacing as crashes/failures in the UI. That's a burst problem, not
// a volume problem — see rerankStockCandidatesBatch()'s header comment in stock-search.js.
//
// Fix here has two parts: (1) Pexels searches still run per-segment (each needs its own query)
// but through a small worker pool instead of all-at-once, so this doesn't hammer Pexels either;
// (2) every segment's candidates get reranked in ONE combined Groq call instead of one each.
import { mapPexelsVideo, rerankStockCandidatesBatch } from "./stock-search.js";

// Caps concurrent Pexels requests. The Groq burst was the actual crash cause (see above), but
// this is cheap insurance against doing the same thing to Pexels now that its own calls are the
// only part of this pipeline still firing per-segment.
const PEXELS_CONCURRENCY = 4;

export async function onRequestPost(context) {
  const { request, env } = context;

  let segments;
  try {
    ({ segments } = await request.json());
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(segments) || !segments.length) {
    return Response.json({ error: "No segments provided" }, { status: 400 });
  }
  if (!env.PEXELS_API_KEY) {
    return Response.json({ error: "PEXELS_API_KEY is not set on this Cloudflare project" }, { status: 500 });
  }

  const queries = segments.map((seg) => (seg.query || seg.segmentText || "").trim());
  const clipsByIndex = new Array(segments.length).fill(null);

  let cursor = 0;
  async function worker() {
    while (cursor < segments.length) {
      const i = cursor++;
      const query = queries[i];
      if (!query) { clipsByIndex[i] = []; continue; }
      try {
        const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=10&orientation=landscape`;
        const res = await fetch(url, { headers: { Authorization: env.PEXELS_API_KEY } });
        if (!res.ok) { clipsByIndex[i] = []; continue; }
        const data = await res.json();
        clipsByIndex[i] = (data.videos || []).map((v) => mapPexelsVideo(v)).filter((c) => c && c.downloadUrl);
      } catch {
        clipsByIndex[i] = [];
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PEXELS_CONCURRENCY, segments.length) }, worker));

  const items = segments.map((seg, i) => ({
    i,
    segmentText: seg.segmentText || queries[i],
    context: seg.context || null,
    query: queries[i],
    clips: clipsByIndex[i] || [],
  }));

  const ranked = await rerankStockCandidatesBatch(items, env);

  return Response.json({ results: ranked.map((clips, i) => ({ i, clips })) });
}
