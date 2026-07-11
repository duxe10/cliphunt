// Evidence pipeline, step 1: turn one "evidence" segment into a short list of real
// YouTube candidates plus a signed authorization for the worker's /match step.
//
// Split of responsibilities (see HANDOFF.md): the smart/cheap work (LLM intent + YouTube
// Data API search) lives here as a Netlify function reusing segment.js's Groq call shape.
// The heavy binary work (caption fetch, trim, download) lives on a separate worker service
// that this hands off to. The shared secret WORKER_TOKEN never reaches the browser — it's
// only used here to HMAC-sign the exact (videoIds, quote) the worker is allowed to /match.
const crypto = require("crypto");

const SYSTEM_PROMPT = `You extract search intent from ONE moment of a video script so a tool
can find real footage of the actual person or event referenced.

Return strict JSON only, no prose, no markdown fences:
{"subject":"...","claim":"...","quote":"...","youtubeQuery":"..."}

- "subject": the specific real person, org, or event the moment is about (e.g. "Harry Kane",
  "Elon Musk", "2022 World Cup final"). This is who/what the footage should show.
- "claim": a short plain-language description of what they said or did in this moment.
- "quote": if the script quotes or closely paraphrases something the subject actually SAID,
  put the verbatim-ish phrase here (this is what gets matched against video captions to find
  the exact timestamp). If the script only describes an action or paraphrases loosely rather
  than quoting words, set "quote" to null — do NOT invent a quote.
- "youtubeQuery": the best 3-6 word YouTube search to surface footage of this moment. Combine
  the subject with the most distinguishing keywords from the claim (e.g.
  "Harry Kane penalty miss France"). Prefer terms likely to appear in a real video title.`;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let segmentText, context;
  try {
    ({ segmentText, context } = JSON.parse(event.body || "{}"));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  if (!segmentText || !segmentText.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: "No segmentText provided" }) };
  }

  if (!process.env.GROQ_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "GROQ_API_KEY is not set on this Netlify site" }) };
  }
  if (!process.env.YOUTUBE_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "YOUTUBE_API_KEY is not set on this Netlify site" }) };
  }
  if (!process.env.WORKER_TOKEN) {
    return { statusCode: 500, body: JSON.stringify({ error: "WORKER_TOKEN is not set on this Netlify site" }) };
  }

  // 1. Groq extracts intent — reuses segment.js's model + call shape + JSON-object mode.
  const userContent = context
    ? `Whole script (for subject context):\n${context}\n\nThe moment to search for:\n${segmentText}`
    : segmentText;

  let intent;
  try {
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
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
      return { statusCode: 502, body: JSON.stringify({ error: `Groq error: ${errText}` }) };
    }

    const data = await groqRes.json();
    intent = JSON.parse(data.choices?.[0]?.message?.content || "{}");
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: `Intent extraction failed: ${err.message}` }) };
  }

  const query = (intent.youtubeQuery || intent.subject || segmentText).trim();
  const quote = intent.quote && String(intent.quote).trim() ? String(intent.quote).trim() : null;

  // 2. YouTube Data API search.list — 100 quota units/call (~100/day on the free tier).
  let candidates;
  try {
    const url =
      "https://www.googleapis.com/youtube/v3/search" +
      `?part=snippet&type=video&maxResults=5&safeSearch=none` +
      `&q=${encodeURIComponent(query)}&key=${process.env.YOUTUBE_API_KEY}`;
    const res = await fetch(url);

    if (!res.ok) {
      const errText = await res.text();
      return { statusCode: 502, body: JSON.stringify({ error: `YouTube error: ${errText}` }) };
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
    return { statusCode: 502, body: JSON.stringify({ error: `YouTube search failed: ${err.message}` }) };
  }

  // 3. Sign the exact (videoIds, quote) the worker is allowed to /match. Short-lived so a
  //    leaked payload can't be replayed indefinitely; the worker recomputes this HMAC.
  const exp = Math.floor(Date.now() / 1000) + 600; // 10 min
  const videoIds = candidates.map((c) => c.videoId);
  const matchSig = signMatch(videoIds, quote, exp, process.env.WORKER_TOKEN);

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subject: intent.subject || null, quote, exp, matchSig, candidates }),
  };
};

// Canonical string the worker must reproduce byte-for-byte: sorted videoIds so order can't
// change the signature, then quote (empty string when null), then expiry.
function signMatch(videoIds, quote, exp, secret) {
  const payload = `${[...videoIds].sort().join(",")}|${quote || ""}|${exp}`;
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}
