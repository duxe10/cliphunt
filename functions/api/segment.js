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

Before naming a subject or categoryClaim, or choosing a family, run one test on the segment's
actual content — this is the single test that governs every judgment below, not a separate check
for each field: can you point to ONE concrete, physically depictable thing that is doing or
happening, using only the words actually in THIS segment? Two parts, both required:
(1) CONCRETE, not abstract — the thing must be an action, event, or physical scene (a body doing
something, an object, a setting, a crowd's visible reaction) — not a mental state, a value
judgment, a reputation claim, a vague aspiration, or an abstract intensity ("gives me a little
hope", "the dream was alive", "the pressure couldn't have been greater", "trusted him" as a
character judgment).
(2) PRESENT IN THIS SEGMENT, not borrowed or invented — the concrete thing has to actually be
there in this segment's own words, resolved from earlier context the way "subject" already is (a
pronoun can resolve to an established person), but not manufactured to paper over a gap, and not
inherited from a NEXT segment this one is merely setting up for ("It wasn't just a missed
penalty." references a penalty but doesn't depict it happening now — it's a rhetorical stepping
stone into whatever comes next).
If either part fails, there is nothing here for a camera, a stock-footage search, or a real-
footage search to find — a resolvable name, a quantifier+category grammar shape, or an
emotionally loaded phrase is not sufficient on its own to rescue it. This is the test "subject",
"categoryClaim", "feel"'s query-writing, and "nothing" all apply below — treat it as one gate, not
four separate judgment calls.

Tie-breaker, since this is the single most common way this gate gets misapplied: when a segment
mixes BOTH abstract/emotional/collective framing (a retrospective claim, a quantifier over a
group, a claim about a feeling) AND a physical anchor buried somewhere else in the same sentence —
often in a subordinate clause, a participial phrase, or modifying the group rather than one person
— the anchor wins. Read the FULL sentence for a hidden anchor before concluding "nothing"; don't
stop scanning at the first clause that sounds abstract. "For a nation that had spent decades
watching disappointment after disappointment, it finally felt like something had changed" sounds,
on a first read, like a bare abstract feeling ("it finally felt like something had changed") — but
"watching disappointment after disappointment" is a real, physical, present-in-the-text anchor (a
crowd's repeated act of watching), buried in the earlier clause, so this stays "feel", not
"nothing". The abstract-sounding half of a sentence does not cancel out a real anchor sitting in
the other half.

Two more examples of the same tie-breaker, different domains, to guard against reading this as a
sports-only pattern: "For a founder who had spent years being told no by every investor in the
room, watching them finally reach for their checkbooks felt like vindication." — sounds like a bare
feeling ("felt like vindication"), but "watching them finally reach for their checkbooks" is a real
anchor buried in the setup clause; stays "feel", query built from that anchor plus the arc (years
of no, now reaching for checkbooks) — e.g. "investors leaning in reaching for checkbooks", not
"investors watching" alone. "For a family that had sat through appointment after appointment with
no answers, the doctor walking in with a smile said everything before she spoke." — anchor: "the
doctor walking in with a smile"; stays "feel", query built from the anchor plus the arc (long
uncertainty into relief) — e.g. "doctor entering exam room, family looking up", not "doctor walking
in" alone.

