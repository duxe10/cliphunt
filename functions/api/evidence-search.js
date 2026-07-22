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
// Model split (2026-07-18): intent extraction (context resolution — the hard, reasoning-heavy
// part, see the "TWO RULES" block below) moved to Claude Sonnet, targeting the exact kind of
// context-resolution failure that motivated the swap (a fragment resolving to the wrong event
// from the surrounding script). Reranking (mechanical 0-100 scoring against an already-resolved
// claim) stays on Groq's gpt-oss-20b — cheap, high-frequency (every YouTube search), and not the
// part that was failing. This account is on a small real Anthropic balance, not a free tier —
// see _claude.js's header comment.
//
// Multi-claim decomposition + photo evidence (2026-07-19): one click used to extract exactly ONE
// intent, which silently collapsed a moment narrating several independent real facts (e.g. "Kane
// became top scorer, won the Golden Boot, and broke record after record") into a single query —
// two of three real claims discarded with no trace. STEP 1 below now splits a moment into its
// genuinely separate claims (most moments still produce exactly one — that's still the common
// case, unchanged). Separately, some real claims are cumulative/status facts with no single
// filmable instant (a record tally, "record after record") but do plausibly have a real news
// photo — STEP 2 judges "mediaType" per claim so photo is a deliberate per-claim choice, not a
// blanket fallback for anything that sounds like an achievement. Photo search runs against Google
// Custom Search's image mode (GOOGLE_CSE_API_KEY/GOOGLE_CSE_ID) — soft-guarded like PEXELS_API_KEY
// in reference-search.js: this endpoint's core identity stays "find video evidence", photo only
// broadens it, so a missing/misconfigured CSE key degrades a claim to video-only instead of
// failing the whole request.
import { groqChat } from "./_groq.js";
import { claudeChat, extractText, extractJson } from "./_claude.js";

// Below this score, the rerank considers a candidate a clear miss rather than a borderline
// option — dropped outright rather than shown with a low score nobody's forced to notice.
// Exported so reference-search.js's own rerank filter uses the same bar. Reused as-is for photo
// candidates too (see rerankPhotoCandidates below) — same bar, same reasoning.
export const MIN_RERANK_SCORE = 30;

