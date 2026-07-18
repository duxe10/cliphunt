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

For each segment, also name the "subject": the ONE specific, nameable real person, team,
organization, or event this moment is ABOUT — resolved from earlier context if this moment is a
pronoun or fragment continuing an established story (e.g. after a paragraph about Harry Kane,
"A missed penalty." has subject "Harry Kane"). Set "subject" to null when no single specific
real entity/event is identifiable — this covers pure atmosphere/mood, general statements about a
CATEGORY of people/things ("For most footballers...", "Most startups fail..."), and ordinary
unnamed background activity (a barista closing up, a groundskeeper checking the pitch) alike:
none of these name ONE real entity, so all of them get "subject": null, even though a person is
grammatically "doing something" in some of them. Don't guess a subject that isn't actually
established — null is correct far more often than it might feel.

Then pick one "family":
- "feel" — "subject" is null. Covers pure emotional beats, atmosphere/mood/scene-setting, general
  category-level statements, and ordinary unnamed background activity — anything without ONE
  nameable real entity/event behind it. All of it gets real stock footage.
- "evidence" — "subject" is set: a specific real person/team/org/event doing or saying a
  particular thing.
- "reference" — matches a known meme/cultural callback (subject is usually null or the meme's name).
- "nothing" — GENUINELY has no visual content of its own: connective narration, a meta aside, a
  setup clause that only makes sense combined with the next segment's visual. If a sentence
  describes any real-world action, scene, or moment it is NOT "nothing" — check whether it names
  or resolves to a subject first (then it's "evidence"), and if not, it's "feel", not "nothing".
  Only call it "nothing" if, after removing transition wording, nothing visual is actually left.

Also include a "query" for every segment EXCEPT "nothing": a SHORT DESCRIPTIVE VISUAL SCENE
PHRASE, 2-5 words, for searching a real stock-footage library — describe the shot itself, not a
mood word or an abstract claim, and never include "subject"'s name in it. This is the primary
search for "feel" segments, and a fallback for "evidence"/"reference" segments in case no
specific subject can actually be confirmed later. Good queries: "stormy sky timelapse", "empty
stadium night", "hands typing on laptop", "stadium crowd celebrating goal", "small storefront
closing down with moving boxes", "empty office packed into cardboard boxes". Bad queries: single
mood words like "hope" or "tension", or a person's/team's name.

Return strict JSON only, no prose, no markdown fences:
{"segments":[{"text":"...","family":"feel","subject":null,"query":"..."}]}`;

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
      // Back on llama-3.3-70b-versatile (2026-07-18, second swap) — segmentation alone was
      // confirmed live to request ~5200-5800 tokens for a realistic script, which is 65-72% of
      // gpt-oss-120b's 8k TPM ceiling in ONE call, leaving no room for a retry or a second call
      // within the same minute (this is what was still breaking testing after the Narrator-batch
      // revert). llama-3.3-70b-versatile's 12k TPM gives real headroom for the same request.
      // Trade-off, deliberate: this reopens the 100k-tokens/DAY quota risk that caused the
      // original move away from this model — evidence/reference/stock-rerank calls stay on
      // gpt-oss-120b/20b so segmentation isn't sharing a quota with them again. If the daily
      // quota starts getting hit, that's the next thing to look at — don't silently swap back.
      model: "llama-3.3-70b-versatile",
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
      // reproduced 3/3 tries on the same script.
      //
      // The first version of this (script.length/2 + 800) fixed the truncation bug but then
      // itself became the problem: Groq's TPM accounting reserves the FULL declared cap upfront
      // as "Requested" (confirmed live — adding this cap alone jumped Requested from 2660 to
      // 5837 tokens), so an over-padded cap eats most of the entire 8000/minute budget in one
      // call, leaving near-zero margin for any contention at all. Tightened to roughly match the
      // actual minimum need (echoed text + JSON overhead ≈ script length in tokens, not 2x) rather
      // than padding heavily "to be safe" — safety here has to be balanced against the TPM ceiling
      // itself, not just against truncation risk in isolation.
      max_completion_tokens: Math.min(8000, Math.ceil(script.length / 2.5) + 600),
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
    const corrected = enforceSubjectRule(merged);
    return Response.json({ segments: corrected });
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

// The model is unreliable at holding the feel/evidence line on its own — confirmed live,
// repeatedly, that it reads a "[a/an + role] + [specific verb] + [specific scene]" sentence SHAPE
// as evidence-worthy regardless of whether a real entity is actually named (a barista, a
// groundskeeper, an aide — all misclassified "evidence" despite naming no one). Rewording the
// prompt harder didn't fix it (same lesson as mergeFragments() above), so this rule is enforced
// deterministically instead: "evidence" without a "subject" isn't a coherent evidence claim, so
// it's downgraded to "feel" here in code rather than trusted to the model's own family label.
// This can't misfire on a legitimate evidence segment, since a real "evidence" claim always
// implies a nameable subject by definition.
function enforceSubjectRule(segments) {
  for (const seg of segments) {
    const hasSubject = seg.subject && String(seg.subject).trim();
    if (seg.family === "evidence" && !hasSubject) {
      seg.family = "feel";
    }
  }
  return segments;
}
