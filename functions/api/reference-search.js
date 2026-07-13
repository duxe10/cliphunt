// Cloudflare Pages Function — POST /api/reference-search
// `reference` beats ("matches a known meme/cultural callback") used to search Giphy — a tag-based
// reaction-gif index that can't represent an actual NAMED meme and skews to old evergreen gifs.
// This used to ask an LLM to name a specific meme ("Surprised Pikachu"), but an LLM's meme
// knowledge is stuck at its training cutoff and can't track what's actually current. Instead this
// searches YouTube by EMOTION/REACTION (the same way `feel` already searches Giphy), then leans on
// deterministic filtering heuristics — not frame/caption analysis — to surface genuine raw
// reaction clips instead of compilations, reaction-channel commentary, or YouTube Shorts.
// Reactions aren't quote-based, so `quote` is always null: the worker's /match already has a
// zero-analysis fast path for quote:null (same one evidence's generic/no-quote beats use) that
// just returns a signed full-video download URL with no matching attempted — so the worker and
// app.js's existing /match call need no changes at all.
import { searchYouTubeVideos, enrichCandidates, rerankCandidates, signMatch } from "./evidence-search.js";

const SYSTEM_PROMPT = `You extract a search phrase for the REACTION/EMOTION at ONE moment of a video script
("the moment") so a tool can find a real raw reaction clip on YouTube — not a specific named meme,
just the feeling itself. You are given the script SO FAR (everything before the moment) for context.

Return strict JSON only, no prose, no markdown fences:
{"query":"..."}

"query": 3-6 words describing the reaction/emotion this moment calls for, phrased as a real
YouTube search for genuine reaction footage — not a gif tag, not a meme name. Examples: "shocked
crowd reaction", "stunned silence reaction real footage", "fan disbelief reaction", "jaw drop
shock reaction". Pick the specific emotion the moment is going for (shock, disbelief, elation,
dread, awkward cringe, etc) rather than a generic word like "reaction" alone.`;

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
// description are populated. Junk-title regex catches compilations and reaction-to-reaction
// commentary; the #shorts marker catches actual YouTube Shorts (often remixes/compilations
// themselves, not the raw clip); the duration cap is the length-as-proxy-signal: with no
// frame/caption analysis attempted for this family, a long video can't be trimmed down to the
// moment, so it's excluded outright rather than kept and mis-trimmed.
const MAX_REACTION_SEC = 180;
const JUNK_TITLE_RE = /compilation|top\s*\d+|best of|montage|mashup|reacts?\s+to|reaction\s+to|review|explained|breakdown|part\s*\d+/i;
const SHORTS_RE = /#shorts?\b/i;

export function filterRawReactionCandidates(candidates) {
  return candidates.filter((c) => {
    const title = c.title || "";
    const desc = c.description || "";
    if (JUNK_TITLE_RE.test(title)) return false;
    if (SHORTS_RE.test(title) || SHORTS_RE.test(desc)) return false;
    if (!Number.isFinite(c.durationSec) || c.durationSec > MAX_REACTION_SEC) return false;
    return true;
  });
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
  if (!env.WORKER_TOKEN) {
    return Response.json({ error: "WORKER_TOKEN is not set on this Cloudflare project" }, { status: 500 });
  }

  // 1. Groq extracts an emotion/reaction search phrase — no meme naming.
  const userContent = scriptContext && scriptContext.trim()
    ? `The script so far (everything before this moment):\n${scriptContext}\n\nThe moment:\n${segmentText}`
    : `The moment:\n${segmentText}`;

  let intent;
  try {
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
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

  // 2. YouTube search + enrich (same helpers evidence-search.js uses) + deterministic filter +
  //    rerank on capture-quality rather than meme-recognizability.
  let candidates;
  try {
    candidates = await searchYouTubeVideos(query, env.YOUTUBE_API_KEY);
  } catch (err) {
    return Response.json({ error: err.message }, { status: 502 });
  }

  await enrichCandidates(candidates, env.YOUTUBE_API_KEY);
  candidates = filterRawReactionCandidates(candidates);

  if (!candidates.length) {
    // Everything got filtered out — fail gracefully to the same empty-candidates state
    // findFootage() already handles ("No footage candidates found for this moment.").
    return Response.json({ subject: query, quote: null, candidates: [] });
  }

  await rerankCandidates({ segmentText, subject: query, footageType: "reaction", quote: null }, candidates, env, RERANK_PROMPT);
  candidates.sort((a, b) => (b.score || 0) - (a.score || 0));
  const top = candidates.slice(0, 5);

  // 3. Sign with quote:null — the worker's /match already takes a zero-analysis fast path for
  //    quote:null (same one evidence's generic/no-quote beats use), no worker changes needed.
  const exp = Math.floor(Date.now() / 1000) + 600; // 10 min
  const videoIds = top.map((c) => c.videoId);
  const matchSig = await signMatch(videoIds, null, exp, env.WORKER_TOKEN);

  return Response.json({ subject: query, quote: null, exp, matchSig, candidates: top });
}