const SYSTEM_PROMPT = `You extract search intent from ONE moment of a video script ("the moment") so a tool can find
real footage AND real photos for it. You are given the script SO FAR (everything before the
moment, a raw concatenation of preceding sentences) to resolve who/what/when it's about yourself —
pronouns, elliptical fragments, and vague references included. This resolution is done fresh per
click, one moment at a time, rather than as a separate whole-script pass computed once upfront: a
prior version of this pipeline did that upfront resolution as one big batched call over every
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
{"claims":[{"claim":"...","footageType":"specific|generic","subject":"...","quote":"...","youtubeQuery":"...","mediaType":"video|photo|both","photoQuery":"..."}]}

STEP 1 — split the moment into its claims.

Most moments produce exactly ONE claim — that's the common case, and most of the time you should
return a single-element array. Only split into multiple claims when the moment lists TWO OR MORE
genuinely separate, independently real, independently evidence-worthy facts. The test: if you
removed one clause, would the rest still describe a complete, separately-evidenced fact? If yes for
more than one clause, split. Do NOT split one continuous action just because it's narrated across
several clauses — "He ran up, paused, and smashed it into the corner" is ONE claim (one continuous
action), not three.

Worked example (sports): "Kane became the tournament's top scorer, won the Golden Boot, and kept
breaking record after record — one moment continues to define his World Cup legacy." This splits
into exactly THREE claims:
  1. claim: "Kane became the tournament's top scorer"
  2. claim: "Kane won the Golden Boot"
  3. claim: "Kane kept breaking record after record"
The trailing "one moment continues to define his World Cup legacy" is NOT a 4th claim — it's
forward-referencing narration (gesturing at a moment without stating what happened), not a
completed, independently evidenced fact.

Worked example (business, same pattern, different domain): "The company survived a hostile
takeover attempt, settled the lawsuit that followed, and went public two years later" splits into
THREE claims: the takeover attempt being survived, the lawsuit settlement, and the IPO — three
separate real, independently findable events.

Worked contrast (deliberately NOT split): "The alarm went off at 3am, she grabbed the extinguisher,
and by the time firefighters arrived the fire was already out" is ONE claim — a single continuous
incident narrated in sequence, not several independent facts.

For EACH claim, resolve "footageType"/"subject"/"quote"/"youtubeQuery" using the rules below —
these are the same resolution rules this pipeline has always used, just applied per claim instead
of once per click.

This applies to a script about ANY topic — sports, business, science, politics, anything.

Decide "footageType":

- "specific": the claim is about a PARTICULAR real person, team, org, or event doing or saying a
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

Set "quote" ONLY when the claim quotes or closely paraphrases something the subject actually SAID
OUT LOUD — a spoken line that could appear in a video's captions. Narration, descriptions of
actions or events, and general statements are NOT quotes; set "quote" to null. Never invent a
quote. ("A missed penalty." describes an action, so quote is null.)

"youtubeQuery": 3-6 words, the best real YouTube search to surface this footage — for "specific",
a TITLE/KEYWORD match (a specific person/event's name + distinguishing details); for "generic", a
concrete action + category describing the KIND of real moment (see above). Set for both
footageTypes — YouTube search always runs whenever "mediaType" calls for video (see STEP 2 below).

STEP 2 — judge "mediaType" per claim.

For EACH claim, judge which medium(s) actually fit — don't always search video and fall back to
photo, and don't search both indiscriminately either:

- "video": the claim is a real, singular, filmable instant — an action or moment that happened at
  one identifiable point in time (a goal, a missed penalty, a speech, a product launch event).
- "photo": the claim is a cumulative or status fact with NO single filmable moment — a running
  tally, a record, a vague "record after record" — but real news/press photography of the
  subject in that context plausibly exists.
- "both": ambiguous, OR significant enough that a real broadcast moment AND a notable press photo
  both plausibly exist — major awards, ceremonies, and records commonly are (a Golden Boot
  ceremony is both a filmable award moment AND something press photographers cover).

GUARDRAIL: do not default to "photo" just because a claim sounds like an achievement. Check FIRST
whether the claim resolves to one identifiable real event with likely footage — only fall back to
"photo" when no single event can be pointed to. Reason through each claim individually; don't
pattern-match on "sounds like an award/record = photo".

Worked example, all three Kane claims reasoned individually:
  - "Kane became the tournament's top scorer" — this happened at one identifiable goal (the goal
    that put him ahead) AND is the kind of milestone press photographers capture separately →
    mediaType: "both".
  - "Kane won the Golden Boot" — a real ceremony/moment (broadcast) that's also routinely
    press-photographed → mediaType: "both".
  - "Kane kept breaking record after record" — genuinely cumulative, no single filmable instant,
    but real photos of him at various record-breaking moments exist → mediaType: "photo".

"photoQuery": set ONLY when mediaType is "photo" or "both". Phrase it as a NEWS-PHOTO-CAPTION
style search (subject + event/context keywords) — e.g. "Harry Kane Golden Boot ceremony 2022",
"Harry Kane World Cup all-time top scorer record". This is explicitly NOT a visual-scene-
description ("a man holding a trophy") — Google Image search indexes real caption and article
text written about the photo, not scene descriptions, so phrase it the way a real news caption or
headline would read.

EDITORIAL B-ROLL EXTENSION — ADDITIVE, DOES NOT REPLACE STEP 2:
mediaType/photoQuery from STEP 2 above still apply in full — judge "video"/"photo"/"both" per
claim exactly as instructed there; do not default to "video" just because b-roll exists as an
option below. In addition, for the video side of any claim, also return
"visualMode":"exact|subject_broll", "eraHint":string|null, "visualGoal":string, and
"youtubeQueries": an array of one or two distinct video searches (the best first). Keep
"youtubeQuery" equal to youtubeQueries[0] for backwards compatibility.

"exact" retains every existing rule: the clip should directly show or document the claim.
"subject_broll" is different: the narration concerns one resolved real subject, while a skilled
editor would use truthful illustrative footage OF THAT SUBJECT to embody an abstract trait, arc,
or compressed period. This is not evidence that an inferred action happened at the narrated
instant, so do not invent high-stakes facts.

Derive subject_broll queries through this mechanism, not fixed trait-to-shot mappings:
1. Identify what the narration needs the visual to communicate.
2. Generate observable manifestations grounded in the subject's real domain, era and story stage:
   recurring behaviour, process, environment, contextual detail, consequence, or contrast.
3. Reject anything introducing an unsupported specific event, person, place, injury, relationship,
   quote, or causal claim.
4. Prefer manifestations likely to be documented in real footage and searchable in titles.
5. Make the searches visually distinct, then retain at most the best two.

Do not select an action because a similar adjective appeared in a prompt example. The same trait
can look completely different for people in different domains; derive the visual from what this
subject actually does and from this particular point in their story.

For subject_broll, resolve the subject and ERA from the whole script context. Every query must
contain the subject plus the strongest available era discriminator: explicit year/event first;
otherwise career stage, age language, team/employer, product generation, location, kit/clothing,
or dated surrounding events. Never return current footage for a childhood/early-career beat just
because current footage is more popular. Diversify the two searches by observable manifestation
or shot function rather than using synonyms.

The optional PLANNED VISUAL fields in the user message came from whole-script segmentation. Treat
them as useful prior reasoning, but correct them when the local context proves them wrong. Exact
claims must never be weakened into b-roll. If uncertain, retain exact behaviour and the original
single youtubeQuery.`;

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

