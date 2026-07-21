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
// 2026-07-21: MULTI-CLAIM DECOMPOSITION. One click on a beat like "He became the club's all-time
// top scorer, won the Golden Boot, and kept breaking record after record" used to extract exactly
// ONE search intent and silently discard two of the three real, independently-evidenced facts.
// This endpoint now asks Claude to split the moment into its genuinely separate claims FIRST (most
// moments still produce exactly one — see SYSTEM_PROMPT's STEP 1), then judges EACH claim
// independently for both footageType (specific/generic, same rules as before) and a new
// "mediaType": "video" | "photo" | "both" — some real claims (a cumulative record, a status fact)
// were never one filmable instant but likely do have a real photo, so the model decides per claim
// which medium(s) actually fit, rather than always searching video and falling back to photo, or
// searching both indiscriminately. Response shape is now `{claims: [{claim, footageType, subject,
// quote, mediaType, youtubeQuery, photoQuery, videoCandidates, photoCandidates, videoSearched,
// photoSearched}]}` — replaces the old flat `{subject, footageType, quote, candidates, images,
// imageQuery, imagesSearched}` shape entirely (app.js's renderEvidenceClaims() consumes this now;
// the old renderEvidence()/imageCardHtml() are gone as dead code).
//
// Photo search reuses the EXISTING `searchGoogleImages` (SerpAPI, see _serpapi.js) per claim's
// `photoQuery` — deliberately NOT a new Google Custom Search integration (an earlier draft of this
// plan spec'd GOOGLE_CSE_API_KEY/GOOGLE_CSE_ID as new Cloudflare secrets; scrapped before building
// — SerpAPI is already paid for, already wired, and already does exactly this job for this same
// endpoint, so there was no reason to stand up a second image-search integration next to it). This
// also means the old segment-level `depictionType` ("instant"/"fallback", set by segment.js) is no
// longer used to gate photo search here — the new per-claim `mediaType` judgment is a strictly
// more precise signal (per claim, not per whole segment) and supersedes it for this purpose.
// segment.js still computes `depictionType` for its own reasoning/UI display; this endpoint simply
// no longer reads it.
//
// `YOUTUBE_API_KEY` is no longer hard-guarded at the top of the handler the way it used to be —
// with mediaType now claim-specific, a request can be legitimately all-photo (mediaType "photo" on
// every claim), so a missing/misconfigured YouTube key should silently degrade to skipping video
// search (same fail-open philosophy already used for PEXELS_API_KEY in reference-search.js and
// SERPAPI_KEY in _serpapi.js) rather than 500ing a request that photo search alone could serve.
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
real footage/photos for it. You are given the script SO FAR (everything before the moment, a raw
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
{"claims":[{"claim":"...","footageType":"specific|generic","subject":"...","quote":"...","mediaType":"video|photo|both","youtubeQuery":"...","photoQuery":"..."}]}

STEP 1 — split the moment into claims:

Most moments produce exactly ONE claim — that is the common case; most of the time return a
single-element array. Only split into multiple claims when the moment lists two or more genuinely
separate, independently real, independently evidenced facts. The test: if you removed one clause,
would the rest still describe a complete, separately-evidenced fact? If yes for more than one
clause, split. Do NOT split one continuous action narrated across several clauses — that stays one
claim.

Worked examples:
- "He became the club's all-time top scorer, won the Golden Boot that year, and kept breaking
  record after record." -> THREE claims: "became the club's all-time top scorer", "won the Golden
  Boot that year", "kept breaking record after record" — each is independently real and
  independently evidenced (a record, an award ceremony, a cumulative pattern). A trailing clause
  like "...and one moment continues to define his legacy" is forward-referencing narration, not a
  completed fact — do NOT make it a 4th claim.
- "The startup bootstrapped for three years, acquired two smaller competitors, then went public in
  a blockbuster IPO." -> THREE claims (bootstrapping, acquisitions, IPO) — same reasoning, a
  different domain.
- "He ran up, paused for a beat, and smashed it into the top corner." -> ONE claim. This is a
  single continuous action narrated in sequence, not separate facts — do not split a play-by-play
  description of one event just because it has multiple clauses/verbs.
- "That resilience is one of the reasons teammates and managers continue to trust him." -> ONE
  claim, unchanged from before — a single complete statement about a real, already-established
  person.

STEP 2 — for EACH claim independently, decide the fields below. Claims from the same moment
usually share the same resolved subject (from context) unless a claim clearly names a different
one.

Decide "footageType":

This applies to a script about ANY topic — sports, business, science, politics, anything.

- "specific": the claim is about a PARTICULAR real person, team, org, or event doing or saying a
  particular thing. The subject can come from either place:
  (a) named or clearly referred to in the claim itself ("Harry Kane missed a penalty", "Tesla
      recalled two million cars"); or
  (b) NOT named in the claim because the moment is a fragment or shorthand for a specific event
      the preceding script is about — then resolve the subject from that earlier context.
      Example: after "...one moment continues to define his World Cup legacy.", the moment
      "A missed penalty." means HIM missing THAT penalty, so subject = the person the story is
      about (e.g. "Harry Kane") and youtubeQuery = "Harry Kane missed penalty France 2022".
      Same pattern in a different domain: after a script about a startup's near-collapse, the
      moment "One email changed everything." resolves to the specific investor reply that
      story was building to, not a generic "email" search.

      TWO RULES that are easy to get wrong when resolving (b) from context:
      1. ALWAYS carry forward the specific time, edition, or event established earlier — a year,
         season, funding round, tournament stage — into "youtubeQuery"/"photoQuery", not just when
         it's the first mention. A moment like "England looked stronger than ever" is genuinely
         ambiguous without restating which England, which year, which tournament — don't assume
         "now" just because the moment itself doesn't repeat it.
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

- "generic": the claim is a self-contained GENERAL statement true of a whole category, not one
  identifiable instance — usually signalled by quantifiers like "most", "every", "people",
  "everyone", or a general truth. Two examples, deliberately different domains: "For most
  footballers, scoring at a World Cup is the highlight of their career" and "Most startups fail
  within their first two years" are BOTH generic. Do NOT attach the video's main character to
  these. "subject" = the general concept/category (e.g. "footballers scoring at a World Cup",
  "startups failing"). "youtubeQuery" = 3-6 words describing the KIND of real moment to search
  for — a concrete action + category, not a person's name (e.g. "footballers celebrating World Cup
  goal", "startup shutting down failed business"). Set "quote" to null.

The test: does the claim point at ONE real event or person — even if only nameable through the
preceding context? Then specific. Would it be equally true of many people or instances? Then
generic. When the claim is a fragment/reference and the surrounding script clearly narrates one
subject's story, prefer specific and pull the subject from context. Go generic only when the
claim is genuinely a category-level statement, or when no specific subject can be identified even
from context.

Decide "mediaType" — is this claim best evidenced by video, a photo, or could both plausibly exist?
- "video": a real, singular, filmable instant — something a camera/broadcast plausibly captured as
  a moving scene (a goal, a press conference, a product launch event, a specific match).
- "photo": a cumulative/status fact with no single filmable moment — "kept breaking record after
  record", "became known as one of the best in the league" — nothing a video camera could have
  captured as ONE scene, but a real photograph (a portrait, a stats graphic, a trophy photo) likely
  exists.
- "both": ambiguous, or significant/major enough that a real broadcast moment AND a notable press
  photo both plausibly exist — major awards, records, and career milestones are commonly "both".
GUARDRAIL, the actual failure mode this exists to prevent: do NOT default to "photo" just because
a claim sounds like an achievement. First check whether it resolves to ONE identifiable real event
with likely footage (an award ceremony, a specific match, a signing) — that's "video" or "both".
Only land on "photo" alone when no single event can be pointed to at all — a genuinely
cumulative/vague status claim.
Worked through concretely, same three Kane claims as STEP 1's first example, reasoned individually:
- "became the club's all-time top scorer" — the record-breaking goal itself is a real, filmable
  moment, AND a stats graphic/photo of the moment plausibly exists -> "both"
- "won the Golden Boot that year" — a real award ceremony was filmed, AND press photos exist ->
  "both"
- "kept breaking record after record" — genuinely no single instant, a vague cumulative pattern ->
  "photo"

"youtubeQuery": set when mediaType is "video" or "both" (null otherwise) — 3-6 words, the best real
YouTube search to surface this footage — for "specific", a TITLE/KEYWORD match (a specific
person/event's name + distinguishing details); for "generic", a concrete action + category
describing the KIND of real moment (see above).

"photoQuery": set when mediaType is "photo" or "both" (null otherwise) — 3-7 words, phrased as a
NEWS-PHOTO-CAPTION style search (subject + event keywords, the way a wire-photo caption or article
headline would describe it) — explicitly NOT the visual-scene-description style used for stock
footage elsewhere in this app, since Google Image search indexes real caption/article text, not
scene descriptions. Both context-resolution rules above apply here identically: carry forward the
established time/edition/event, and resolve a progression fragment as the relationship to the
subject being followed. E.g. "Harry Kane Golden Boot award ceremony 2018 photo", not "man holding
golden boot trophy".

"quote": set ONLY when the claim quotes or closely paraphrases something the subject actually SAID
OUT LOUD — a spoken line that could appear in a video's captions. Narration, descriptions of
actions or events, and general statements are NOT quotes; set to null. Never invent a quote.
("A missed penalty." describes an action, so quote is null.)`;

const RERANK_PROMPT = `You rank YouTube search results by how good each is as the clip to CUT TO for
one claim of a video script. YouTube's own ordering is unreliable here — its top hits are often
reactions, "watch me react", watchalongs, or compilations rather than the clean primary footage.

You get the claim, its subject and footageType, and candidates (title, channel, duration in
seconds, view count, short description). Score each 0-100:
- Relevance: does it actually show THIS subject doing/saying THIS thing (specific), or clearly
  illustrate THIS concept (generic)? Off-topic = near 0.
- Source quality: strongly prefer primary footage (broadcast, official channel, the real clip)
  over reaction videos, watchalongs, essays, or compilations-of-compilations — unless the claim
  itself wants that.
- Fit: a focused clip beats a 3-hour livestream as a cut source; a credible/official channel beats
  a random reupload.

Return strict JSON only, no prose: {"ranking":[{"videoId":"...","score":0-100,"reason":"<=8 words"}]}
Include EVERY candidate exactly once, best first. 0 = unusable, 100 = exactly the clip.`;

export async function onRequestPost(context) {
  const { request, env } = context;

  let segmentText, scriptContext, debugImagesOnly;
  try {
    const body = await request.json();
    segmentText = body.segmentText;
    scriptContext = body.context;
    // Test/debug flag from app.js's "Photos-only test mode" toggle — forces photo search on every
    // claim regardless of its judged mediaType, and skips video search entirely (no YouTube quota
    // + Groq rerank round trip), so the photo pipeline can be iterated on cheaply. Off by default;
    // every existing call site that doesn't send this flag behaves exactly as before.
    debugImagesOnly = !!body.debugImagesOnly;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!segmentText || !segmentText.trim()) {
    return Response.json({ error: "No segmentText provided" }, { status: 400 });
  }
  if (!env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "ANTHROPIC_API_KEY is not set on this Cloudflare project" }, { status: 500 });
  }

  // 1. Claude splits the moment into claims and extracts intent per claim (see header comment for
  //    why this call site moved off Groq, and the SYSTEM_PROMPT's STEP 1/STEP 2 for what changed
  //    2026-07-21). Still exactly ONE Claude call regardless of how many claims come back.
  const userContent = scriptContext && scriptContext.trim()
    ? `The script so far (everything before this moment — use it to resolve who/what the moment is about):\n${scriptContext}\n\nThe moment:\n${segmentText}`
    : `The moment:\n${segmentText}`;

  let parsed;
  try {
    const claudeRes = await claudeChat(env, {
      model: "claude-sonnet-5",
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      // Bumped 4096 -> 8192 (2026-07-21): the answer can now be an ARRAY of claims instead of one
      // small object, on top of claude-sonnet-5's default adaptive thinking sharing this same
      // budget (see _claude.js and the prior 1024->4096 bump this file's git history already has).
      // An estimate to re-verify against real multi-claim usage, not a confirmed-safe number.
      max_tokens: 8192,
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      return Response.json({ error: `Claude error: ${errText}` }, { status: 502 });
    }

    const data = await claudeRes.json();
    parsed = JSON.parse(extractJson(extractText(data)));
  } catch (err) {
    return Response.json({ error: `Intent extraction failed: ${err.message}` }, { status: 502 });
  }

  const rawClaims = Array.isArray(parsed.claims) && parsed.claims.length
    ? parsed.claims
    // Defensive fallback if the model returns something malformed — treat the whole moment as one
    // video claim rather than failing the click outright.
    : [{ claim: segmentText, footageType: "specific", subject: null, quote: null, mediaType: "video", youtubeQuery: segmentText }];

  console.log(
    `[evidence-search] ${rawClaims.length} claim(s) debugImagesOnly=${debugImagesOnly} ` +
    `moment=${JSON.stringify(segmentText.slice(0, 100))}`
  );

  // 2. Run every claim concurrently, and within each claim run video/photo search concurrently —
  //    a claim only searches the medium(s) its own mediaType calls for (not "always both" the way
  //    reference-search.js's reaction-clip feature works), since an unwanted video search for a
  //    claim with no real filmable moment would reliably return nothing useful. debugImagesOnly
  //    overrides mediaType to force photo search on every claim and skip video on all of them.
  const claimResults = await Promise.all(rawClaims.map(async (c) => {
    const footageType = c.footageType === "generic" ? "generic" : "specific";
    const quote = footageType === "specific" && c.quote && String(c.quote).trim() ? String(c.quote).trim() : null;
    const mediaType = ["video", "photo", "both"].includes(c.mediaType) ? c.mediaType : "video";
    const claimText = (c.claim && String(c.claim).trim()) || segmentText;
    const youtubeQuery = (c.youtubeQuery || c.subject || claimText).trim();
    const photoQuery = (c.photoQuery || youtubeQuery).trim();

    // YOUTUBE_API_KEY is fail-open, not hard-guarded (see header comment) — a missing key just
    // silently drops video search for every claim rather than 500ing an all-photo-capable request.
    const wantsVideo = !debugImagesOnly && (mediaType === "video" || mediaType === "both") && !!env.YOUTUBE_API_KEY;
    const wantsPhoto = debugImagesOnly || mediaType === "photo" || mediaType === "both";

    const [videoCandidates, photoCandidates] = await Promise.all([
      wantsVideo
        ? searchVideoForClaim(youtubeQuery, { segmentText: claimText, subject: c.subject, footageType, quote }, env)
        : Promise.resolve([]),
      wantsPhoto ? searchGoogleImages(env, photoQuery) : Promise.resolve([]),
    ]);

    console.log(
      `[evidence-search]   claim=${JSON.stringify(claimText.slice(0, 80))} mediaType=${mediaType} ` +
      `youtubeQuery=${wantsVideo ? JSON.stringify(youtubeQuery) : "(skipped)"} ` +
      `photoQuery=${wantsPhoto ? JSON.stringify(photoQuery) : "(skipped)"} ` +
      `video=${videoCandidates.length} photo=${photoCandidates.length}`
    );

    return {
      claim: claimText,
      footageType,
      subject: c.subject || null,
      quote,
      mediaType,
      youtubeQuery: wantsVideo ? youtubeQuery : null,
      photoQuery: wantsPhoto ? photoQuery : null,
      videoCandidates,
      photoCandidates,
      videoSearched: wantsVideo,
      photoSearched: wantsPhoto,
    };
  }));

  return Response.json({ claims: claimResults });
}

// Never throws — a claim's video search failing (quota, API error, zero results) should never
// block or fail the claim's photo search (or any other claim's search) running alongside it.
async function searchVideoForClaim(query, intent, env) {
  try {
    const candidates = await searchYouTubeVideos(query, env.YOUTUBE_API_KEY);
    await enrichCandidates(candidates, env.YOUTUBE_API_KEY);
    const reranked = await rerankCandidates(intent, candidates, env);
    candidates.sort((a, b) => (b.score || 0) - (a.score || 0));
    const filtered = reranked ? candidates.filter((c) => (c.score || 0) >= MIN_RERANK_SCORE) : candidates;
    return filtered.slice(0, 5).map((c) => ({ ...c, url: `https://www.youtube.com/watch?v=${c.videoId}` }));
  } catch {
    return [];
  }
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
