// Cloudflare Pages Function — POST /api/segment
// Ported from netlify/functions/segment.js (Netlify handler -> Pages onRequestPost,
// process.env -> context.env). Prompt + mergeFragments logic is unchanged.
// Moved to Claude Sonnet (2026-07-18) from Groq's llama-3.3-70b-versatile — the highest-stakes,
// most failure-prone call all session (TPM limits, the barista/groundskeeper shape-bias, the
// abstract-state gap), and the one call per script, so cost stays predictable per project. This
// is a real billed Anthropic balance, not a free tier — see _claude.js's header comment.
import { claudeChat, extractText, extractJson } from "./_claude.js";

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
segment describes a whole CLASS of real people/things DOING something a camera pointed at one real
instance could actually capture happening. Quantifier language ("most", "many", "every",
"typically", "usually") is a useful SIGNAL for noticing candidate sentences, but it is NOT the
test by itself — plenty of quantifier+category sentences describe an internal, mental, or
emotional state (wondering, hoping, believing, wishing, dreaming, feeling proud, wanting) that no
camera could ever capture, no matter how many real people are doing it. "Many England fans wonder
how different history would have been" has the exact grammatical shape of a categorical claim
(quantifier + category + verb), but "wonder" happens invisibly inside someone's head — there is
nothing for a lens to point at. The real test is content, not shape: imagine pointing a camera at
one genuine instance of this — does it capture a visible, external, physical action or event, or
does it just capture a person existing while something invisible happens inside them? Only the
first counts.

Two examples of genuine categoryClaims: "For most footballers, scoring at a World Cup is the
highlight of their career" -> categoryClaim: "footballers celebrating scoring at a World Cup"
(real, filmable: players visibly celebrating). "Most startups fail within their first two years"
-> categoryClaim: "a startup failing and shutting down" (real, filmable: a closing storefront, an
office being packed up). Two examples of quantifier language that does NOT qualify, because the
actual content is a mental/emotional state, not a filmable class-level event: "Many England fans
wonder how different history would have been" -> categoryClaim: null (wondering is invisible and
internal — nothing external to film, no matter how many fans are doing it). "Most people just
want to feel like their work matters" -> categoryClaim: null (wanting/feeling is internal; no
visible class-level action here).

Also set "categoryClaim" to null whenever the segment is ordinary, unnamed, INCIDENTAL background
activity with no quantifier-signalled claim attached at all — a barista wiping down the counter as
a cafe empties out for the night, a groundskeeper walking the pitch checking the turf before
kickoff, an aide handing over a folder in a hallway, rain on a window, hands typing at a desk.
None of these assert anything about a CLASS of people/things — they're one anonymous, ordinary
action happening once, incidentally, as scene-setting.

The full test, in order: (1) is a whole CLASS of real people/things being described, not one
anonymous instance? (2) if you point a camera at one real instance, does it capture a visible
external action/event, not an internal mental/emotional state? Only when BOTH are true, set
categoryClaim. Don't guess a categoryClaim into a sentence that's really just atmosphere, and
don't let quantifier language alone talk you into one that's really an internal state.

Note: excluding a mental/emotional state from categoryClaim does NOT make the segment "nothing" —
it still stays "feel" (see the "nothing" rule below). Unlike a truly abstract STATE with nothing
to picture (a tied score, a deal "still on the table"), an internal feeling like wondering or
missing someone IS visualizable, through a symbolic representative shot (see the query-writing
guidance below) — it just isn't a filmable, literal, class-level ACTION, so it doesn't qualify as
a categoryClaim.

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
  ALSO "nothing": an ABSTRACT STATE or OUTCOME with no concrete scene a camera could point at —
  a score being tied, a situation being "still open"/"unresolved", a deal "still on the table".
  These describe a STATE, not an action, event, or scene — there's nothing happening to show, so
  neither a stock-footage query nor a real-footage search has anything concrete to work with. Two
  examples, different domains: "Everything was level going into the final minutes." (a tied score
  is a fact about a scoreboard, not a filmable moment — "level" isn't a shot). "The deal was still
  hanging in the balance." (an ongoing negotiation state, nothing to picture). Contrast with mood/
  atmosphere, which DOES stay "feel" because it's actually visualizable (a tense crowd's faces, an
  electric atmosphere in a stadium are real shots) — the line is whether a concrete scene exists to
  film, not whether the sentence "sounds" abstract. And contrast with a real action inside the same
  beat: "The score had been level for weeks until the funding finally came through." — the funding
  coming through is a real event (evidence/categoryClaim territory); only an isolated abstract-state
  clause with no action attached is "nothing".

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

