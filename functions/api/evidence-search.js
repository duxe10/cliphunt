// Cloudflare Pages Function — POST /api/evidence-search
// Both "specific" (one named real subject) and "generic" (a genuine categorical claim about a
// class of real people/things — see segment.js's "categoryClaim") beats search YouTube for real
// captured footage (2026-07-18: generic beats used to route to Pexels stock instead, but stock
// b-roll isn't authentic footage of the claim — "most footballers... scoring" needs real players
// actually celebrating a real World Cup goal, not generic stock). The only difference between the
// two flavors is the query/subject framing fed into the search and rerank below, not the source.
// Both get quality-enriched and LLM-reranked against the beat's claim, and are returned as plain
// youtube.com links — no downloading, trimming, or server-side video handling of any kind (that
// used to hand off to a yt-dlp/ffmpeg worker; dropped entirely — downloading someone else's
// YouTube video carried real copyright/ToS risk this app doesn't need to take on. The rerank
// score/reason already answers "does this actually back up the claim?", so there's no separate
// verification step to rebuild — it's the same signal, just surfaced in the UI instead of feeding
// a caption-match step).
//
// 2026-07-19: also returns `images` — Google Images photo results via SerpAPI (see _serpapi.js),
// searched concurrently with the YouTube pipeline using the intent's `imageQuery`. Additive and
// fail-open: any SerpAPI problem (missing key, quota, fetch error) yields images:[] without
// affecting the YouTube result. Evidence beats only — deliberately NOT added to reference-search
// (user cut that scope; see HANDOFF "Google Images on evidence beats").
//
// Model split (2026-07-18): intent extraction (context resolution — the hard, reasoning-heavy
// part, see the "TWO RULES" block below) moved to Claude Sonnet, targeting the exact kind of
// context-resolution failure that motivated the swap (a fragment resolving to the wrong event
// from the surrounding script). Reranking (mechanical 0-100 scoring against an already-resolved
// claim) stays on Groq's gpt-oss-20b — cheap, high-frequency (every YouTube search), and not the
// part that was failing. This account is on a small real Anthropic balance, not a free tier —
// see _claude.js's header comment.
import { groqChat } from "./_groq.js";
import { claudeChat, extractText, extractJson } from "./_claude.js";
import { searchGoogleImages } from "./_serpapi.js";

