// Cloudflare Pages Function — POST /api/stock-search
// Pexels video search for the "stock" clip source (atmospheric/conceptual feel beats + generic
// evidence beats). Free, commercially-licensed, direct-CDN MP4s — no worker, no yt-dlp, no cost.
//
// Pexels' API schema has a "tags" field but it's empty on every real result (checked many) — not
// usable. What IS real: the "url" field's slug is a genuine short description written by Pexels
// itself (e.g. "man-shaking-his-head-13801250" -> "man shaking his head"), extracted below as
// each clip's title. That title is real signal, so it gets the same LLM-rerank treatment
// evidence-search.js already gives YouTube results — Pexels results used to be pure pass-through
// from Pexels' own search ranking with zero validation against what the beat actually needs.
export async function onRequestPost(context) {
  const { request, env } = context;

  let query, orientation, segmentText, sceneContext;
  try {
    ({ query, orientation, segmentText, context: sceneContext } = await request.json());
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!query || !query.trim()) {
    return Response.json({ error: "No query provided" }, { status: 400 });
  }
  if (!env.PEXELS_API_KEY) {
    return Response.json({ error: "PEXELS_API_KEY is not set on this Cloudflare project" }, { status: 500 });
  }

  orientation = orientation === "portrait" || orientation === "square" ? orientation : "landscape";

  let clips;
  try {
    const url =
      "https://api.pexels.com/videos/search" +
      `?query=${encodeURIComponent(query)}&per_page=10&orientation=${orientation}`;
    const res = await fetch(url, { headers: { Authorization: env.PEXELS_API_KEY } });

    if (!res.ok) {
      const errText = await res.text();
      return Response.json({ error: `Pexels error: ${errText}` }, { status: 502 });
    }

    const data = await res.json();
    clips = (data.videos || []).map((v) => mapPexelsVideo(v)).filter((c) => c && c.downloadUrl);
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }

  const ranked = await rerankStockCandidates({ segmentText: segmentText || query, context: sceneContext, query }, clips, env);
  return Response.json({ clips: ranked });
}

// Shared with evidence-search.js's generic-footage branch — keep this mapping in sync there.
export function mapPexelsVideo(v) {
  const files = (v.video_files || []).filter((f) => f.file_type === "video/mp4");
  if (!files.length) return null;

  const hdCandidates = files.filter((f) => (f.height || 0) <= 1080).sort((a, b) => (b.height || 0) - (a.height || 0));
  const best = hdCandidates.find((f) => f.quality === "hd") || hdCandidates[0] || files[0];

  const sdCandidates = files.filter((f) => f.quality === "sd").sort((a, b) => (b.height || 0) - (a.height || 0));
  const preview = sdCandidates[0] || best;

  return {
    id: `pexels-${v.id}`,
    title: slugTitle(v.url) || (v.user?.name ? `Stock footage by ${v.user.name}` : "Stock footage"),
    thumbUrl: v.image,
    duration: v.duration || null,
    author: v.user?.name || null,
    source: "pexels",
    downloadUrl: best.link,
    previewUrl: preview.link || best.link,
  };
}

// Pexels URLs look like ".../video/man-shaking-his-head-13801250/" — the slug between "/video/"
// and the trailing numeric id is a real short description. Greedy capture + backtracking finds
// the LAST hyphen-digits run as the id, so this holds even when the description itself contains
// a number (e.g. "top-10-office-desk-98765" -> "top 10 office desk").
function slugTitle(url) {
  const m = /\/video\/([a-z0-9-]+)-\d+\/?$/i.exec(url || "");
  if (!m) return null;
  const words = m[1].replace(/-/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

const STOCK_RERANK_PROMPT = `You score how well each stock-footage clip matches ONE moment of a
video script. You get the moment (and its resolved context, if given) plus a list of candidate
clips — each with a short title extracted from the clip's own listing (a real but terse
description, not a full sentence) and its duration in seconds.

Score each 0-100:
- Does the title plausibly describe footage that fits this moment? A close match ("man shaking
  his head" for a disappointment beat) scores high. A vague or off-topic title scores low.
- Titles are short auto-extracted slugs, not full descriptions — don't demand exact wording, just
  a plausible real-world visual fit. Don't punish a good match for lacking flowery detail.

Return strict JSON only, no prose: {"ranking":[{"id":"...","score":0-100,"reason":"<=8 words"}]}
Include EVERY candidate exactly once, best first. 0 = clearly wrong, 100 = exactly the shot needed.`;

// Exported so evidence-search.js's generic branch (same Pexels source, same need to validate)
// reuses this instead of a second copy. Best-effort: unscored/unfiltered pass-through on any
// failure (missing key, network error, bad JSON) rather than blocking results outright — matches
// the resilience pattern rerankCandidates() already uses for YouTube in evidence-search.js.
export async function rerankStockCandidates(intent, clips, env) {
  if (clips.length <= 1 || !env.GROQ_API_KEY) return clips;

  const list = clips.map((c) => ({ id: c.id, title: c.title, duration: c.duration }));
  const user =
    `MOMENT: ${intent.segmentText}\n` +
    (intent.context ? `CONTEXT: ${intent.context}\n` : "") +
    `SEARCH QUERY USED: ${intent.query}\n` +
    `\nCANDIDATES:\n${JSON.stringify(list)}`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        // Same reasoning as evidence-search.js's rerankCandidates: scoring against a fixed
        // rubric doesn't need the bigger model, and this runs on every feel-beat search too —
        // keep it off llama-3.3-70b's shared quota.
        model: "openai/gpt-oss-20b",
        messages: [
          { role: "system", content: STOCK_RERANK_PROMPT },
          { role: "user", content: user },
        ],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) return clips;

    const data = await res.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}");
    const ranking = Array.isArray(parsed.ranking) ? parsed.ranking : [];
    const byId = new Map(ranking.map((r) => [r.id, r]));

    const scored = clips.map((c) => {
      const r = byId.get(c.id);
      return { ...c, score: r ? Math.max(0, Math.min(100, Number(r.score) || 0)) : null, reason: r ? String(r.reason || "").slice(0, 60) : null };
    });
    // Conservative filter — Pexels' slug titles are thinner signal than YouTube's title+
    // description+channel, so only drop clearly-wrong matches, not just low-confidence ones.
    const kept = scored.filter((c) => c.score === null || c.score >= 20);
    kept.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    return kept;
  } catch {
    return clips;
  }
}