For each judgment, reason concretely about real-world documentation/coverage patterns rather than
pattern-matching to whichever worked example below seems closest: ask what TYPE of source would
need to exist for this to be findable — a viral clip on YouTube/TikTok, sports broadcast archive
footage, news b-roll, a well-covered, Wikipedia-level event — and whether that type of source
realistically exists for THIS specific case. The examples below illustrate the reasoning, they are
not an exhaustive list to match against; a case that doesn't closely resemble any of them should
still get a genuinely reasoned answer based on how documented that kind of thing actually is in
the real world, not a default to whichever example seems nearest.

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

Special case — reflective/internal "feel" segments (wondering, missing, regretting, longing,
remembering, imagining "what could have been"): don't default to a literal noun lifted from the
sentence's surface topic — the sport, the setting, the industry. That describes the BACKDROP the
feeling happens in, not the feeling itself, and reads as a generic, on-the-nose environment shot.
Instead, write the query for the SYMBOLIC, representative shot an editor actually reaches for to
convey that internal state on screen: someone gazing into the distance, a hand slowly turning an
old photograph, a person staring out a rain-streaked window, someone sitting alone as light fades.
Example: "To this day, many England fans wonder scoring there would have changed football history
forever." The actual content of this line is wistful, reflective, "what could have been" — not
football, not a stadium. BAD query: "football stadium fans" or "fans watching" (literal
topic-nouns pulled from the surface subject matter, generic, misses the reflective content
entirely). GOOD query: "person gazing into distance thoughtfully" or "hand slowly turning old
photograph". Paired example, different domain: "Some founders spend years afterward replaying the
moment they turned down the acquisition." BAD query: "office meeting boardroom" (literal
topic-noun lifted from "founders"/"acquisition"). GOOD query: "person staring out rain-streaked
window" or "hand slowly turning old photograph" — the same symbolic reflection shot works here
too, because the underlying feeling (replaying a past what-if) is the same regardless of domain.
The test: if the segment's real content is something happening INSIDE someone's head, write the
query for the symbolic gesture that represents that interior state, not the literal exterior
setting the sentence happens to mention.

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
  if (!env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "ANTHROPIC_API_KEY is not set on this Cloudflare project" }, { status: 500 });
  }

  try {
    const claudeRes = await claudeChat(env, {
      model: "claude-sonnet-5",
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: script }],
      // Same "output scales with script length, not a fixed small amount" reasoning as the old
      // Groq cap (segmentation echoes back nearly the entire script verbatim), but this number
      // does NOT need Groq-style tight tuning: Anthropic bills by tokens actually GENERATED, not
      // the declared max_tokens ceiling (confirmed live — Groq's TPM accounting reserved the
      // whole declared cap upfront regardless of use, which is what forced the tight Groq-era
      // formula; that constraint doesn't apply here). Raised generously (16000->32000 cap,
      // +2500->+6000 buffer) after a real truncation ("Unterminated string in JSON") at the old
      // cap — a real answer needs room for low-effort thinking (see _claude.js) PLUS the full
      // echoed-text JSON, and there's no cost reason to keep this tight the way Groq's was.
      max_tokens: Math.min(32000, Math.ceil(script.length / 1.5) + 6000),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      return Response.json({ error: `Claude error: ${errText}` }, { status: 502 });
    }

    const data = await claudeRes.json();
    const content = extractJson(extractText(data));
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

// The model is asked to judge "findable" (see SYSTEM_PROMPT) ONLY for segments it already
// considers evidence/reference-shaped, so the field's mere presence already encodes that —
// checking seg.findable directly needs no extra guard, and deliberately does NOT gate on
// subject/categoryClaim/family: confirmed live that a segment can legitimately have NEITHER a
// subject NOR a categoryClaim and still be "findable":"unlikely" (that's exactly what makes it
// unlikely — "The chat lost it when the demo video hit the front page" names no one and no real
// category, which is why nothing is searchable, not despite it). An earlier version of this
// function required subject/categoryClaim/family==="reference" to also be true before honoring
// "unlikely", which silently never fired for exactly that shape of segment once
// enforceEvidenceRule() had already downgraded it to "feel" — caught live, fixed by trusting
// "findable" on its own. This also makes the two functions trivially commute, since this one no
// longer reads anything enforceEvidenceRule() writes.
function enforceFindabilityRule(segments) {
  for (const seg of segments) {
    if (seg.findable === "unlikely") {
      seg.family = "nothing";
    }
  }
  return segments;
}