VISUAL MODE matters:
- exact: demand direct support for the stated claim, as above.
- subject_broll: do NOT demand proof of the abstract narration. Instead demand the correct real
  subject, the requested era, and footage plausibly showing the editorial visual goal (training,
  preparation, recovery, isolation, behind-the-scenes work, etc.). Wrong age/team/company era is a
  major mismatch even when the subject is correct. Generic footage without the subject is near 0.

Return strict JSON only, no prose: {"ranking":[{"videoId":"...","score":0-100,"reason":"<=8 words"}]}
Include EVERY candidate exactly once, best first. 0 = unusable, 100 = exactly the clip.`;

const PHOTO_RERANK_PROMPT = `You rank Google Image Search results by how good each is as the real news/press
photo for ONE claim from a video script. You do NOT see the actual pixels — score using the
title, snippet, and source domain only, the same way a researcher would triage search results
before opening them.

You get the claim, its subject, the search query used, and candidates (title, snippet, source
domain). Score each 0-100:
- Relevance: does the title/snippet actually describe a real photo of THIS subject in THIS
  context/event? Off-topic or generic stock-photo-sounding results = near 0.
- Source credibility: strongly prefer results whose domain reads like a real news outlet, sports
  broadcaster, wire service, or official org site over generic content farms, unrelated blogs, or
  social media reposts of unclear origin.
- Specificity: a title/snippet naming the actual event/date/context beats a vague or generic one.

