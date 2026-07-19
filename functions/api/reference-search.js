// Cloudflare Pages Function — POST /api/reference-search
// `reference` beats ("matches a known meme/cultural callback") used to search Giphy — a tag-based
// reaction-gif index that can't represent an actual NAMED meme and skews to old evergreen gifs.
// This used to ask an LLM to name a specific meme ("Surprised Pikachu"), but an LLM's meme
// knowledge is stuck at its training cutoff and can't track what's actually current. Instead this
// searches YouTube by EMOTION/REACTION instead, then leans on deterministic filtering heuristics
// — not frame/caption analysis — to surface genuine raw reaction clips instead of compilations,
// reaction-channel commentary, or YouTube Shorts.
// Returned as plain youtube.com links — no downloading, same as evidence-search.js (see its
// header comment for why the yt-dlp/ffmpeg worker was dropped entirely).
//
// 2026-07-19: every search now ALWAYS runs both a YouTube reaction/meme search AND a Pexels stock
// search in parallel, for every click — not a fallback that only tries Pexels when YouTube comes
// up empty. A genuine raw meme/reaction clip and licensed stock b-roll of the same emotion serve
// different purposes (authenticity vs. clean footage), so both get shown together whenever either
// finds something; the segment only ends up with no clip if BOTH come up empty. Query-generation
// also now judges, per moment, whether the emotion is a common/well-indexed reaction-culture
// category (shock, laughter, disbelief, cringe) — for which the YouTube query strings the emotion
// + "reaction" + literally "meme" together, since that's what's actually well-indexed — versus
// something more unusual/specific, where plainer phrasing avoids biasing toward meme-culture
// matches that don't exist for that nuance. A second field, "stockQuery", is generated in the same
// call for the Pexels side (a concrete visual-scene phrase, same rule segment.js's "feel" query
// follows) — Pexels always runs regardless of the meme-keyword judgment, which only affects how
// "query" (the YouTube side) gets phrased.
import { searchYouTubeVideos, enrichCandidates, rerankCandidates, MIN_RERANK_SCORE } from "./evidence-search.js";
import { mapPexelsVideo, rerankStockCandidates } from "./stock-search.js";
import { groqChat } from "./_groq.js";

const SYSTEM_PROMPT = `You extract search intent for the REACTION/EMOTION at ONE moment of a video script
("the moment") so a tool can find real reaction footage for it — both a genuine raw reaction clip
on YouTube and licensed stock footage of the reaction on Pexels. You are given the script SO FAR
(everything before the moment) for context.

Return strict JSON only, no prose, no markdown fences:
{"query":"...","stockQuery":"..."}

"query": 3-6 words, a real YouTube search for genuine raw reaction footage — not a gif tag, not
naming a specific meme. Pick the specific emotion the moment is going for (shock, disbelief,
elation, dread, awkward cringe, etc) rather than a generic word like "reaction" alone.

Decide whether the emotion is a COMMON, well-indexed reaction-culture category — shock, laughter,
disbelief, cringe, and close synonyms of these — or something more unusual/narratively-specific to
this moment (quiet dread, bittersweet relief, dawning realization, etc). YouTube is overwhelmingly
full of "reaction meme" compilations/clips for the common categories, so for those string the
emotion + "reaction" + literally the word "meme" together — e.g. "shock reaction meme", "disbelief
reaction meme", "cringe reaction meme". For an unusual/specific emotion, adding "meme" biases the
search toward generic meme-culture clips that don't actually exist for that nuance, so leave it
out and phrase it plainer instead — e.g. "quiet dawning realization reaction real footage",
"bittersweet relief reaction real footage". This judgment only changes how "query" is phrased; it
has no effect on "stockQuery" below.

"stockQuery": 3-7 words, a SHORT DESCRIPTIVE VISUAL SCENE PHRASE for searching a real stock-footage
library (Pexels) — describe the shot itself the way a camera would frame it, not the emotion word
and never "reaction" or "meme". Pexels indexes what's literally on screen, not mood/emotion
keywords, so this must be a concrete, visible action or expression: a person's visible gesture,
posture, or facial expression. Good: "person covering mouth in shock", "man laughing hysterically",
"woman staring in disbelief", "person cringing looking away". Bad: "shock" or "disbelief" alone (a
mood word, not a visible scene), "shock reaction meme" (a YouTube-style query, not a scene
description), a person's/team's name.`;

