// Cloudflare Pages Function — POST /api/segment
// Ported from netlify/functions/segment.js (Netlify handler -> Pages onRequestPost,
// process.env -> context.env). Prompt + mergeFragments logic is unchanged.
import { groqChat } from "./_groq.js";

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
   rapid-fire list like "Every attempt. Every setback. Every retry." — deliberately vague, works
   for a startup story, a sports story, a science story, anything) may be grouped into a single
   segment — but only when each line is a fragment of the same device, not when each is its own
   complete, independent statement.

Do not paraphrase — each segment's "text" must be an exact substring of the original script,
in order, covering the whole script.

For each segment, also pick one "family":
- "feel" — EITHER a pure emotional beat (surprise, disappointment, hype, etc, no specific
  referent), OR pure atmosphere/mood/scene-setting — including ordinary background human activity
  that has no narrative significance of its own (rain on a window, a city at night, a sunrise,
  hands typing at a desk, an empty stadium, a crowded office). Real footage of this kind of moment
  exists too, but it's ambient: even when someone is technically visible doing something mundane
  (typing, walking past, sitting at a desk), that action isn't what the story is ABOUT — it's just
  a shot. This is "feel", not "evidence" — see the exclusion note in (b) below, which covers the
  same ground from the other side.
  This is a PATTERN, not a fixed list — it applies to any unnamed, generic person or scene doing
  something ordinary, with no specific identity established by context and no "most/many X"
  categorical claim being made, even in a phrasing never shown here. Two more examples,
  deliberately in domains this prompt hasn't used yet, to show the pattern isn't limited to the
  list above: "A barista wiped down the counter as the cafe emptied out for the night" (an
  anonymous barista, ordinary closing-time activity — feel, even though grammatically "someone did
  something"), and "A groundskeeper walked the pitch checking the turf before kickoff" (an
  anonymous groundskeeper, ordinary pre-match activity — same pattern, sports domain this time).
  Neither names a specific real person/team, and neither is a categorical claim — they're
  incidental human motion setting a scene, exactly like hands typing at a desk.
- "evidence" — needs a REAL-WORLD illustrative visual of people/things DOING or EXPERIENCING
  something. Either (a) ONE specific real person/thing that said or did something, or (b) a
  general statement about a CATEGORY of people/things doing or experiencing something concrete —
  even with no single person named, real footage of that KIND of moment exists and should be
  found. Two examples of (b), deliberately from different domains — this applies to ANY topic,
  not just one kind of story: "For most footballers, scoring at a World Cup is the highlight of
  their career" (needs footage of players scoring/celebrating), and "Most startups fail within
  their first two years" (needs footage of a struggling small business, a closed storefront,
  people packing up an office) are BOTH "evidence" — do NOT call either "nothing" just because
  no one person is named. Ask whether real footage of that kind of moment exists; if yes, it's
  "evidence", named person or not. EXCLUSION: this does NOT cover anything matching "feel"'s
  pattern above — pure atmosphere/weather/scene-setting, OR ordinary background activity by an
  unnamed, generic person/scene with no categorical claim attached — even though real footage of
  it, including of someone technically doing something in it, obviously exists too. The test: is
  the DOING itself the point the sentence is making (a goal scored, a company failing, a specific
  meaningful act ATTRIBUTED to a named entity or a named category), or is a person just
  incidentally, anonymously visible as scenery while something else is the point? Only the former
  is "evidence" (b) — incidental human activity stays "feel" no matter how literally "someone is
  doing something" it is, and no matter whether this exact wording was used as an example above.
