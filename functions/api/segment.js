// Cloudflare Pages Function — POST /api/segment
// Ported from netlify/functions/segment.js (Netlify handler -> Pages onRequestPost,
// process.env -> context.env). Prompt + mergeFragments logic is unchanged.
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
- "evidence" — needs a REAL-WORLD illustrative visual. Either (a) ONE specific real person/thing
  that said or did something, or (b) a general statement about a CATEGORY of people/things doing
  or experiencing something concrete ("most footballers", "everyone who's tried it") — even with
  no single person named, real footage of that KIND of moment exists and should be found.
  Example: "For most footballers, scoring at a World Cup is the highlight of their career" is
  "evidence" (needs real footage of players scoring/celebrating) — do NOT call this "nothing"
  just because it doesn't name one player. Ask whether real footage of that kind of moment
  exists; if yes, it's "evidence", named person or not.
- "reference" — matches a known meme/cultural callback
- "nothing" — GENUINELY has no visual content of its own: connective narration, a meta aside, a
  setup clause that only makes sense combined with the next segment's visual. If a sentence
  describes any real-world action, scene, or moment — named person or not — it is NOT "nothing".

If family is "feel", also include a "source": "stock" or "gif", deciding which kind of clip
this beat wants:
- "stock" — the beat is PURE atmosphere or mood/setting, with no notable action by real people:
  a place, a feeling of time or weather (rain on a window, a city at night, a sunrise, an empty
  stadium, hands typing). If the beat describes people DOING something specific and real — even
  a general category of people ("footballers celebrating a goal") — that's "evidence", not
  "stock"; see the evidence family definition above. For "stock", "query" is a SHORT DESCRIPTIVE
  VISUAL SCENE PHRASE, 2-5 words ("stormy sky timelapse", "empty stadium night", "city traffic
  time lapse") — describe the shot, not a reaction word.
- "gif" — the beat is a comedic or emotional REACTION PUNCH that a looping reaction clip nails
  (shock, celebration, facepalm, disbelief). For "gif", "query" stays a short 1-2 word reaction
  term per the rules below.

If family is "feel" with source "gif", include a "query": a short 1-2 word term for searching a
reaction-gif site. Reaction-gif search is tag-based and matches short, common words — not clever
specific phrases (a phrase like "finally believing again" matches almost nothing and returns
generic junk, whereas "hope" or "relief" returns real reaction gifs). So pick the single
most-searchable common reaction word (or a two-word combo at most) that best fits THIS segment:
e.g. "heartbreak", "nervous", "hype", "shocked", "relief". Vary the word across segments so
different beats don't all collapse to the same term.

Avoid ambiguous words whose most common meaning on a gif site is a specific holiday, event,
or community unrelated to the beat — those return off-topic results. In particular do NOT
use "proud" for an achievement/success beat (on gif sites "proud" overwhelmingly returns
Pride-month content); use an unambiguous reaction word like "impressed", "amazed", or
"standing ovation" instead. Same idea for other loaded single words — prefer the plain
reaction over the word that a platform has repurposed.

For "nothing"/"evidence"/"reference" segments, omit "query" and "source" — both are resolved
downstream by their own dedicated search step, not by this pass.

Return strict JSON only, no prose, no markdown fences:
{"segments":[{"text":"...","family":"feel","query":"...","source":"stock"}]}`;

// Second pass, run once per script (not per click): for evidence/reference segments only,
// resolve "what is actually happening in this moment" using everything narrated before it —
// pronouns and elliptical references sorted out ("A missed penalty." -> "Harry Kane misses a
// penalty against France"). This used to be re-derived on every "Find footage" click from a raw
// concatenation of preceding sentence text, inside the same prompt that ALSO had to classify
// footageType and write a search query — asking one call to both understand the scene AND act
// on it. Doing the understanding here instead, once, with the whole script actually in view,
// gives evidence-search.js/reference-search.js a clean input instead of a sentence dump, so
// their own prompts can focus purely on turning an already-understood moment into a query.
const NARRATE_PROMPT = `You are given a video script already broken into ordered, numbered
segments. For EACH segment listed under "RESOLVE THESE", write one short, plain-language
sentence describing exactly what is happening in that moment — with every pronoun, "he"/"they"/
vague reference, or fragment resolved into the specific real person/thing/event it refers to.

Resolve using ONLY the segments that come BEFORE the one you're resolving (the "story so far" —
never use a later segment, since a viewer hasn't seen it yet at this point in the video). If a
segment is genuinely a general statement about a category rather than one specific person/event,
say so plainly rather than forcing a specific subject onto it.

Example: script narrates a player's missed World Cup penalty across several lines, then a later
segment just says "A missed penalty." -> resolve that to "The player misses the penalty against
[opponent], the moment the earlier narration was building to" (using the actual name/opponent
from context), not a generic restatement.

Return strict JSON only, no prose, no markdown fences:
{"resolved":[{"i":0,"context":"..."}]}
Include an entry for every index listed under "RESOLVE THESE", in any order.`;

// Only evidence/reference segments actually consume this context downstream, and feeding the
// model fewer segments to resolve keeps the call cheap — but it still needs ALL segments (not
// just the ones being resolved) as input, since earlier "feel"/"nothing" beats can carry the
// context a later evidence beat depends on.
async function narrateSegments(segments, env) {
  const targets = segments.map((s, i) => ({ s, i })).filter(({ s }) => s.family === "evidence" || s.family === "reference");
  if (!targets.length) return segments;

  const script = segments.map((s, i) => `[${i}] ${s.text}`).join("\n");
  const userContent = `FULL SCRIPT, IN ORDER:\n${script}\n\nRESOLVE THESE: ${targets.map((t) => t.i).join(", ")}`;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: NARRATE_PROMPT },
          { role: "user", content: userContent },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) return segments; // best-effort: evidence-search.js falls back to raw context

    const data = await res.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}");
    const resolved = Array.isArray(parsed.resolved) ? parsed.resolved : [];
    const byIdx = new Map(resolved.map((r) => [r.i, r.context]));
    return segments.map((s, i) => (byIdx.has(i) ? { ...s, context: String(byIdx.get(i) || "").trim() } : s));
  } catch {
    return segments; // network/parse failure — ship without precomputed context, not a hard fail
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let script;
  try {
    ({ script } = await request.json());
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!script || !script.trim()) {
    return Response.json({ error: "No script provided" }, { status: 400 });
  }
  if (!env.GROQ_API_KEY) {
    return Response.json({ error: "GROQ_API_KEY is not set on this Cloudflare project" }, { status: 500 });
  }

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
          { role: "user", content: script },
        ],
        temperature: 0.3,
        response_format: { type: "json_object" },
      }),
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      return Response.json({ error: `Groq error: ${errText}` }, { status: 502 });
    }

    const data = await groqRes.json();
    const content = data.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(content);

    if (!Array.isArray(parsed.segments)) {
      return Response.json({ error: "Model did not return a segments array" }, { status: 502 });
    }

    const merged = mergeFragments(parsed.segments);
    const withContext = await narrateSegments(merged, env);
    return Response.json({ segments: withContext });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// The model is unreliable at enforcing "don't split incomplete fragments" on its own, so this
// mechanically-checkable rule is enforced in code: a segment starting with an ellipsis or dash,
// or following a segment ending in a dangling dash, is merged into the previous one.
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
