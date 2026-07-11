const SYSTEM_PROMPT = `You break a video script into distinct moments for a clip-matching tool.
Each segment should be something a video editor would treat as a single cut decision —
not just a run of separate sentences with a segment boundary at every full stop.

Rules for where segments start and end:
1. Default to a new segment for every complete, standalone sentence or idea — even if it's
   topically related to the sentence before it. Two sentences that are each grammatically
   complete on their own are almost always two separate segments.
2. The ONLY reason to merge two sentences into one segment is when the second is
   grammatically incomplete without the first — an unfinished clause, or a segment that
   would otherwise end in an ellipsis ("...") or em-dash ("—") that continues into the next
   sentence. Never merge two complete, independent sentences just because they're on the
   same general topic.
3. These patterns ALWAYS start a new segment, never merge across them: "but then", "however",
   "until", "next thing I knew", "and then suddenly", and general-to-specific pivots like
   "For most people, X. For [subject], Y." — the second half is a deliberate contrast, not
   a continuation, even though it's topically related.
4. Exception: short parallel/rhythmic lines that are clearly one rhetorical device (e.g. a
   rapid-fire list like "Every tournament. Every season. Every setback.") may be grouped into
   a single segment — but only when each line is a fragment of the same device, not when each
   is its own complete, independent statement.

Do not paraphrase — each segment's "text" must be an exact substring of the original script,
in order, covering the whole script.

For each segment, also pick one "family":
- "feel" — a pure emotional beat (surprise, disappointment, hype, etc), no specific referent
- "evidence" — references a specific real person/thing that said or did something
- "reference" — matches a known meme/cultural callback
- "nothing" — pacing beat or transition, no clip needed

If family is "feel" or "reference", also include a "query": a short 1-2 word term for
searching a reaction-gif site. Reaction-gif search is tag-based and matches short, common
words — not clever specific phrases (a phrase like "finally believing again" matches almost
nothing and returns generic junk, whereas "hope" or "relief" returns real reaction gifs).
So pick the single most-searchable common reaction word (or a two-word combo at most) that
best fits THIS segment: e.g. "heartbreak", "nervous", "hype", "shocked", "relief". Vary the
word across segments so different beats don't all collapse to the same term.

Avoid ambiguous words whose most common meaning on a gif site is a specific holiday, event,
or community unrelated to the beat — those return off-topic results. In particular do NOT
use "proud" for an achievement/success beat (on gif sites "proud" overwhelmingly returns
Pride-month content); use an unambiguous reaction word like "impressed", "amazed", or
"standing ovation" instead. Same idea for other loaded single words — prefer the plain
reaction over the word that a platform has repurposed.

For "nothing"/"evidence" segments, omit "query".

Return strict JSON only, no prose, no markdown fences:
{"segments":[{"text":"...","family":"feel","query":"..."}]}`;
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let script;
  try {
    ({ script } = JSON.parse(event.body || "{}"));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  if (!script || !script.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: "No script provided" }) };
  }

  if (!process.env.GROQ_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "GROQ_API_KEY is not set on this Netlify site" }) };
  }

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
          { role: "user", content: script },
        ],
        temperature: 0.3,
        response_format: { type: "json_object" },
      }),
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      return { statusCode: 502, body: JSON.stringify({ error: `Groq error: ${errText}` }) };
    }

    const data = await groqRes.json();
    const content = data.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(content);

    if (!Array.isArray(parsed.segments)) {
      return { statusCode: 502, body: JSON.stringify({ error: "Model did not return a segments array" }) };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ segments: mergeFragments(parsed.segments) }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// The model is unreliable at enforcing "don't split incomplete fragments" on its own
// (it's a smaller/faster free model, and that rule fights against "split by default").
// This pattern is mechanically checkable, so catch it in code instead of hoping the
// prompt holds: a segment starting with an ellipsis, a dash, or a lowercase continuation
// word is never a real segment boundary — merge it into the previous one.
const FRAGMENT_START = /^(\.\.\.|—)/;
const HANGING_END = /—\s*$/;

function mergeFragments(segments) {
  const merged = [];
  for (const seg of segments) {
    const text = (seg.text || "").trim();
    const prev = merged[merged.length - 1];
    const isContinuation = prev && (FRAGMENT_START.test(text) || HANGING_END.test(prev.text));
    if (isContinuation) {
      prev.text = `${prev.text} ${text}`;
      continue;
    }
    merged.push({ ...seg, text });
  }
  return merged;
}