The tie-breaker is not unconditional — it only fires for an anchor doing real work in the
sentence, not any incidental verb that happens to be present. Test: could this anchor phrase be
swapped for a different, unrelated placeholder action (sitting, standing, walking) WITHOUT
changing what the sentence is actually describing? If yes, it's backgrounded stage direction, not
a real anchor, and does NOT win the tie-breaker on its own. If no — the anchor is specific and
load-bearing to the sentence's actual point (a repeated, particular, or descriptively-detailed
action, not a generic placeholder verb) — it wins. Check the examples above against this test:
"watching disappointment after disappointment" can't be swapped for "standing there" without
losing the entire point (real, repeated losses, watched by real people) — load-bearing, wins.
"the doctor walking in WITH A SMILE" — the bare "walking in" is generic, but "with a smile" is the
specific, load-bearing detail (it's literally what communicates the relief) — the anchor wins
because of that detail, not despite genericness elsewhere in the phrase.

Two examples where a nominal anchor is present but FAILS this test, so the tie-breaker does NOT
rescue the segment — these matter as much as the "anchor wins" examples above, because without
them this gate has no way to say "nothing" once ANY verb of motion or posture appears anywhere in
a sentence, which is its own failure mode: "Sitting there that day, staring at nothing in
particular, she somehow knew everything was about to change." — "sitting" and "staring at nothing
in particular" are both swappable for any other generic posture without changing what this
sentence is about (an unexplained premonition) — backgrounded stage direction, not a real anchor;
stays "nothing". "Walking down the street that morning, he finally let himself believe it might
actually work this time." — "walking down the street" is interchangeable with any other mundane
activity; nothing about it is specific to "it might actually work" (an unnamed hope/belief) —
stays "nothing", not rescued by the incidental walking.

For each segment, also name the "subject": the ONE specific, nameable real person, team,
organization, or event this moment is ABOUT — resolved from earlier context if this moment is a
pronoun or fragment continuing an established story (e.g. after a paragraph about Harry Kane,
"A missed penalty." has subject "Harry Kane") — but only when the concreteness test above
actually passes for this segment: a resolvable name is necessary, never sufficient. The content
attached to that name must itself be a depictable action or event, not an abstract trait,
reputation, or character judgment about them. "That resilience is the reason teammates and
managers trusted him" resolves "him" to a real player, but the actual content is a retrospective
trust/character judgment with nothing to film — subject: null, despite the clean pronoun
resolution. Contrast: "He was still out training alone at 6am, months after the injury." — same
kind of resolved person-reference, but this time there's a concrete action to point a camera at
(training alone, early morning) — subject: "[player name]". Likewise, an evidence-sounding noun
phrase used only as a rhetorical or transitional reference doesn't count: "It wasn't just a missed
penalty." doesn't depict the penalty happening now, it gestures at it to set up a contrast —
subject: null. Set "subject" to null whenever no single specific real entity/event survives the
concreteness test, or when none is identifiable at all. Don't guess a subject that isn't actually
established — null is correct far more often than it might feel.

Also name the "categoryClaim": this is the concreteness test above, applied to a whole CLASS of
real people/things instead of one resolved individual. Name a short phrase for the real, general
phenomenon ONLY when the segment describes a whole CLASS of real people/things DOING something a
camera pointed at one real instance could actually capture happening — both parts of the
concreteness test still apply: (1) is what they're doing a visible, external action, not an
internal/mental/emotional state, and (2) is that action actually described in this segment's own
text, not invented. Quantifier language ("most", "many", "every", "typically", "usually") is a
useful SIGNAL for noticing candidate sentences, but it is NOT the test by itself — plenty of
quantifier+category sentences describe an internal, mental, or emotional state (wondering, hoping,
believing, wishing, dreaming, feeling proud, wanting) that no camera could ever capture, no matter
how many real people are doing it.

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

The full test — the same concreteness test above, specialized for a CLASS: (1) is a whole CLASS
of real people/things being described, not one anonymous instance? (2) if you point a camera at
one real instance, does it capture a visible external action/event, not an internal mental/
emotional state or an abstract judgment? Only when BOTH are true, set categoryClaim. Don't guess a
categoryClaim into a sentence that's really just atmosphere, and don't let quantifier language
alone talk you into one that's really an internal state.

Note: excluding a mental/emotional state from categoryClaim does NOT automatically make the
segment "feel" — check it against the concreteness test too. An internal state is only "feel"
(not "nothing") when the segment's own text also contains a genuine physical anchor to build a
query around — a gesture, a posture, an action someone is actually described doing while the
internal state happens ("spent decades watching disappointment" has "watching" as a real anchor;
"many England fans wonder how different history would have been" has no anchor at all — nothing
is described happening, just the wondering itself). When a real anchor exists, the segment is
"feel" and the query is built from that anchor plus the emotional context (see the query-writing
guidance below) — not a literal topic-noun, but not invented from nothing either. When NO anchor
exists anywhere in the segment's own words — a bare mental/emotional/aspirational claim with
nothing described happening ("gives me a little hope", "the dream was alive") — the segment is
"nothing": there's nothing for even a symbolic shot to hang on to that isn't fabricated.

Then pick one "family":
- "feel" — "subject" is null AND "categoryClaim" is null, AND the concreteness test above still
  finds a real, present-in-the-text anchor to work with: atmosphere, mood, scene-setting, ordinary
  unnamed incidental background activity, or an internal/emotional state that's genuinely anchored
  to a physical gesture or setting described in the segment (see the query-writing guidance
  below). All of it gets real stock footage.
- "evidence" — EITHER "subject" is set (a specific real person/team/org/event doing or saying a
  particular thing, with a genuine depictable action attached — not just a resolvable name), OR
  "categoryClaim" is set (a genuine categorical claim about a class of real people/things doing
  something a camera could capture). Both flavors search for real captured footage — a named
  subject's exact moment, or authentic footage of that KIND of moment happening to real people —
  never stock b-roll, in either case. Because "subject" and "categoryClaim" already passed the
  concreteness test above by the time you reach this point, no further content check is needed
  here — just check whether either field is actually set.
- "reference" — matches a known meme/cultural callback (subject and categoryClaim are usually
  both null). A recognized meme/clip is itself a concrete, already-filmed thing, so it doesn't
  need to separately pass the concreteness test.
- "nothing" — the concreteness test above fails outright: after looking for one concrete,
  physically depictable thing actually present in this segment's own text, nothing survives. This
  single test covers several different SURFACES, which are not separate rules but the same
  failure showing up in different grammar:
  - connective narration, meta asides, or a setup clause that only makes sense combined with the
    next segment's visual ("But that wasn't the end of the story.", "Here's the thing.") — there
    was never any content here, concrete or otherwise, only a transition.
  - an abstract STATE or OUTCOME with no action attached — a score being tied, a situation "still
    open"/"unresolved", a deal "still on the table". These describe a STATE, not an action, event,
    or scene: "Everything was level going into the final minutes." (a tied score is a fact about a
    scoreboard, not a filmable moment). "The deal was still hanging in the balance." (an ongoing
    negotiation state, nothing to picture).
  - a bare internal/emotional/aspirational claim with no physical anchor described anywhere in the
    segment's own text — no gesture, no posture, no setting, nothing happening while the feeling
    happens: "gives me a little hope", "the dream was alive", "the pressure couldn't have been
    greater", "many fans wonder how different history would have been" (standing alone, with
    nothing else described happening). Before landing on this bullet, re-run the tie-breaker
    above: scan the WHOLE sentence, not just whichever clause sounds most abstract, for a physical
    anchor sitting elsewhere in it — but also apply the tie-breaker's swap test: a generic
    posture/motion verb (sitting, standing, walking) that could be swapped for any other without
    changing what the sentence is about is NOT a real anchor either, and this bullet still applies.
  - a resolvable name or evidence-sounding noun phrase used only rhetorically or transitionally,
    not depicted as actually happening in this segment: "It wasn't just a missed penalty."
    (references a penalty to set up a contrast, doesn't depict it happening now). "That resilience
    is the reason teammates and managers trusted him." (resolves to a real person, but the content
    is a reputation/character judgment, not an action).
  Contrast with mood/atmosphere and anchored internal states, which DO stay "feel" because a
  concrete, present scene or gesture actually exists to film (a tense crowd's faces, an electric
  stadium atmosphere, someone sitting alone in a locker room replaying a moment) — the line is
  whether a concrete, present-in-the-text scene exists, not whether the sentence "sounds" abstract
  or emotionally loaded. And contrast with a real action inside the same beat: "The score had been
  level for weeks until the funding finally came through." — the funding coming through is a real
  event (evidence/categoryClaim territory); only an isolated abstract-state or bare-internal-state
  clause with no anchor is "nothing".

