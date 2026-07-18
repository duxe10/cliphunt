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
real entity/event is identifiable. Don't guess a subject that isn't actually established — null
is correct far more often than it might feel.

Also name the "categoryClaim": a short phrase naming the real, general phenomenon ONLY when the
segment makes a genuine categorical assertion about a whole CLASS of real people/things doing or
experiencing something a camera could plausibly have captured — signalled by quantifier language
("most", "many", "every", "typically", "usually") attached to a concrete real action, not an
abstract feeling. Real footage of that KIND of moment exists and is worth searching for, even
though no one specific instance is named. Two examples: "For most footballers, scoring at a World
Cup is the highlight of their career" -> categoryClaim: "footballers celebrating scoring at a
World Cup" (real footage of players celebrating World Cup goals exists and should be searched
for, not stock b-roll). "Most startups fail within their first two years" -> categoryClaim: "a
startup failing and shutting down" (real footage of a struggling small business, a closing
storefront, people packing up an office). Set "categoryClaim" to null whenever the segment is
ordinary, unnamed, INCIDENTAL background activity with no quantifier-signalled claim attached — a
barista wiping down the counter as a cafe empties out for the night, a groundskeeper walking the
pitch checking the turf before kickoff, an aide handing over a folder in a hallway, rain on a
window, hands typing at a desk. None of these assert anything about a CLASS of people/things —
they're one anonymous, ordinary action happening once, incidentally, as scene-setting. The test:
does the sentence claim something is true of MANY people/instances (categoryClaim, set it), or
does it just show ONE anonymous, incidental thing happening once with no claim attached
(categoryClaim: null)? Don't guess a categoryClaim into a sentence that's really just atmosphere.

Then pick one "family":
- "feel" — "subject" is null AND "categoryClaim" is null. Covers pure emotional beats,
  atmosphere/mood/scene-setting, and ordinary unnamed incidental background activity — anything
  without ONE nameable real entity/event AND without a genuine categorical claim behind it. All of
  it gets real stock footage.
- "evidence" — EITHER "subject" is set (a specific real person/team/org/event doing or saying a
  particular thing), OR "categoryClaim" is set (a genuine categorical claim about a class of real
  people/things doing something a camera could capture). Both flavors search for real captured
  footage — a named subject's exact moment, or authentic footage of that KIND of moment happening
  to real people — never stock b-roll, in either case.
- "reference" — matches a known meme/cultural callback (subject and categoryClaim are usually
  both null).
