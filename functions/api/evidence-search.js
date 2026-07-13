// Cloudflare Pages Function — POST /api/evidence-search
// Ported from netlify/functions/evidence-search.js. Two ported concerns vs the Netlify version:
//   1. Netlify handler -> Pages onRequestPost; process.env -> env (threaded into helpers).
//   2. Node crypto.createHmac -> WebCrypto crypto.subtle in signMatch. Output is byte-identical
//      hex, so the Render worker (Node) recomputes the same signature — do not change the payload.
// "generic" beats (a category statement, not one identifiable person/event) skip the YouTube/
// worker pipeline entirely and route to clean licensed Pexels b-roll instead — see the branch
// right after intent extraction below.
import { mapPexelsVideo } from "./stock-search.js";
const SYSTEM_PROMPT = `You extract search intent from ONE moment of a video script ("the moment") so a tool can find
real footage for it. You are given the script SO FAR (everything before the moment) to work out
who or what it is about.

Return strict JSON only, no prose, no markdown fences:
{"footageType":"specific|generic","subject":"...","quote":"...","youtubeQuery":"..."}

Decide "footageType":

- "specific": the moment shows a PARTICULAR real person, team, org, or event doing or saying a
  particular thing. The subject can come from either place:
  (a) named or clearly referred to in the moment itself ("Harry Kane missed a penalty"); or
  (b) NOT named in the moment because it is a fragment or shorthand for a specific event the
      preceding script is about — then resolve the subject from that earlier context.
      Example: after "...one moment continues to define his World Cup legacy.", the moment
      "A missed penalty." means HIM missing THAT penalty, so subject = the person the story is
      about (e.g. "Harry Kane") and youtubeQuery = "Harry Kane missed penalty France 2022".
  "subject" = that entity. "youtubeQuery" = subject + the distinguishing keywords (event,
  opponent, year) most likely to appear in a real video's title.

- "generic": the moment is a self-contained GENERAL statement true of a whole category, not one
  identifiable instance — usually signalled by quantifiers like "most", "every", "people",
  "everyone", or a general truth ("For most footballers, scoring at a World Cup is the highlight
  of their career"). Do NOT attach the video's main character to these. "subject" = the general
  concept; "youtubeQuery" = a plain descriptive footage search with NO specific person's name
  ("World Cup goal celebration"). Set "quote" to null.

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

"youtubeQuery": 3-6 words, the best real YouTube search to surface this footage.`;

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
  if (!env.GROQ_API_KEY) {
    return Response.json({ error: "GROQ_API_KEY is not set on this Cloudflare project" }, { status: 500 });
  }

  // 1. Groq extracts intent.
  const userContent = scriptContext && scriptContext.trim()
    ? `The script so far (everything before this moment — use it to resolve who/what the moment is about):\n${scriptContext}\n\nThe moment:\n${segmentText}`
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

  const query = (intent.youtubeQuery || intent.subject || segmentText).trim();
  const footageType = intent.footageType === "specific" ? "specific" : "generic";
  const quote =
    footageType === "specific" && intent.quote && String(intent.quote).trim()
      ? String(intent.quote).trim()
      : null;

  // Generic beats (category statements, no one identifiable person/event) skip YouTube/the
  // worker entirely — clean licensed Pexels b-roll is a better (and copyright-safe) fit, and
  // needs no HMAC signing since there's no worker call to authorize.
  if (footageType === "generic") {
    if (!env.PEXELS_API_KEY) {
      return Response.json({ error: "PEXELS_API_KEY is not set on this Cloudflare project" }, { status: 500 });
    }
    try {
      const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=8&orientation=landscape`;
      const res = await fetch(url, { headers: { Authorization: env.PEXELS_API_KEY } });
      if (!res.ok) {
        const errText = await res.text();
        return Response.json({ error: `Pexels error: ${errText}` }, { status: 502 });
      }
      const data = await res.json();
      const clips = (data.videos || []).map((v) => mapPexelsVideo(v)).filter((c) => c && c.downloadUrl);
      return Response.json({ footageType, source: "stock", subject: intent.subject || null, clips });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  if (!env.YOUTUBE_API_KEY) {
    return Response.json({ error: "YOUTUBE_API_KEY is not set on this Cloudflare project" }, { status: 500 });
  }
  if (!env.WORKER_TOKEN) {
    return Response.json({ error: "WORKER_TOKEN is not set on this Cloudflare project" }, { status: 500 });
  }

  // 2. YouTube Data API search.list (fetch 10 to rerank from).
  let candidates;
  try {
    const url =
      "https://www.googleapis.com/youtube/v3/search" +
      `?part=snippet&type=video&maxResults=10&safeSearch=none` +
      `&q=${encodeURIComponent(query)}&key=${env.YOUTUBE_API_KEY}`;
    const res = await fetch(url);

    if (!res.ok) {
      const errText = await res.text();
      return Response.json({ error: `YouTube error: ${errText}` }, { status: 502 });
    }

    const data = await res.json();
    candidates = (data.items || [])
      .filter((it) => it.id && it.id.videoId)
      .map((it) => ({
        videoId: it.id.videoId,
        title: it.snippet?.title || "",
        channel: it.snippet?.channelTitle || "",
        thumb: it.snippet?.thumbnails?.medium?.url || it.snippet?.thumbnails?.default?.url || "",
      }));
  } catch (err) {
    return Response.json({ error: `YouTube search failed: ${err.message}` }, { status: 502 });
  }

  // 2b/2c. Enrich with quality signals, then LLM re-rank against the beat's intent. Both
  //        best-effort — on failure candidates keep YouTube's order. Keep the best 5.
  await enrichCandidates(candidates, env.YOUTUBE_API_KEY);
  await rerankCandidates({ segmentText, subject: intent.subject, footageType, quote }, candidates, env);
  candidates.sort((a, b) => (b.score || 0) - (a.score || 0));
  const top = candidates.slice(0, 5);

  // 3. Sign the exact (videoIds, quote) the worker is allowed to /match.
  const exp = Math.floor(Date.now() / 1000) + 600; // 10 min
  const videoIds = top.map((c) => c.videoId);
  const matchSig = await signMatch(videoIds, quote, exp, env.WORKER_TOKEN);

  return Response.json({ subject: intent.subject || null, footageType, quote, exp, matchSig, candidates: top });
}

// HMAC-SHA256 over the canonical string, hex-encoded. WebCrypto here produces the exact same
// hex as the Render worker's Node crypto.createHmac(...).digest("hex") — keep the payload identical.
async function signMatch(videoIds, quote, exp, secret) {
  const payload = `${[...videoIds].sort().join(",")}|${quote || ""}|${exp}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Adds duration/views/description onto each candidate via one videos.list call (1 quota unit).
async function enrichCandidates(candidates, apiKey) {
  const ids = candidates.map((c) => c.videoId).filter(Boolean).join(",");
  if (!ids) return;
  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics,snippet&id=${ids}&key=${apiKey}`
    );
    if (!res.ok) return;
    const data = await res.json();
    const byId = new Map((data.items || []).map((it) => [it.id, it]));
    for (const c of candidates) {
      const it = byId.get(c.videoId);
      if (!it) continue;
      c.durationSec = parseIsoDuration(it.contentDetails && it.contentDetails.duration);
      c.views = Number(it.statistics && it.statistics.viewCount) || 0;
      c.description = (it.snippet && it.snippet.description ? it.snippet.description : "").slice(0, 160);
    }
  } catch {
    /* best-effort */
  }
}

// "PT1H2M3S" -> seconds. null on anything unparseable.
function parseIsoDuration(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
  if (!m) return null;
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
}

// Scores each candidate 0-100 against the beat's intent, writing c.score / c.reason in place.
async function rerankCandidates(intent, candidates, env) {
  if (candidates.length <= 1 || !env.GROQ_API_KEY) return;
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
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: RERANK_PROMPT },
          { role: "user", content: user },
        ],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}");
    const ranking = Array.isArray(parsed.ranking) ? parsed.ranking : [];
    const byId = new Map(ranking.map((r) => [r.videoId, r]));
    for (const c of candidates) {
      const r = byId.get(c.videoId);
      c.score = r ? Math.max(0, Math.min(100, Number(r.score) || 0)) : 0;
      c.reason = r ? String(r.reason || "").slice(0, 60) : "";
    }
  } catch {
    /* best-effort: leave candidates unscored, original order preserved */
  }
}