Every segment — not just "nothing" ones — should also include a brief "reason": a handful of
words tracing the classification/query back to what's actually in the text, not a restatement of
the family or query itself. For "feel", name the anchor (or "atmosphere, no single anchor" when
there genuinely isn't one) and, if there's an anchor, the emotional tone/arc layered onto it —
e.g. "anchor: sat alone in locker room; tone: quiet regret", "anchor buried in abstract claim:
watching disappointment; tone: hope emerging". For "evidence", name what made "subject" or
"categoryClaim" pass the concreteness test — e.g. "resolved subject: Harry Kane; action: training
alone at 6am", "categoryClaim: startups failing; visible action: office packed into boxes". For
"reference", name the recognized meme/clip — e.g. "recognized meme: Distracted Boyfriend". For
"nothing", keep naming which failure above applies, unchanged — e.g. "abstract state, no action",
"bare internal state, no anchor", "rhetorical setup, not depicted now", "reputation judgment, no
action", "connective narration only". This field is never shown to the end user; it exists purely
so the classification AND the query can be audited straight from the API response — a vague
"feel"/"evidence" query paired with a thin or generic "reason" points at weak reasoning (the
anchor itself was thin), while a vague query paired with a specific, well-anchored "reason" points
at a phrasing problem in the query itself, not a classification problem. Keep it to a handful of
words, same length as before — this is a diagnostic tag, not a second explanation.

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
PHRASE, roughly 3-7 words, for searching a real stock-footage library — describe the shot itself,
not a mood word or an abstract claim, and never include "subject"'s name in it. Err toward the
fuller end of that range whenever a physical anchor needs an emotional tone or arc layered onto
it (see the anchor+tone special case below) — a query too short to carry both the anchor and the
tone loses the tone first, which is exactly what makes a query read as generic instead of
specific. This is the primary search for "feel" segments, and a fallback for "evidence"/
"reference" segments in case no specific subject can actually be confirmed later. Good queries:
"stormy sky timelapse", "empty stadium night", "hands typing on laptop", "stadium crowd
celebrating goal", "small storefront closing down with moving boxes", "empty office packed into
cardboard boxes", "dejected fans slowly turning hopeful". Bad queries: single mood words like
"hope" or "tension", a person's/team's name, or a verb-only anchor with no emotional or
situational specificity ("crowd watching", "people waiting", "someone walking") — technically tied
to the text, but generic enough to match literally any scene, which defeats the point of building
the query from a specific anchor in the first place.

Special case — reflective/internal "feel" segments (wondering, missing, regretting, longing,
remembering) that PASS the concreteness test because a genuine physical anchor is actually present
in the segment's own text (a person sitting, standing, watching, staring, walking, holding
something) with an internal/emotional layer on top of it: don't default to a literal noun lifted
from the sentence's surface topic — the sport, the setting, the industry. That describes the
BACKDROP the feeling happens in, not the feeling itself, and reads as a generic, on-the-nose
environment shot. Instead, build the query from the ANCHOR ITSELF — the actual gesture, posture,
or setting described in the text — plus the emotional tone, not a generic invented "reflective"
stock image unrelated to what the segment actually describes. Example: "Long after the whistle
blew, someone sat alone in the locker room, replaying the moment in their head." The anchor here
is "sat alone in the locker room" — a real, concrete, present-in-the-text gesture. BAD query:
"football stadium" or "sports arena" (literal topic-noun pulled from the sport, generic, misses
what's actually described). GOOD query: "person sitting alone in empty locker room" — built
directly from the anchor that's actually in the text, not invented. Paired example, different
domain: "Long after the acquisition closed, she sat by the window each night, replaying the call
in her head." Anchor: "sat by the window". GOOD query: "person sitting alone by window at dusk".

A third, distinct shape of this same pattern deserves its own example because it's the one most
likely to produce a vague query if under-practiced: an anchor buried INSIDE a longer,
collective/retrospective, abstract-sounding claim, rather than sitting as the plain main clause of
a short sentence the way the two examples above do. "For a nation that had spent decades watching
disappointment after disappointment, it finally felt like something had changed." On a first read
this sounds like a bare abstract feeling ("finally felt like something had changed") — but
"watching disappointment after disappointment" is a real, physical, present-in-the-text anchor (a
crowd/nation's repeated act of watching, disappointment turning toward something changing), just
buried in the earlier clause instead of stated plainly up front. This stays "feel", not "nothing"
— the abstract-sounding second half doesn't cancel out the real anchor in the first half. BAD
query: "crowd watching" — true to the bare verb, but generic enough to match any crowd watching
anything, and drops the emotional arc (decades of disappointment, then a turn toward hope) that's
the actual point of the sentence. GOOD query: "dejected fans slowly turning hopeful" — same
anchor, but carrying the specific arc the text describes, the same way tone gets layered onto the
anchor in the two examples above. The lesson generalizes past this one sentence: whenever the
anchor is a watching/waiting/hoping-type verb sitting inside a longer claim about a GROUP's
experience over time, the bare verb alone is not a finished query — find the arc or contrast the
text actually describes (disappointment into change, doubt into belief, waiting into release) and
fold it in.

The test: does the segment's own text describe someone doing something physical WHILE the
internal state happens? If yes, build the query from that physical anchor plus tone. If the
segment is a BARE internal/emotional/aspirational claim with no physical anchor described
anywhere in its own text — "many fans wonder how different history would have been", "some
founders spend years replaying the moment they turned down the offer", "gives me a little hope",
"the dream was alive" — don't invent an anchor to force a "feel" query out of it. That's the
concreteness test failing: the segment is "nothing", not "feel" with a fabricated symbolic shot.

Return strict JSON only, no prose, no markdown fences:
{"segments":[{"text":"...","family":"feel","subject":null,"categoryClaim":null,"query":"...","reason":"..."},{"text":"...","family":"evidence","subject":"...","categoryClaim":null,"findable":"likely","query":"...","reason":"..."},{"text":"...","family":"evidence","subject":null,"categoryClaim":"...","findable":"likely","query":"...","reason":"..."},{"text":"...","family":"nothing","subject":null,"categoryClaim":null,"reason":"..."}]}`;

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
    const findabilityResolved = enforceFindabilityRule(evidenceResolved);
    const corrected = enforceFeelQueryRule(findabilityResolved);

    // Live-tail visibility only (wrangler pages deployment tail) — NOT a durable/queryable store,
    // just real-time eyes on what the model actually decided per segment while testing. One line
    // per segment (not one JSON blob for the whole script) so each is independently greppable
    // mid-stream (e.g. `wrangler pages deployment tail --project-name cliphunt | grep family=nothing`)
    // without scrolling one giant line. A short reqId ties every segment in one script back
    // together when several test scripts run back to back in the same tail session. Logged AFTER
    // both enforcement functions so this reflects final decided values, not raw pre-enforcement
    // model output.
    const reqId = Math.random().toString(36).slice(2, 8);
    console.log(`[segment] reqId=${reqId} script_len=${script.length} segments=${corrected.length}`);
    corrected.forEach((seg, i) => {
      console.log(
        `[segment] reqId=${reqId} #${i} family=${seg.family} ` +
        `subject=${JSON.stringify(seg.subject ?? null)} categoryClaim=${JSON.stringify(seg.categoryClaim ?? null)} ` +
        `findable=${seg.findable ?? "-"} query=${JSON.stringify(seg.query ?? null)} ` +
        `reason=${JSON.stringify(seg.reason ?? null)} text=${JSON.stringify(seg.text.slice(0, 100))}`
      );
    });

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