- "nothing" — GENUINELY has no visual content of its own: connective narration, a meta aside, a
  setup clause that only makes sense combined with the next segment's visual. If a sentence
  describes any real-world action, scene, or moment it is NOT "nothing" — check whether it names
  or resolves to a subject or a categoryClaim first (then it's "evidence"), and if not, it's
  "feel", not "nothing". Only call it "nothing" if, after removing transition wording, nothing
  visual is actually left.

For every segment where you set a non-null "subject", a non-null "categoryClaim", or judge family
"reference", also judge "findable" — the odds that real, indexed footage of this actually exists
to be found, as distinct from whether it's grammatically "evidence"/"reference"-shaped. Three
values:
- "likely" — named subject: a genuinely high-profile, well-documented real person/event.
  categoryClaim: real footage of this KIND of event is common and broadly documented, not a
  fringe/rare occurrence (World Cup goal celebrations, startups failing, weddings, graduations —
  all common, heavily filmed real-life categories). reference: an actual, currently-recognizable
  named meme/viral clip. Confident real footage exists and is realistically searchable.
- "unsure" — plausible and specific enough to be worth a search in any of the three shapes above,
  but you can't be confident footage was ever filmed, uploaded, or indexed under a findable
  title. Default here whenever you're not clearly at "likely" or "unlikely" — searching is cheap,
  so "unsure" is the safe default, not "unlikely".
- "unlikely" — named subject: unnamed, small-scale, private, local, purely fictional/hypothetical,
  or otherwise has no realistic chance of existing as real, indexed footage — narrative color, not
  a real searchable thing, even if it reads like something specific happened. categoryClaim: an
  extremely niche, rare, or obscure category unlikely to ever have been filmed or indexed at scale
  (e.g. "most left-handed calligraphers develop a particular callus" — too small/rare a documented
  category to expect real footage). reference: a private, unnamed reaction with no real named
  meme or clip behind it.

Omit "findable" entirely for "feel" and "nothing" segments — "feel" always searches regardless of
any findability judgment, so none is needed there.

Worked examples for "findable":
- "The chat lost it when the demo video hit the front page." — an unnamed "chat", an unnamed
  demo, no platform, product, or company named anywhere: nothing here is a real, identifiable,
  indexed thing to search for, even though it reads like a specific moment happened.
  family "evidence"-shaped, findable:"unlikely".
- "Neymar broke down in tears after Brazil's 2014 World Cup semi-final collapse against Germany."
  — a famous, extensively broadcast, heavily re-uploaded real event. findable:"likely".
- "The founder broke down on a Twitch stream when the acquisition offer finally came through." —
  a real, specific, plausible event (streams do get clipped and uploaded), but not famous enough
  to be sure it was indexed under a findable title. findable:"unsure" — worth a search, keep the
  result only if something real actually matches.
- "For most footballers, scoring at a World Cup is the highlight of their career." —
  categoryClaim set; World Cup goal celebrations are an extremely common, heavily broadcast real
  category. findable:"likely".
- "Most startups fail within their first two years." — categoryClaim set; footage of struggling
  small businesses/closures is a common, broadly documented real category (news b-roll, vlogs).
  findable:"likely".
- "It was giving major 'Distracted Boyfriend' energy." (reference) — an actual, still-current,
  genuinely searchable meme. findable:"likely".
- "Everyone in the group chat had THAT reaction." (reference) — a private, unnamed reaction with
  no real named meme or clip behind it. findable:"unlikely".

This is a companion judgment to "subject"/"categoryClaim", not a substitute for either: a segment
can have a real subject or a real categoryClaim and still be "unlikely" if the specific event or
category is too small/private/rare to have realistic footage. When genuinely torn, prefer
"unsure" over "unlikely" — the cost of a search that comes back empty is low, the cost of
skipping a real findable clip is not.

Also include a "query" for every segment EXCEPT "nothing": a SHORT DESCRIPTIVE VISUAL SCENE
PHRASE, 2-5 words, for searching a real stock-footage library — describe the shot itself, not a
mood word or an abstract claim, and never include "subject"'s name in it. This is the primary
search for "feel" segments, and a fallback for "evidence"/"reference" segments in case no
specific subject can actually be confirmed later. Good queries: "stormy sky timelapse", "empty
stadium night", "hands typing on laptop", "stadium crowd celebrating goal", "small storefront
closing down with moving boxes", "empty office packed into cardboard boxes". Bad queries: single
mood words like "hope" or "tension", or a person's/team's name.

Return strict JSON only, no prose, no markdown fences:
{"segments":[{"text":"...","family":"feel","subject":null,"categoryClaim":null,"query":"..."},{"text":"...","family":"evidence","subject":"...","categoryClaim":null,"findable":"likely","query":"..."},{"text":"...","family":"evidence","subject":null,"categoryClaim":"...","findable":"likely","query":"..."}]}`;

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
      // Bumped 600 -> 900 (2026-07-18, third pass) when "categoryClaim" (every segment) and
      // "findable" (a subset) were added — two more small JSON keys of real output cost on top
      // of the shape this constant was tuned for. Estimated, not measured — re-confirm against
      // Groq's actual reported "Requested" tokens on a real dense script, same as every other
      // number in this formula; don't trust the arithmetic alone.
      max_completion_tokens: Math.min(8000, Math.ceil(script.length / 2.5) + 900),
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
    const evidenceResolved = enforceEvidenceRule(merged);
    const corrected = enforceFindabilityRule(evidenceResolved);
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
// prompt harder didn't fix it (same lesson as mergeFragments() above), so this is enforced
// deterministically instead, built from the two mechanical source fields rather than trusted to
// the model's own "family" word. Bidirectional, since either failure direction is possible:
// downgrade "evidence" -> "feel" when NEITHER "subject" NOR "categoryClaim" is actually set (the
// shape-bias false positive above); upgrade "feel" -> "evidence" when EITHER is set but the
// model's own family word didn't follow through (a real categoryClaim correctly identified, but
// mislabeled "feel" anyway). Never touches "reference"/"nothing".
function enforceEvidenceRule(segments) {
  for (const seg of segments) {
    const hasSubject = seg.subject && String(seg.subject).trim();
    const hasCategoryClaim = seg.categoryClaim && String(seg.categoryClaim).trim();
    const isRealEvidence = hasSubject || hasCategoryClaim;
    if (seg.family === "evidence" && !isRealEvidence) {
      seg.family = "feel";
    } else if (seg.family === "feel" && isRealEvidence) {
      seg.family = "evidence";
    }
  }
  return segments;
}

// The model is asked to judge "findable" (see SYSTEM_PROMPT) for any segment carrying a subject,
// a categoryClaim, or a "reference" call, precisely so this check can be driven by those
// mechanical fields rather than by "family" — which enforceEvidenceRule() above is busy
// correcting. Building the trigger from subject/categoryClaim/reference-ness instead of
// seg.family makes this function commute with enforceEvidenceRule(): it produces the same result
// regardless of which runs first, since neither function's condition depends on the other's
// output. A "findable":"unlikely" verdict wins outright over any feel/evidence resolution, for
// either evidence flavor.
function enforceFindabilityRule(segments) {
  for (const seg of segments) {
    const hasSubject = seg.subject && String(seg.subject).trim();
    const hasCategoryClaim = seg.categoryClaim && String(seg.categoryClaim).trim();
    const isEvidenceShaped = hasSubject || hasCategoryClaim || seg.family === "reference";
    if (isEvidenceShaped && seg.findable === "unlikely") {
      seg.family = "nothing";
    }
  }
  return segments;
}
