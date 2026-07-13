// Cloudflare Pages Function — POST /api/reference-search
// `reference` beats ("matches a known meme/cultural callback") used to search Giphy — a tag-based
// reaction-gif index that can't represent an actual NAMED meme and skews to old evergreen gifs.
// This reuses the evidence pipeline instead: the pipeline only ever operated on {videoId, quote}
// pairs, not "real event" semantics, so a differently-tuned intent + rerank prompt is enough to
// repoint it at "find the iconic clip of THIS meme" rather than "find real footage of THIS event".
// Always the video path (no generic/stock fallback) — memes here are real downloadable YouTube
// clips only. Same HMAC-signed worker /match, and sign-clip.js's manual trim, with zero changes.
import { searchYouTubeVideos, enrichCandidates, rerankCandidates, signMatch } from "./evidence-search.js";

const SYSTEM_PROMPT = `You extract the specific internet meme referenced by ONE moment of a video script
("the moment") so a tool can find that meme's actual iconic video clip on YouTube. You are given
the script SO FAR (everything before the moment) to resolve an implicit reference.

Return strict JSON only, no prose, no markdown fences:
{"memeName":"...","youtubeQuery":"...","quote":"..."}

"memeName": the specific, well-known named meme this moment is calling back to — either explicit
in the text ("he did the surprised Pikachu face") or clearly implied by a widely recognized meme
format/phrase ("everyone's jaw hit the floor" -> not a meme; "it's the Roman Empire thing again"
-> "Do you think about the Roman Empire" meme). If you cannot confidently name ONE specific,
genuinely well-known meme — the moment is just a generic reaction, not a callback to a named
meme — set "memeName" to null and leave the other fields empty strings.

"youtubeQuery": 3-6 words, the best real YouTube search to surface that meme's original or most
iconic/well-known clip (e.g. "surprised pikachu meme original", "stonks meme original video").

Set "quote" ONLY when the meme is built around an exact well-known spoken or on-screen line that
would appear in captions (e.g. "IT'S OVER 9000!", "this is fine"). Most memes are NOT quote-based
(they're a reaction, a face, a moment) — set "quote" to null far more often than not. Never invent
a quote that isn't actually part of the meme's recognized text.`;

const RERANK_PROMPT = `You rank YouTube search results by how well each serves as THE clip to cut to for
a specific named internet meme reference in a video script. Unlike looking for real event footage,
what matters here is RECOGNIZABILITY — is this genuinely the meme's iconic source clip or a
well-known compilation of it, something a viewer would immediately recognize as "that meme" -
not just a video that happens to match the search keywords.

You get the meme name, the moment it's being used for, and candidates (title, channel, duration
in seconds, view count, short description). Score each 0-100:
- Recognizability: does this show the actual meme moment/format people know, vs an unrelated or
  tangential video? Off-topic or generic content = near 0.
- Virality as a quality signal: prefer widely-viewed, well-known uploads over obscure reuploads —
  high view count here is evidence the clip IS the recognized meme source, not just noise.
- Fit: a short, focused clip of the meme moment beats a long unrelated video that only mentions it.

Return strict JSON only, no prose: {"ranking":[{"videoId":"...","score":0-100,"reason":"<=8 words"}]}
Include EVERY candidate exactly once, best first. 0 = unusable, 100 = exactly the meme's clip.`;

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

  // 1. Groq identifies the specific meme being referenced.
  const userContent = scriptContext && scriptContext.trim()
    ? `The script so far (everything before this moment — use it to resolve an implicit reference):\n${scriptContext}\n\nThe moment:\n${segmentText}`
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

  const memeName = intent.memeName && String(intent.memeName).trim() ? String(intent.memeName).trim() : null;
  if (!memeName) {
    // No specific, confidently-named meme — fail gracefully to the same empty-candidates state
    // findFootage() already handles ("No footage candidates found for this moment.").
    return Response.json({ subject: null, quote: null, candidates: [] });
  }

  const query = (intent.youtubeQuery || memeName).trim();
  const quote = intent.quote && String(intent.quote).trim() ? String(intent.quote).trim() : null;

  // 2. YouTube search + enrich + rerank — same helpers evidence-search.js uses, just with this
  //    file's own meme-recognizability rerank rubric.
  let candidates;
  try {
    candidates = await searchYouTubeVideos(query, env.YOUTUBE_API_KEY);
  } catch (err) {
    return Response.json({ error: err.message }, { status: 502 });
  }

  await enrichCandidates(candidates, env.YOUTUBE_API_KEY);
  await rerankCandidates({ segmentText, subject: memeName, footageType: "meme", quote }, candidates, env, RERANK_PROMPT);
  candidates.sort((a, b) => (b.score || 0) - (a.score || 0));
  const top = candidates.slice(0, 5);

  // 3. Sign the exact (videoIds, quote) the worker is allowed to /match — identical mechanism to
  //    evidence-search.js, the worker has no notion of "evidence" vs "reference".
  const exp = Math.floor(Date.now() / 1000) + 600; // 10 min
  const videoIds = top.map((c) => c.videoId);
  const matchSig = await signMatch(videoIds, quote, exp, env.WORKER_TOKEN);

  return Response.json({ subject: memeName, quote, exp, matchSig, candidates: top });
}