Return strict JSON only, no prose: {"ranking":[{"id":"...","score":0-100,"reason":"<=8 words"}]}
Include EVERY candidate exactly once, best first. 0 = unusable, 100 = exactly the photo needed.`;

export async function onRequestPost(context) {
  const { request, env } = context;

  let segmentText, scriptContext, plannedVisual;
  try {
    const body = await request.json();
    segmentText = body.segmentText;
    scriptContext = body.context;
    plannedVisual = {
      visualMode: body.visualMode,
      visualQueries: body.visualQueries,
      visualGoal: body.visualGoal,
      eraHint: body.eraHint,
    };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!segmentText || !segmentText.trim()) {
    return Response.json({ error: "No segmentText provided" }, { status: 400 });
  }
  if (!env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "ANTHROPIC_API_KEY is not set on this Cloudflare project" }, { status: 500 });
  }

  // 1. Claude splits the moment into claims and resolves each one's intent (see header comment
  //    for why this call site moved off Groq, and for why splitting happens here at all).
  let userContent = scriptContext && scriptContext.trim()
    ? `The script so far (everything before this moment — use it to resolve who/what the moment is about):\n${scriptContext}\n\nThe moment:\n${segmentText}`
    : `The moment:\n${segmentText}`;
  if (plannedVisual && Object.values(plannedVisual).some(Boolean)) {
    userContent += `\n\nPLANNED VISUAL (use as a prior, verify against context):\n${JSON.stringify(plannedVisual)}`;
  }

  let rawClaims;
  try {
    const claudeRes = await claudeChat(env, {
      model: "claude-sonnet-5",
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      // Bumped 4096 -> 8192 (2026-07-19): the answer is now an array of claims instead of one
      // small object, on top of claude-sonnet-5's adaptive thinking sharing the same budget (see
      // _claude.js) — an estimate to re-verify against real usage, not a confirmed-safe number.
      max_tokens: 8192,
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      return Response.json({ error: `Claude error: ${errText}` }, { status: 502 });
    }

    const data = await claudeRes.json();
    const parsed = JSON.parse(extractJson(extractText(data)));
    // Defensive: don't let a malformed/empty model response crash the .map/.forEach below with an
    // unhelpful TypeError — same discipline segment.js applies to its own array response.
    rawClaims = Array.isArray(parsed.claims) ? parsed.claims : [];
  } catch (err) {
    return Response.json({ error: `Intent extraction failed: ${err.message}` }, { status: 502 });
  }

  if (!rawClaims.length) {
    return Response.json({ claims: [] });
  }

  if (!env.YOUTUBE_API_KEY) {
    return Response.json({ error: "YOUTUBE_API_KEY is not set on this Cloudflare project" }, { status: 500 });
  }

  // Normalize each claim's fields once, up front. New planning fields are additive; malformed
  // visualMode/query arrays fall back to the old exact, single-query video behaviour.
  const claims = rawClaims.map((c) => {
    const footageType = c.footageType === "specific" ? "specific" : "generic";
    const quote = footageType === "specific" && c.quote && String(c.quote).trim() ? String(c.quote).trim() : null;
    const mediaType = ["video", "photo", "both"].includes(c.mediaType) ? c.mediaType : "video";
    const visualMode = c.visualMode === "subject_broll" && c.subject ? "subject_broll" : "exact";
    const queryCandidates = [c.youtubeQuery, ...(Array.isArray(c.youtubeQueries) ? c.youtubeQueries : [])]
      .map((q) => String(q || "").trim())
      .filter(Boolean)
      .filter((q, i, all) => all.findIndex((x) => x.toLowerCase() === q.toLowerCase()) === i)
      .slice(0, 2);
    return {
      claim: String(c.claim || segmentText).trim(),
      footageType,
      subject: c.subject || null,
      quote,
      mediaType,
      visualMode,
      visualGoal: c.visualGoal || null,
      eraHint: c.eraHint || null,
      youtubeQueries: queryCandidates,
      youtubeQuery: queryCandidates[0] || c.subject || c.claim || segmentText,
      photoQuery: mediaType !== "video" && c.photoQuery && String(c.photoQuery).trim() ? String(c.photoQuery).trim() : null,
    };
  });

  for (const c of claims) {
    console.log(
      `[evidence-search] claim=${JSON.stringify(c.claim.slice(0, 80))} footageType=${c.footageType} ` +
      `subject=${JSON.stringify(c.subject)} mediaType=${c.mediaType} visualMode=${c.visualMode} eraHint=${JSON.stringify(c.eraHint)} ` +
      `youtubeQueries=${JSON.stringify(c.youtubeQueries)} photoQuery=${JSON.stringify(c.photoQuery)} quote=${JSON.stringify(c.quote)}`
    );
  }

  // 2. Fan out to a search task per claim x medium, run them ALL concurrently through one flat
  //    Promise.all (matching reference-search.js's "never-throwing pipelines, no rejected-promise
  //    branch to handle" pattern), then reassemble by claim index.
  const tasks = [];
  claims.forEach((claim, i) => {
    if (claim.mediaType === "video" || claim.mediaType === "both") {
      tasks.push({ i, medium: "video", promise: searchVideoForClaim(claim, env) });
    }
    if (claim.mediaType === "photo" || claim.mediaType === "both") {
      tasks.push({ i, medium: "photo", promise: searchPhotoForClaim(claim, env) });
    }
  });
  const results = await Promise.all(tasks.map((t) => t.promise));
  const videoByClaim = new Map();
  const photoByClaim = new Map();
  tasks.forEach((t, idx) => (t.medium === "video" ? videoByClaim : photoByClaim).set(t.i, results[idx]));

  const responseClaims = claims.map((claim, i) => ({
    claim: claim.claim,
    footageType: claim.footageType,
    subject: claim.subject,
    quote: claim.quote,
    mediaType: claim.mediaType,
    visualMode: claim.visualMode,
    visualGoal: claim.visualGoal,
    eraHint: claim.eraHint,
    videoCandidates: videoByClaim.get(i) || [],
    photoCandidates: photoByClaim.get(i) || [],
  }));

  return Response.json({ claims: responseClaims });
}

// Runs the full YouTube pipeline (search -> enrich -> rerank -> filter -> top 5) for ONE claim.
// NEVER throws — resolves to [] on any failure, so it can run alongside searchPhotoForClaim() via
// a plain Promise.all with no rejected-promise case either caller needs to handle.
async function searchVideoForClaim(claim, env) {
  try {
    const queries = (claim.youtubeQueries && claim.youtubeQueries.length
      ? claim.youtubeQueries
      : [claim.youtubeQuery || claim.subject || claim.claim]).slice(0, 2);
    // search.list is 100 quota units against a shared 10,000/day cap, and a segment can now split
    // into several claims — firing every claim's second query unconditionally multiplies that cost
    // for no benefit on the common case where the first query already returns plenty. Only spend
    // the second query's quota as a bounded fallback when the first genuinely came up thin.
    let candidates = await searchYouTubeVideos(queries[0], env.YOUTUBE_API_KEY).catch(() => []);
    if (candidates.length < 4 && queries[1]) {
      const more = await searchYouTubeVideos(queries[1], env.YOUTUBE_API_KEY).catch(() => []);
      candidates = candidates.concat(more).filter(
        (c, i, all) => all.findIndex((x) => x.videoId === c.videoId) === i
      );
    }
    candidates = candidates.slice(0, 20);
    await enrichCandidates(candidates, env.YOUTUBE_API_KEY);
    // Rerank against the CLAIM's own text, not the whole multi-claim segment — a candidate is
    // being scored against one specific fact, not the whole beat.
    const reranked = await rerankCandidates(
      {
        segmentText: claim.claim,
        subject: claim.subject,
        footageType: claim.footageType,
        quote: claim.quote,
        visualMode: claim.visualMode,
        visualGoal: claim.visualGoal,
        eraHint: claim.eraHint,
      },
      candidates,
      env
    );
    candidates.sort((a, b) => (b.score || 0) - (a.score || 0));
    const filtered = reranked ? candidates.filter((c) => (c.score || 0) >= MIN_RERANK_SCORE) : candidates;
    return filtered.slice(0, 5).map((c) => ({ ...c, url: `https://www.youtube.com/watch?v=${c.videoId}` }));
  } catch (err) {
    console.log(`[evidence-search] video pipeline failed for claim ${JSON.stringify(claim.claim.slice(0, 60))}: ${err.message}`);
    return [];
  }
}