const RERANK_PROMPT = `You rank YouTube search results by how well each serves as a raw reaction clip to
cut to for one moment of a video script. What matters here is CAPTURE QUALITY — is this genuinely
a raw, single, undoctored capture of someone/something having this reaction — not a compilation,
not a reaction-channel commentary video, not a Shorts remix — something a viewer would read as
"real footage of this reaction happening," not produced/edited content about the reaction.

You get the moment and candidates (title, channel, duration in seconds, view count, short
description). Score each 0-100:
- Authenticity: does this look like a raw, single capture of the reaction itself, vs a video
  ABOUT the reaction (commentary, review, reaction-to-a-reaction, compilation of many clips)?
  The latter = near 0 even if topically related.
- Fit: does the reaction shown actually match the requested emotion? Off-topic = near 0.
- Focus: a short, single-moment clip beats a long or multi-segment video.

Return strict JSON only, no prose: {"ranking":[{"videoId":"...","score":0-100,"reason":"<=8 words"}]}
Include EVERY candidate exactly once, best first. 0 = unusable, 100 = exactly the raw reaction moment.`;

// Deterministic pre-filter — no LLM call. Runs after enrichCandidates() so durationSec/title/
// description are populated. Junk-title regex catches compilations, reaction-to-reaction
// commentary, and sound-effect-library uploads (these are short and pass the duration cap, but
// they're audio SFX, not a raw reaction being captured on video — they reliably say so in the
// title); the #shorts marker catches actual YouTube Shorts (often remixes/compilations themselves,
// not the raw clip); the duration cap is the length-as-proxy-signal: with no frame/caption
// analysis attempted for this family, a long video can't be trimmed down to the moment, so it's
// excluded outright rather than kept and mis-trimmed.
const MAX_REACTION_SEC = 180;
const JUNK_TITLE_RE = /compilation|top\s*\d+|best of|montage|mashup|reacts?\s+to|reaction\s+to|review|explained|breakdown|part\s*\d+|sound effects?|\bsfx\b/i;
const SHORTS_RE = /#shorts?\b/i;

// `enrichOk` (true by default) tells this whether durationSec is trustworthy. enrichCandidates()
// is best-effort and fails silently on a network/quota hiccup, which would otherwise leave every
// candidate without a duration — `!Number.isFinite(c.durationSec)` would then reject everything,
// turning one transient YouTube API failure into a hard "no candidates found" instead of falling
// back to the title/shorts checks, which don't depend on enrichment having succeeded.
export function filterRawReactionCandidates(candidates, enrichOk = true) {
  return candidates.filter((c) => {
    const title = c.title || "";
    const desc = c.description || "";
    if (JUNK_TITLE_RE.test(title)) return false;
    if (SHORTS_RE.test(title) || SHORTS_RE.test(desc)) return false;
    if (enrichOk && (!Number.isFinite(c.durationSec) || c.durationSec > MAX_REACTION_SEC)) return false;
    return true;
  });
}

// Runs the full YouTube reaction pipeline (search -> enrich -> deterministic filter -> rerank)
// for one moment. NEVER throws — every failure mode (YouTube API error, enrich failure, rerank
// failure) resolves to an empty array so this can run alongside searchPexelsReaction() via a
// plain Promise.all, with no rejected-promise case either caller needs to handle.
async function searchYouTubeReaction(query, segmentText, env) {
  try {
    let candidates = await searchYouTubeVideos(query, env.YOUTUBE_API_KEY);
    const enrichOk = await enrichCandidates(candidates, env.YOUTUBE_API_KEY);
    candidates = filterRawReactionCandidates(candidates, enrichOk);
    if (!candidates.length) return [];

    const reranked = await rerankCandidates(
      { segmentText, subject: query, footageType: "reaction", quote: null },
      candidates,
      env,
      RERANK_PROMPT
    );
    candidates.sort((a, b) => (b.score || 0) - (a.score || 0));
    const filtered = reranked ? candidates.filter((c) => (c.score || 0) >= MIN_RERANK_SCORE) : candidates;
    return filtered.slice(0, 5).map((c) => ({ ...c, url: `https://www.youtube.com/watch?v=${c.videoId}` }));
  } catch (err) {
    console.log(`[reference-search] YouTube pipeline failed: ${err.message}`);
    return [];
  }
}