// The one boundary in this file with NO code-level backup until now: every other fuzzy judgment
// here (mergeFragments, enforceEvidenceRule, enforceFindabilityRule) has a deterministic safety
// net, but the concreteness-gate/tie-breaker decision that produces "feel" vs "nothing" was
// entirely prompt-reliant — the newest, most example-heavy rule in the prompt, with nothing
// mechanical backing it up. Full semantic verification ("was there really an anchor?") isn't
// something code can check — but ONE concrete self-contradiction the prompt itself defines IS
// checkable: "feel" requires a real physical anchor (see the concreteness gate above), and the
// query-writing section builds the "query" directly FROM that anchor — so a "feel" segment with
// an empty/missing "query" is proof the model applied the label without actually finding
// (or without actually using) an anchor, not a legitimate state (query is mandatory for every
// non-"nothing" family per the prompt itself). Downgrading here matters concretely: app.js's
// hydrateClips() falls back to `seg.query || seg.text` when sending to Pexels, so a hollow "feel"
// would search stock footage using a raw, often multi-clause sentence as the query — reliably bad
// results, not just a missing-data edge case. Runs LAST (after enforceEvidenceRule, which can
// still toggle a segment feel<->evidence) so it sees the final family value, not a pre-toggle one.
// This only catches ONE failure direction — a hollow "feel" — not the reverse (a real anchor
// existed but the model dropped to "nothing" anyway), which needs semantic judgment no mechanical
// check can provide.
function enforceFeelQueryRule(segments) {
  for (const seg of segments) {
    if (seg.family === "feel" && !(seg.query && String(seg.query).trim())) {
      seg.family = "nothing";
      seg.reason = "feel had no query — mechanically downgraded, no real anchor found";
    }
  }
  return segments;
}