// Runs the full Google Custom Search (image mode) pipeline for ONE claim. NEVER throws — resolves
// to [] on any failure (missing keys, network/parse error, no results), same contract as
// reference-search.js's searchPexelsReaction — photo only broadens this endpoint, so a missing/
// misconfigured GOOGLE_CSE_API_KEY/GOOGLE_CSE_ID degrades a claim to video-only instead of failing
// the whole request.
async function searchPhotoForClaim(claim, env) {
  if (!env.GOOGLE_CSE_API_KEY || !env.GOOGLE_CSE_ID) {
    console.log(`[evidence-search] GOOGLE_CSE_API_KEY/GOOGLE_CSE_ID not set, skipping photo search for claim ${JSON.stringify(claim.claim.slice(0, 60))}`);
    return [];
  }
  try {
    const query = (claim.photoQuery || claim.subject || claim.claim).trim();
    const candidates = await searchPhotoEvidence(query, env.GOOGLE_CSE_API_KEY, env.GOOGLE_CSE_ID);
    if (!candidates.length) return [];
    const reranked = await rerankPhotoCandidates(
      { claim: claim.claim, subject: claim.subject, query },
      candidates,
      env
    );
    candidates.sort((a, b) => (b.score || 0) - (a.score || 0));
    const filtered = reranked ? candidates.filter((c) => (c.score || 0) >= MIN_RERANK_SCORE) : candidates;
    return filtered.slice(0, 5);
  } catch (err) {
    console.log(`[evidence-search] photo pipeline failed for claim ${JSON.stringify(claim.claim.slice(0, 60))}: ${err.message}`);
    return [];
  }
}