// Runs the Pexels stock pipeline (search -> map -> rerank) for one moment. NEVER throws — a
// missing PEXELS_API_KEY or any fetch/parse failure resolves to an empty array (graceful
// degradation to YouTube-only results), matching rerankStockCandidates()'s own fail-open
// philosophy. Unlike YOUTUBE_API_KEY/GROQ_API_KEY below, PEXELS_API_KEY is NOT hard-guarded at
// the top of onRequestPost — this endpoint's core identity is still "find a reaction clip"
// (YouTube); Pexels only broadens it, so a missing/misconfigured Pexels key shouldn't 500 the
// whole request when the YouTube half doesn't need it.
async function searchPexelsReaction(stockQuery, segmentText, scriptContext, env) {
  if (!env.PEXELS_API_KEY) return [];
  try {
    const url =
      "https://api.pexels.com/videos/search" +
      `?query=${encodeURIComponent(stockQuery)}&per_page=10&orientation=landscape`;
    const res = await fetch(url, { headers: { Authorization: env.PEXELS_API_KEY } });
    if (!res.ok) return [];

    const data = await res.json();
    const clips = (data.videos || []).map((v) => mapPexelsVideo(v)).filter((c) => c && c.downloadUrl);
    if (!clips.length) return [];

    return await rerankStockCandidates({ segmentText, context: scriptContext, query: stockQuery }, clips, env);
  } catch (err) {
    console.log(`[reference-search] Pexels pipeline failed: ${err.message}`);
    return [];
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let segmentText, scriptContext;
  try {
    const body = await request.json();
    segmentText = body.segmentText;
    scriptContext = body.context;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!segmentText || !segmentText.trim()) {
    return Response.json({ error: "No segmentText provided" }, { status: 400 });
  }
  if (!env.GROQ_API_KEY) {
    return Response.json({ error: "GROQ_API_KEY is not set on this Cloudflare project" }, { status: 500 });
  }
  if (!env.YOUTUBE_API_KEY) {
    return Response.json({ error: "YOUTUBE_API_KEY is not set on this Cloudflare project" }, { status: 500 });
  }
  // PEXELS_API_KEY is intentionally NOT guarded here — see searchPexelsReaction()'s comment.

  // 1. Groq extracts BOTH an emotion/meme-aware YouTube query and a concrete-scene Pexels query
  //    from the same moment in one call — one search-intent pass, two search targets.
  const userContent = scriptContext && scriptContext.trim()
    ? `The script so far (everything before this moment):\n${scriptContext}\n\nThe moment:\n${segmentText}`
    : `The moment:\n${segmentText}`;

  let intent;
  try {
    const groqRes = await groqChat(env, {
      // Was llama-3.3-70b-versatile — see segment.js's onRequestPost for why.
      model: "openai/gpt-oss-120b",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: 0.2,
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      return Response.json({ error: `Groq error: ${errText}` }, { status: 502 });
    }

    const data = await groqRes.json();
    intent = JSON.parse(data.choices?.[0]?.message?.content || "{}");
  } catch (err) {
    return Response.json({ error: `Intent extraction failed: ${err.message}` }, { status: 502 });
  }

  const query = (intent.query || segmentText).trim();
  const stockQuery = (intent.stockQuery || query).trim();
  console.log(
    `[reference-search] query=${JSON.stringify(query)} stockQuery=${JSON.stringify(stockQuery)} ` +
    `moment=${JSON.stringify(segmentText.slice(0, 100))}`
  );

  // 2. YouTube reaction search and Pexels stock search run CONCURRENTLY, not as a fallback chain —
  //    every click always searches both. Neither pipeline function throws (see their own comments
  //    above), so a plain Promise.all is safe: one path's failure can never block or reject the
  //    other, and there's no rejected-promise branch to handle here.
  const [candidates, clips] = await Promise.all([
    searchYouTubeReaction(query, segmentText, env),
    searchPexelsReaction(stockQuery, segmentText, scriptContext, env),
  ]);

  return Response.json({ subject: query, stockQuery, candidates, clips });
}