- "reference" — matches a known meme/cultural callback
- "nothing" — GENUINELY has no visual content of its own: connective narration, a meta aside, a
  setup clause that only makes sense combined with the next segment's visual. If a sentence
  describes any real-world action, scene, or moment — named person or not, any topic — it is
  NOT "nothing". CAUTION: a short fragment shaped like a transition ("Then came France.", "Next
  was the Series B.", "Up next: the finals.") is NOT automatically "nothing" just because it's
  brief and transition-shaped — check whether it NAMES a real person/team/event first. If it
  does, it's "evidence" (a real next step in the story that needs real footage), even though it
  reads like a pacing beat. Only call it "nothing" if, after removing the transition wording,
  nothing real and nameable is actually left.

If family is "feel", also include a "query": a SHORT DESCRIPTIVE VISUAL SCENE PHRASE, 2-5 words,
for searching a real stock-footage library — describe the shot itself, not a mood word. The beat
is atmosphere, mood, or an unnamed action a real clip can depict (rain on a window, a city at
night, a sunrise, hands typing at a desk, a crowded office, an empty stadium). Good queries:
"stormy sky timelapse", "empty stadium night", "hands typing on laptop", "city traffic time
lapse". Bad queries: single mood words like "hope" or "tension" — stock-footage search matches
what's actually shown on screen, not a feeling.

For "nothing"/"evidence"/"reference" segments, omit "query" — it's resolved downstream by its
own dedicated search step, not by this pass.

Return strict JSON only, no prose, no markdown fences:
{"segments":[{"text":"...","family":"feel","query":"..."}]}`;

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

TWO RULES that are easy to get wrong:

1. ALWAYS name the specific time, edition, or event established earlier — a year, a season, a
   funding round, a tournament stage — in EVERY resolved sentence, not just the first one. A
   later segment that just says "England looked stronger than ever" is genuinely ambiguous
   without restating which England, which year, which tournament — don't assume "now"/"today"
   just because the segment itself doesn't repeat it; carry the specific time/event forward every
   single time, even when it feels repetitive or already obvious from earlier segments.

2. When a fragment introduces a NEW name as the next step in an ongoing progression — a next
   opponent, a next round, a next funding stage, a next chapter — resolve it as the RELATIONSHIP
   or EVENT between the subject already being followed and that new name, not as if the new name
   were its own independent topic. "Then came France" after several segments narrating a team's
   tournament run means the team's NEXT MATCH is against France — resolve to "England play France
   in the [specific round] of the [specific year] World Cup", not just "France" or a general
   France-related event unconnected to the team being followed.

Two examples, different domains, both showing rules 1 and 2 together:
- Sports: after segments narrating England's run through the 2022 World Cup group stage and
  round of 16, "Then came France." -> "England face France in the quarterfinal of the 2022 World
  Cup, their next match after beating Senegal in the round of 16" — names the specific edition
  AND frames it as the matchup between the two, not standalone France content.
- Business: after segments narrating a startup's seed round and early growth in 2019, "Then came
  the Series B." -> "The startup closes its Series B funding round in 2019, the next funding
  stage after the seed round covered earlier" — names the specific year AND frames it as the next
  stage in that company's story, not a generic Series B explainer.

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
    const res = await groqChat(env, {
      // The narrate pass is the reasoning-heaviest step in the pipeline (relational + temporal
      // resolution across an arbitrary-length script) — worth the stronger model.
      model: "openai/gpt-oss-120b",
      messages: [
        { role: "system", content: NARRATE_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: 0.2,
      // Output scales with how many segments need resolving, not with the whole script — one
      // short sentence per target. Sized generously per target rather than a flat constant, so a
      // script with unusually many evidence/reference beats doesn't get cut off mid-JSON (see
      // onRequestPost's max_completion_tokens comment for why this class of bug matters here).
      max_completion_tokens: Math.min(8000, targets.length * 60 + 300),
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
    const groqRes = await groqChat(env, {
      // Was llama-3.3-70b-versatile — moved here alongside narrateSegments() below. That model's
      // 100k-tokens/day quota got exhausted mid-session repeatedly (real, reproducible — a live
      // 429 response confirmed it), and it was the sole model behind segmentation AND both
      // intent-extraction calls (evidence-search.js, reference-search.js): once it's out, the
      // whole "understand the script" pipeline hard-fails, not just one call site. Consolidating
      // onto gpt-oss-120b (already verified for the narrate pass) trades that hard dependency for
      // a model whose quota isn't shared with anything user-triggered per-click.
      model: "openai/gpt-oss-120b",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: script },
      ],
      temperature: 0.3,
      // Segmentation's output has to echo back nearly the ENTIRE script verbatim (every segment's
      // "text" is a substring of it) plus per-segment family/query JSON overhead — so its length
      // scales with the script's, not a fixed small size. Never setting this meant relying on
      // whatever default cap Groq applies, which a long real script (confirmed live: ~90 segments
      // from a ~4.7k-character script) can exceed mid-generation, coming back as truncated,
      // invalid JSON ("json_validate_failed" with an empty failed_generation) — not a rare fluke,
      // reproduced 3/3 tries on the same script. Sized off script length with headroom for the
      // JSON overhead, capped at gpt-oss-120b's practical ceiling under its own 8000 TPM budget.
      max_completion_tokens: Math.min(8000, Math.ceil(script.length / 2) + 800),
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