// Below this score, the rerank considers a candidate a clear miss rather than a borderline
// option — dropped outright rather than shown with a low score nobody's forced to notice.
// Exported so reference-search.js's own rerank filter uses the same bar.
export const MIN_RERANK_SCORE = 30;
const SYSTEM_PROMPT = `You extract search intent from ONE moment of a video script ("the moment") so a tool can find
real footage for it. You are given the script SO FAR (everything before the moment, a raw
concatenation of preceding sentences) to resolve who/what/when it's about yourself — pronouns,
elliptical fragments, and vague references included. This resolution is done fresh per click, one
moment at a time, rather than as a separate whole-script pass computed once upfront: a prior
version of this pipeline did that upfront resolution as one big batched call over every
evidence/reference moment in the script at project-creation time, which turned out to make a
single project-creation request's size scale with the whole script's length — for a long real
script that reliably exceeded a single model call's practical limits. Resolving per click instead
means each individual request stays small and paced to actual usage, at the cost of re-deriving
context each time instead of reusing a precomputed answer — worth it for the reliability.

Occasionally the "script so far" you're given might already read as a single, clean, pre-resolved
sentence rather than raw narration (e.g. if it was set some other way) — if so, trust it directly
instead of re-deriving your own answer. But normally, expect raw preceding narration and resolve
it yourself using the rules below.

Return strict JSON only, no prose, no markdown fences:
{"footageType":"specific|generic","subject":"...","quote":"...","youtubeQuery":"...","imageQuery":"..."}

Decide "footageType":

This applies to a script about ANY topic — sports, business, science, politics, anything.

- "specific": the moment shows a PARTICULAR real person, team, org, or event doing or saying a
  particular thing. The subject can come from either place:
  (a) named or clearly referred to in the moment itself ("Harry Kane missed a penalty", "Tesla
      recalled two million cars"); or
  (b) NOT named in the moment because it is a fragment or shorthand for a specific event the
      preceding script is about — then resolve the subject from that earlier context.
      Example: after "...one moment continues to define his World Cup legacy.", the moment
      "A missed penalty." means HIM missing THAT penalty, so subject = the person the story is
      about (e.g. "Harry Kane") and youtubeQuery = "Harry Kane missed penalty France 2022".
      Same pattern in a different domain: after a script about a startup's near-collapse, the
      moment "One email changed everything." resolves to the specific investor reply that
      story was building to, not a generic "email" search.

      TWO RULES that are easy to get wrong when resolving (b) from context:
      1. ALWAYS carry forward the specific time, edition, or event established earlier — a year,
         season, funding round, tournament stage — into "youtubeQuery", not just when it's the
         first mention. A moment like "England looked stronger than ever" is genuinely ambiguous
         without restating which England, which year, which tournament — don't assume "now" just
         because the moment itself doesn't repeat it.
      2. When a fragment introduces a NEW name as the next step in an ongoing progression — a
         next opponent, a next round, a next funding stage — resolve it as the RELATIONSHIP
         between the subject already being followed and that new name, not as if the new name
         were its own independent topic. "Then came France" after several moments narrating a
         team's tournament run means the team's NEXT MATCH is against France — youtubeQuery
         should target "England vs France [round] [year] World Cup", not generic France content.
      Two examples, different domains, both rules together: after context narrating England's
      2022 World Cup run through the group stage and round of 16, "Then came France." resolves to
      subject "England" and youtubeQuery "England vs France quarterfinal 2022 World Cup" — not
      standalone France content. After context narrating a startup's 2019 seed round, "Then came
      the Series B." resolves to subject "the startup" and youtubeQuery naming the actual 2019
      Series B round, not a generic Series B explainer.
  "subject" = that entity. "youtubeQuery" = subject + the distinguishing keywords (event,
  opponent, year) most likely to appear in a real video's title.

- "generic": the moment is a self-contained GENERAL statement true of a whole category, not one
  identifiable instance — usually signalled by quantifiers like "most", "every", "people",
  "everyone", or a general truth. Two examples, deliberately different domains: "For most
  footballers, scoring at a World Cup is the highlight of their career" and "Most startups fail
  within their first two years" are BOTH generic. Do NOT attach the video's main character to
  these. "subject" = the general concept/category (e.g. "footballers scoring at a World Cup",
  "startups failing"). "youtubeQuery" = 3-6 words describing the KIND of real moment to search
  for — a concrete action + category, not a person's name (e.g. "footballers celebrating World Cup
  goal", "startup shutting down failed business"). Set "quote" to null.

The test: does the moment point at ONE real event or person — even if only nameable through the
preceding context? Then specific. Would it be equally true of many people or instances? Then
generic. When the moment is a fragment/reference and the surrounding script clearly narrates one
subject's story, prefer specific and pull the subject from context. Go generic only when the
moment is genuinely a category-level statement, or when no specific subject can be identified even
from context.

Set "quote" ONLY when the moment quotes or closely paraphrases something the subject actually SAID
OUT LOUD — a spoken line that could appear in a video's captions. Narration, descriptions of
actions or events, and general statements are NOT quotes; set "quote" to null. Never invent a
quote. ("A missed penalty." describes an action, so quote is null.)

"youtubeQuery": 3-6 words, the best real YouTube search to surface this footage — for "specific",
a TITLE/KEYWORD match (a specific person/event's name + distinguishing details); for "generic", a
concrete action + category describing the KIND of real moment (see above). Set for both
footageTypes — this endpoint always searches YouTube, never Pexels stock.

"imageQuery": 3-7 words, the best Google Images search for a real PHOTOGRAPH of this moment — the
same subject and distinguishing details (year, opponent, event) as youtubeQuery, but phrased for a
still image rather than a video: drop video-title words like "highlights", "full match",
"interview", "reaction", and name the frozen instant a photographer would have captured (e.g.
"Harry Kane penalty miss France 2022" for the video becomes "Harry Kane dejected after penalty
miss France 2022" for the photo — the visible moment, not the narrative). Both rules from (b)
above apply here identically: carry the established time/edition/event forward, and resolve a
progression fragment as the relationship to the subject being followed. Set for both footageTypes.`;