// Google Custom Search JSON API, image mode. 10 is the API's documented per-request cap (smaller
// than YouTube's 12 — don't ask for more, it's not honored). Google CSE items carry no natural
// stable identifier the way YouTube (videoId) or Pexels (id) do, so `id` here is a request-scoped
// index — never persisted, only used to correlate the rerank's ranking response back to a
// candidate within this one response cycle.
export async function searchPhotoEvidence(query, apiKey, cx) {
  const url =
    "https://www.googleapis.com/customsearch/v1" +
    `?key=${apiKey}&cx=${cx}&q=${encodeURIComponent(query)}&searchType=image&num=10&safe=off`;
  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google CSE error: ${errText}`);
  }
  const data = await res.json();
  return (data.items || []).map((item, i) => ({
    id: `photo-${i}`,
    title: item.title || "",
    snippet: item.snippet || "",
    displayLink: item.displayLink || "",
    thumb: item.image?.thumbnailLink || "",
    sourceLink: item.image?.contextLink || item.link,
    imageUrl: item.link || "",
  }));
}

// Scores each photo candidate 0-100 against the claim, writing c.score / c.reason in place.
// Mirrors rerankCandidates's shape/contract exactly (same Groq model, same boolean-return
// contract so callers can tell a real 0 apart from "rerank didn't run") but scores by
// title/snippet/displayLink domain credibility, since raw pixels aren't inspected.
export async function rerankPhotoCandidates(intent, candidates, env) {
  if (candidates.length <= 1 || !env.GROQ_API_KEY) return false;
  const list = candidates.map((c) => ({ id: c.id, title: c.title, snippet: c.snippet, displayLink: c.displayLink }));
  const user =
    `CLAIM: ${intent.claim}\n` +
    `SUBJECT: ${intent.subject || "(none)"}\n` +
    `QUERY: ${intent.query}\n` +
    `\nCANDIDATES:\n${JSON.stringify(list)}`;
  try {
    const res = await groqChat(env, {
      model: "openai/gpt-oss-20b",
      messages: [
        { role: "system", content: PHOTO_RERANK_PROMPT },
        { role: "user", content: user },
      ],
      temperature: 0,
    });
    if (!res.ok) return false;
    const data = await res.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}");
    const ranking = Array.isArray(parsed.ranking) ? parsed.ranking : [];
    const byId = new Map(ranking.map((r) => [r.id, r]));
    for (const c of candidates) {
      const r = byId.get(c.id);
      c.score = r ? Math.max(0, Math.min(100, Number(r.score) || 0)) : 0;
      c.reason = r ? String(r.reason || "").slice(0, 60) : "";
    }
    return true;
  } catch {
    return false; // best-effort: leave candidates unscored, original order preserved
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
    `VISUAL MODE: ${intent.visualMode || "exact"}\n` +
    (intent.visualGoal ? `EDITORIAL VISUAL GOAL: ${intent.visualGoal}\n` : "") +
    (intent.eraHint ? `REQUIRED ERA: ${intent.eraHint}\n` : "") +
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
