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
import { groqChat } from "./_groq.js";

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
    const res = await groqChat(env, {
      // Same reasoning as evidence-search.js's rerankCandidates: scoring against a fixed
      // rubric doesn't need the bigger model, and this runs on every feel-beat search too —
      // keep it off llama-3.3-70b's shared quota.
      model: "openai/gpt-oss-20b",
      messages: [
        { role: "system", content: STOCK_RERANK_PROMPT },
        { role: "user", content: user },
      ],
      temperature: 0,
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
    // By this point the rerank call itself already succeeded (res.ok, JSON parsed) — a candidate
    // missing from the model's own ranking despite every candidate being sent isn't "no signal,
    // stay lenient," it's the model silently skipping something. Confirmed live: exactly this let
    // an unrelated clip (wrong subject entirely) through with no score shown at all, indistinguishable
    // from a genuinely vetted low-confidence result. Drop it — matches the MIN_RERANK_SCORE bar
    // this app already enforces everywhere else (evidence-search.js, reference-search.js).
    const kept = scored.filter((c) => c.score !== null && c.score >= 20);
    kept.sort((a, b) => b.score - a.score);
    return kept;
  } catch {
    return clips;
  }
}

const STOCK_RERANK_BATCH_PROMPT = `You score how well each stock-footage clip matches its OWN moment
of a video script. You get a list of segments, each with a moment (and its resolved context, if
given) plus candidate clips — same rubric as scoring one moment at a time: does the clip's title
(a real but terse auto-extracted slug, not a full sentence) plausibly describe footage fitting
THAT segment's moment? When an editorial visual goal is present, score the clip as a skilled
faceless-video editor: reward a concrete shot that communicates the intended idea or story beat,
even when it is an honest visual metaphor rather than a literal action stated in the narration.
Prefer human action, tension, consequence, contrast, and contextual detail over generic scenery.
The matchedQuery tells you which proposed shot strategy surfaced a candidate; it is context, not
proof that the thin Pexels title really contains every word. Score each segment's candidates independently of every other segment's —
a clip scoring well for one moment says nothing about its fit for another.

Return strict JSON only, no prose: {"segments":[{"i":0,"ranking":[{"id":"...","score":0-100,"reason":"<=8 words"}]}]}
Include an entry for every segment index given, and every one of that segment's candidates
exactly once, best first. 0 = clearly wrong, 100 = exactly the shot needed.`;

// Batched sibling of rerankStockCandidates — scores every segment's candidates in ONE Groq call
// instead of one call per segment. Exists because stock-search-batch.js's hydration path used to
// mean N segments' worth of "feel" beats each firing their own rerank call simultaneously via
// Promise.all on every workspace load — a burst against Groq's per-minute rate limit, not just
// its daily quota. Same 0-100 rubric and >=20 keep-threshold as the single-segment version, just
// addressed by segment index instead of a flat candidate list.
export async function rerankStockCandidatesBatch(items, env) {
  // Segments with 0-1 candidates have nothing to rank (same short-circuit as the single-segment
  // version) — skip them so the batch prompt/response stays sized to what's actually scorable.
  const scorable = items.filter((it) => it.clips.length > 1);
  if (!scorable.length || !env.GROQ_API_KEY) {
    return items.map((it) => it.clips);
  }

  const user = scorable.map((it) => ({
    i: it.i,
    moment: it.segmentText,
    context: it.context || undefined,
    query: it.query,
    visualGoal: it.visualGoal || undefined,
    visualQueries: it.queries || undefined,
    candidates: it.clips.map((c) => ({ id: c.id, title: c.title, duration: c.duration, matchedQuery: c.matchedQuery })),
  }));

  let rankingBySegment = new Map();
  try {
    const res = await groqChat(env, {
      model: "openai/gpt-oss-20b",
      messages: [
        { role: "system", content: STOCK_RERANK_BATCH_PROMPT },
        { role: "user", content: JSON.stringify(user) },
      ],
      temperature: 0,
    });
    if (res.ok) {
      const data = await res.json();
      const parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}");
      const segs = Array.isArray(parsed.segments) ? parsed.segments : [];
      rankingBySegment = new Map(
        segs.map((s) => [s.i, new Map((Array.isArray(s.ranking) ? s.ranking : []).map((r) => [r.id, r]))])
      );
    }
  } catch {
    // best-effort — segments below fall through to their unscored pass-through
  }

  return items.map((it) => {
    const ranking = rankingBySegment.get(it.i);
    if (!ranking) {
      // Two genuinely different cases share this branch, and confirmed live they need different
      // handling: (1) the WHOLE batch call failed (network error, bad JSON) — rankingBySegment
      // never got populated at all, so there's no signal for ANYONE; unfiltered pass-through is
      // the least-bad option rather than silently failing every feel beat in the project.
      // (2) the call succeeded and substantively scored OTHER segments, but this one segment's
      // index is inexplicably missing from its response — that's the model dropping something it
      // was actually given, not a total-failure case, and unfiltered pass-through here let an
      // entirely wrong-sport clip through live with zero score shown, indistinguishable from a
      // vetted result. Drop it, matching the per-candidate fix below.
      return rankingBySegment.size ? [] : it.clips;
    }
    const scored = it.clips.map((c) => {
      const r = ranking.get(c.id);
      return { ...c, score: r ? Math.max(0, Math.min(100, Number(r.score) || 0)) : null, reason: r ? String(r.reason || "").slice(0, 60) : null };
    });
    // Same reasoning as the single-segment version above: a candidate missing from an otherwise-
    // successful per-segment ranking isn't "no signal," it's the model skipping something it was
    // actually sent. Drop rather than default-include.
    const kept = scored.filter((c) => c.score !== null && c.score >= 20);
    kept.sort((a, b) => b.score - a.score);
    return kept;
  });
}