const RERANK_PROMPT = `You rank YouTube search results by how good each is as the clip to CUT TO for
one moment of a video script. YouTube's own ordering is unreliable here — its top hits are often
reactions, "watch me react", watchalongs, or compilations rather than the clean primary footage.

You get the moment, its subject and footageType, and candidates (title, channel, duration in
seconds, view count, short description). Score each 0-100:
- Relevance: does it actually show THIS subject doing/saying THIS thing (specific), or clearly
  illustrate THIS concept (generic)? Off-topic = near 0.
- Source quality: strongly prefer primary footage (broadcast, official channel, the real clip)
  over reaction videos, watchalongs, essays, or compilations-of-compilations — unless the moment
  itself wants that.
- Fit: a focused clip beats a 3-hour livestream as a cut source; a credible/official channel beats
  a random reupload.

Return strict JSON only, no prose: {"ranking":[{"videoId":"...","score":0-100,"reason":"<=8 words"}]}
Include EVERY candidate exactly once, best first. 0 = unusable, 100 = exactly the clip.`;

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
  if (!env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "ANTHROPIC_API_KEY is not set on this Cloudflare project" }, { status: 500 });
  }

  // 1. Claude extracts intent (see header comment for why this call site moved off Groq).
  const userContent = scriptContext && scriptContext.trim()
    ? `The script so far (everything before this moment — use it to resolve who/what the moment is about):\n${scriptContext}\n\nThe moment:\n${segmentText}`
    : `The moment:\n${segmentText}`;

  let intent;
  try {
    const claudeRes = await claudeChat(env, {
      model: "claude-sonnet-5",
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      // Bumped 1024 -> 4096 (2026-07-18): claude-sonnet-5's default adaptive thinking (see
      // _claude.js) shares this same budget, and 1024 wasn't enough room for low-effort thinking
      // PLUS the small intent JSON to both fit — confirmed live as a response with ONLY a
      // thinking block and no text at all. The actual JSON answer here is still small (one
      // segment's intent), the extra headroom is for thinking, not for a bigger answer.
      max_tokens: 4096,
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      return Response.json({ error: `Claude error: ${errText}` }, { status: 502 });
    }

    const data = await claudeRes.json();
    intent = JSON.parse(extractJson(extractText(data)));
    // Live-tail visibility only (wrangler pages deployment tail), same discipline as segment.js's
    // per-segment log — captures the model's own query-generation output (raw, pre-normalization)
    // so a vague/wrong youtubeQuery can be diagnosed straight from this line without a durable
    // store.
    console.log(
      `[evidence-search] footageType=${intent.footageType} subject=${JSON.stringify(intent.subject ?? null)} ` +
      `youtubeQuery=${JSON.stringify(intent.youtubeQuery ?? null)} imageQuery=${JSON.stringify(intent.imageQuery ?? null)} ` +
      `quote=${JSON.stringify(intent.quote ?? null)} moment=${JSON.stringify(segmentText.slice(0, 100))}`
    );
  } catch (err) {
    return Response.json({ error: `Intent extraction failed: ${err.message}` }, { status: 502 });
  }

  const footageType = intent.footageType === "specific" ? "specific" : "generic";
  const quote =
    footageType === "specific" && intent.quote && String(intent.quote).trim()
      ? String(intent.quote).trim()
      : null;

  if (!env.YOUTUBE_API_KEY) {
    return Response.json({ error: "YOUTUBE_API_KEY is not set on this Cloudflare project" }, { status: 500 });
  }

  const query = (intent.youtubeQuery || intent.subject || segmentText).trim();

  // 2. Google Images (SerpAPI) kicks off here so it runs CONCURRENTLY with the whole YouTube
  //    pipeline below (search + enrich + rerank), not after it. searchGoogleImages never throws
  //    and resolves to [] on any failure/missing key (see _serpapi.js) — images are additive, a
  //    SerpAPI problem must never break the core YouTube result. Falls back to youtubeQuery if
  //    the model omitted imageQuery, so an older cached intent shape still gets images.
  const imagesPromise = searchGoogleImages(env, (intent.imageQuery || query).trim());

  // 3. YouTube Data API search.list (fetch 12 to rerank from).
  let candidates;
  try {
    candidates = await searchYouTubeVideos(query, env.YOUTUBE_API_KEY);
  } catch (err) {
    return Response.json({ error: err.message }, { status: 502 });
  }

  // 3b/3c. Enrich with quality signals, then LLM re-rank against the beat's intent. Both
  //        best-effort — on failure candidates keep YouTube's order and an unfiltered score of 0,
  //        which the MIN_RERANK_SCORE filter below would wrongly drop — so track whether rerank
  //        actually ran before applying it.
  await enrichCandidates(candidates, env.YOUTUBE_API_KEY);
  const reranked = await rerankCandidates({ segmentText, subject: intent.subject, footageType, quote }, candidates, env);
  candidates.sort((a, b) => (b.score || 0) - (a.score || 0));
  const filtered = reranked ? candidates.filter((c) => (c.score || 0) >= MIN_RERANK_SCORE) : candidates;
  const top = filtered.slice(0, 5).map((c) => ({ ...c, url: `https://www.youtube.com/watch?v=${c.videoId}` }));

  const images = await imagesPromise;

  return Response.json({ subject: intent.subject || null, footageType, quote, candidates: top, images });
}

// YouTube Data API search.list (fetch 12 to rerank from). Exported so reference-search.js's meme
// lookup reuses the exact same search/shape instead of a second copy of this fetch.
export async function searchYouTubeVideos(query, apiKey) {
  const url =
    "https://www.googleapis.com/youtube/v3/search" +
    `?part=snippet&type=video&maxResults=12&safeSearch=none` +
    `&q=${encodeURIComponent(query)}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`YouTube error: ${errText}`);
  }
  const data = await res.json();
  return (data.items || [])
    .filter((it) => it.id && it.id.videoId)
    .map((it) => ({
      videoId: it.id.videoId,
      title: it.snippet?.title || "",
      channel: it.snippet?.channelTitle || "",
      thumb: it.snippet?.thumbnails?.medium?.url || it.snippet?.thumbnails?.default?.url || "",
    }));
}

// Adds duration/views/description onto each candidate via one videos.list call (1 quota unit).
// Returns true if enrichment actually happened, so callers relying on durationSec (e.g.
// reference-search.js's duration-cap filter) can tell "no candidates are long" apart from
// "we don't know how long anything is" and avoid rejecting everything on a transient failure.
export async function enrichCandidates(candidates, apiKey) {
  const ids = candidates.map((c) => c.videoId).filter(Boolean).join(",");
  if (!ids) return false;
  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics,snippet&id=${ids}&key=${apiKey}`
    );
    if (!res.ok) return false;
    const data = await res.json();
    const byId = new Map((data.items || []).map((it) => [it.id, it]));
    for (const c of candidates) {
      const it = byId.get(c.videoId);
      if (!it) continue;
      c.durationSec = parseIsoDuration(it.contentDetails && it.contentDetails.duration);
      c.views = Number(it.statistics && it.statistics.viewCount) || 0;
      c.description = (it.snippet && it.snippet.description ? it.snippet.description : "").slice(0, 160);
    }
    return true;
  } catch {
    return false; // best-effort
  }
}

// "PT1H2M3S" -> seconds. null on anything unparseable.
function parseIsoDuration(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
  if (!m) return null;
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
}

// Scores each candidate 0-100 against the beat's intent, writing c.score / c.reason in place.
// Exported with a `systemPrompt` override so reference-search.js can rerank against a
// meme-recognizability rubric instead of evidence's primary-footage rubric, via the same call.
// Returns true if scoring actually happened (so callers can tell a real 0 apart from "rerank
// didn't run" and avoid filtering everything out on a network/API failure).
export async function rerankCandidates(intent, candidates, env, systemPrompt = RERANK_PROMPT) {
  if (candidates.length <= 1 || !env.GROQ_API_KEY) return false;
  const list = candidates.map((c) => ({
    videoId: c.videoId,
    title: c.title,
    channel: c.channel,
    durationSec: c.durationSec ?? null,
    views: c.views ?? null,
    desc: (c.description || "").slice(0, 120),
  }));
  const user =
    `MOMENT: ${intent.segmentText}\n` +
    `SUBJECT: ${intent.subject || "(none)"}\n` +
    `FOOTAGE TYPE: ${intent.footageType}\n` +
    (intent.quote ? `SPOKEN LINE: ${intent.quote}\n` : "") +
    `\nCANDIDATES:\n${JSON.stringify(list)}`;
  try {
    const res = await groqChat(env, {
      // Scoring against an already-well-defined rubric is mechanical, not reasoning-heavy —
      // the fast model is plenty, and this is the highest-frequency call site (every YouTube
      // search, evidence + reference both), so moving it off llama-3.3-70b's shared quota
      // matters most here.
      model: "openai/gpt-oss-20b",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: user },
      ],
      temperature: 0,
    });
    if (!res.ok) return false;
    const data = await res.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}");
    const ranking = Array.isArray(parsed.ranking) ? parsed.ranking : [];
    const byId = new Map(ranking.map((r) => [r.videoId, r]));
    for (const c of candidates) {
      const r = byId.get(c.videoId);
      c.score = r ? Math.max(0, Math.min(100, Number(r.score) || 0)) : 0;
      c.reason = r ? String(r.reason || "").slice(0, 60) : "";
    }
    return true;
  } catch {
    return false; // best-effort: leave candidates unscored, original order preserved
  }
}
