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
character judgment, "he'd never admit how scared he really was", "she carried the weight of
every year that led to this"). This is a PATTERN across any register or domain — hope, fear,
pride, regret, certainty, longing — not a fixed list of phrasings to pattern-match against.
(2) PRESENT IN THIS SEGMENT, not borrowed or invented — the concrete thing has to actually be
there in this segment's own words, resolved from earlier context the way "subject" already is (a
pronoun can resolve to an established person), but not manufactured to paper over a gap, and not
inherited from a NEXT segment this one is merely setting up for ("It wasn't just a missed
penalty." references a penalty but doesn't depict it happening now — it's a rhetorical stepping
stone into whatever comes next).

An anchor CAN be inherited from the IMMEDIATELY PRECEDING segment, the same way "subject"
resolves a pronoun to an established person — but only when this segment is a direct, continuous
extension of that same physical moment, not a later reference back to it. "He stood at the
podium, hands trembling as the crowd fell silent. In that moment, it finally felt like all those
years had led somewhere." — the second segment has no anchor of its own, but it's explicitly still
inside the first segment's scene ("in that moment") — inherits "standing at the podium, hands
trembling", stays "feel", query built from the inherited anchor plus the payoff (e.g. "person at
podium, hands trembling, emotional release"). Contrast: "He scored the winning goal in the final
minute. Three years later, he still couldn't explain why that moment meant so much." — the second
segment is a LATER reflection on the earlier scene, not a continuation of it (a new time, a new
vantage point, nothing physically happening now) — does not inherit the goal-scoring anchor, and
"couldn't explain why it meant so much" is itself a bare internal state with nothing of its own to
anchor to — stays "nothing". The test: is this segment still physically INSIDE the moment the
previous one established (same instant, same scene, just continuing), or has it stepped OUTSIDE
that moment to reflect on it from later/elsewhere? Only the former inherits the anchor.
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

A memory/retrospective-framing verb (remember, recall, still think about, never forgot, talk
about) wrapped around a reference to a real, SPECIFIC, nameable event does NOT disqualify the
subject — the framing verb is a narrative device, not the content itself. "For Cristiano Ronaldo,
many remember the World Cup that slipped away" names a real person (Ronaldo) and a real, specific,
identifiable event (his own World Cup near-miss) — subject: "Cristiano Ronaldo", NOT null, even
though it's phrased as what people remember rather than a direct narration of the event. Test:
strip away the memory-framing verb — is there a real, specific, nameable event/entity still
standing on its own ("the World Cup that slipped away", from Ronaldo — real, specific), or is
what's left purely speculative/hypothetical with nothing actually named ("how different history
would have been" — names no real thing)? Only the latter stays disqualified: "Many England fans
wonder how different history would have been" has no real event named anywhere in it, just
speculation about a timeline that never happened — subject/categoryClaim: null, correctly. This is
a different exclusion than the rhetorical-setup one above ("It wasn't just a missed penalty") —
that one is disqualified because it's INCOMPLETE, gesturing at a payoff the NEXT segment delivers;
a "many remember X" sentence is a COMPLETE, standalone claim about a real X, not an unfinished
setup. The same distinction applies to "categoryClaim" when the subject is a class rather than one
person — "Many players remember the exact moment they signed their first contract" names a real,
common, class-level event (signing a first contract) surviving the same strip-the-verb test, not a
hypothetical.

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
    greater", "many fans wonder how different history would have been", "there was something
    almost sacred about finally being believed" (standing alone, with nothing else described
    happening). Before landing on this bullet, re-run the tie-breaker
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

Set "findable" to null for "feel" and "nothing" segments — "feel" always searches regardless of
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

EDITORIAL VISUAL OVERRIDE — this section deliberately broadens the concreteness rules above.
The product is not only a literal claim extractor. It should think like a skilled faceless-video
editor: when narration has no literal filmed action but strongly implies a familiar visual, it is
allowed to propose that visual. This is controlled inference, not permission to invent facts.

For every non-nothing segment add:
- "visualMode": "exact" | "subject_broll" | "stock"
- "visualQueries": one to three genuinely DIFFERENT searches, best first
- "eraHint": a short year/range/life-stage/team/company-stage clue, or null
- "visualGoal": <=12 words describing what the cut should communicate

Modes:
- "exact": existing evidence behaviour. The footage should show or directly document the stated
  real event/claim. family must be "evidence".
- "subject_broll": the narration is about a resolved, real, findable subject, but the best edit is
  illustrative footage OF THAT SUBJECT rather than proof of an explicitly stated event. family
  must be "evidence", subject must be set, and visualQueries must name the subject. Use this for
  traits, arcs and compressed narration where editors conventionally infer an honest observable
  manifestation. Do not imply a scandal, injury, meeting, quote, relationship, location, or exact
  action with factual stakes unless the script/context supports it. A query is an editorial
  illustration, not evidence that the inferred action occurred at the narrated instant.
- "stock": anonymous illustrative/atmospheric footage. family must be "feel". visualQueries may
  infer an editorial shot even when the text has no literal physical anchor, provided the inferred
  shot is a conventional, low-factual-stakes visual metaphor and clearly communicates the line.
  Prefer human, specific actions and story progression over generic skylines, typing hands, or
  noun-only b-roll.

Do not emit family "reference" for new segments. Reaction/meme discovery is outside the current
product focus because the available indexes do not reliably surface clean, high-quality source
clips. Treat a reference-shaped line as "feel" with an original stock/editorial visual when that
communicates the beat, otherwise "nothing". Never search for a meme merely because one was named.

"nothing" is now reserved for beats where adding a new visual would hurt pacing or fabricate
meaning: pure connective tissue, a deliberate verbal pause, duplicated meaning already covered by
an adjacent beat, or a line with no coherent honest editorial visual. An abstract line is NOT
automatically nothing. First ask what a strong editor would cut to.

SEQUENCE-LEVEL COVERAGE PASS — after making the factual/editorial decision for every segment,
traverse the COMPLETE ordered sequence while maintaining the active visual. Keep every narration
segment and its exact text, but add:
- "coverageMode": "new" | "continue" | "callback" | "none"
- "visualId": a unique stable ID such as "v0" only for new, otherwise null
- "visualRef": the visualId of an EARLIER new row for continue/callback, otherwise null
- "continuityReason": a short honest explanation for continue/callback, otherwise null
- "noneKind": "deliberate_pause" | "narration_only" | "unresolved" only for none, otherwise null

Use "continue" when a line develops, intensifies, labels, or concludes the same onscreen event;
it normally references the currently active visual. Use "callback" only for a deliberate return
to a compatible earlier event or motif. Use "new" when subject, event, time, emotional direction,
or required evidence materially changes. Use "none" only for a genuine narration-only beat, an
intentional pacing pause, or where any visual would fabricate meaning or weaken the edit. A row
whose legacy family would be "nothing" can still continue or callback: it needs no new searchable
content when an already-established visual can honestly cover it. Do not create generic stock
searches merely to reduce none rows, and never replace exact evidence with inferred filler.

Every continue/callback visualRef must point DIRECTLY to an earlier new row, never another
reference. Its subject, era, event and emotional direction must remain compatible with that
origin. A new row retains all normal family, visualMode, query, subject, era and search fields.
Continue/callback rows do not need their own search plan; the referenced new row supplies it.

Use this mechanism for EVERY editorial inference rather than memorizing example mappings:
1. State the line's NARRATIVE FUNCTION: what changes in the viewer's understanding or feeling?
2. List observable manifestations that could communicate that function without claiming a new
   fact. Ask what behaviour, environment, process, detail, consequence, or contrast a camera could
   capture. Derive these from the subject's domain and current story stage, not from a fixed table.
3. Reject manifestations whose factual specificity exceeds the script: invented people, events,
   injuries, places, dates, relationships, or causality. For a real subject, prefer documented
   recurring activity and contextual footage over pretending an inferred shot is the event. For
   anonymous stock, keep identity and factual stakes generic.
4. Enforce continuity: subject, era, domain, established location, and emotional direction.
5. Choose the smallest set of visually distinct searches likely to return usable footage.

The visualQueries must diversify the candidate pool, not paraphrase one another. Each should come
from a different surviving manifestation or shot function—action, process, contextual detail,
environment, consequence, or contrast—when genuinely appropriate. Do not force every category
into every beat. Keep each query search-engine-natural (roughly 3-9 words). For subject_broll
include the resolved subject plus era identifiers. For stock never include a named subject.

Era continuity is mandatory. Infer eraHint from the whole script so far: explicit year/event wins;
otherwise use career stage, age language (childhood/teenage/veteran), team, employer, product era,
location, clothing/kit, or surrounding dated events. Never silently search a subject's current era
for narration about their youth. Put the strongest era discriminator into every subject_broll or
era-sensitive exact query.

The mechanism, not any example phrase, decides the output. Similar adjectives can require entirely
different visuals in different domains or story stages. Conversely, different wording can share a
visual strategy when it serves the same narrative function and passes the factual-risk and
continuity checks. Never choose a shot merely because a prompt example paired it with a keyword.

Backwards compatibility: "query" remains mandatory for every non-nothing segment and must equal
visualQueries[0]. If uncertain about the new fields, preserve the old family/query decision and use
visualMode "exact" for evidence or "stock" for feel. Existing exact evidence must never be
downgraded to inferred b-roll.

Every schema field must be present. Use null for inapplicable scalar fields and [] for inapplicable
visualQueries. Return only the schema-conforming object, with no prose or markdown fences.`;

const nullableString = () => ({ anyOf: [{ type: "string" }, { type: "null" }] });
export const SEGMENT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    segments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          family: { type: "string", enum: ["feel", "evidence", "reference", "nothing"] },
          subject: nullableString(),
          categoryClaim: nullableString(),
          findable: { anyOf: [{ type: "string", enum: ["likely", "unlikely"] }, { type: "null" }] },
          query: nullableString(),
          reason: nullableString(),
          visualMode: { anyOf: [{ type: "string", enum: ["exact", "subject_broll", "stock"] }, { type: "null" }] },
          visualQueries: { type: "array", items: { type: "string" } },
          eraHint: nullableString(),
          visualGoal: nullableString(),
          coverageMode: { type: "string", enum: ["new", "continue", "callback", "none"] },
          visualId: nullableString(),
          visualRef: nullableString(),
          continuityReason: nullableString(),
          noneKind: { anyOf: [{ type: "string", enum: ["deliberate_pause", "narration_only", "unresolved"] }, { type: "null" }] },
        },
        required: ["text", "family", "subject", "categoryClaim", "findable", "query", "reason", "visualMode", "visualQueries", "eraHint", "visualGoal", "coverageMode", "visualId", "visualRef", "continuityReason", "noneKind"],
        additionalProperties: false,
      },
    },
  },
  required: ["segments"],
  additionalProperties: false,
};

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

  const encoder = new TextEncoder();
  const upstreamAbort = new AbortController();
  let cancelled = false;
  const body = new ReadableStream({
    async start(controller) {
      // Flush the response immediately and keep the browser-facing Cloudflare connection alive
      // while Anthropic's long SSE response is consumed. Leading JSON whitespace is valid.
      controller.enqueue(encoder.encode(" ".repeat(2048)));
      const heartbeat = setInterval(() => {
        if (!cancelled) controller.enqueue(encoder.encode("\n" + " ".repeat(1024)));
      }, 10000);
      try {
        const segments = await generateVisualPlan(env, script, upstreamAbort.signal);
        if (!cancelled) controller.enqueue(encoder.encode(JSON.stringify({ segments })));
      } catch (err) {
        if (!cancelled) controller.enqueue(encoder.encode(JSON.stringify({ error: err.message || "Segmentation failed" })));
      } finally {
        clearInterval(heartbeat);
        if (!cancelled) controller.close();
      }
    },
    cancel() {
      cancelled = true;
      upstreamAbort.abort("Browser request cancelled");
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-encoding": "identity",
      "x-accel-buffering": "no",
    },
  });
}

async function generateVisualPlan(env, script, signal) {
  try {
    const claudeRes = await claudeChat(env, {
      model: "claude-sonnet-5",
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: script }],
      // The declared ceiling is not prepaid: Anthropic bills tokens actually generated. A
      // script-length formula truncated a real 72-row continuity response at ~11k characters,
      // wasting the user's paid request. Always leave the full supported headroom instead.
      max_tokens: 32000,
      output_schema: SEGMENT_OUTPUT_SCHEMA,
      // Long structured responses can exceed Anthropic's non-streaming edge timeout (524).
      // Consume Anthropic SSE server-side, then run the same validation/normalization pipeline.
      stream: true,
      signal,
    }, 0); // A paid segmentation click must never fan out into automatic retries.

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      throw new Error(`Claude error: ${errText}`);
    }

    const data = await claudeRes.json();
    const parsed = parseClaudeSegmentsResponse(data);

    if (!Array.isArray(parsed.segments)) {
      throw new Error("Model did not return a segments array");
    }

    const merged = mergeFragments(parsed.segments);
    validateScriptCoverage(script, merged);
    const evidenceResolved = enforceEvidenceRule(merged);
    const findabilityResolved = enforceFindabilityRule(evidenceResolved);
    const focused = enforceProductFocus(findabilityResolved);
    // enforceVisualPlan must run BEFORE enforceFeelQueryRule: it's what backfills the legacy
    // `query` field from `visualQueries[0]` when the model puts a real query only in the new
    // field. Run the downgrade check first and a segment with a good visualQueries but an empty
    // legacy query gets wrongly and permanently downgraded to "nothing" before it ever reaches
    // the backfill — exactly the "prompt-only field stays in sync" assumption this file's own
    // history warns doesn't hold.
    const visualResolved = enforceVisualPlan(focused);
    const queryResolved = enforceFeelQueryRule(visualResolved);
    const corrected = normalizeCoveragePlan(queryResolved);

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
        `coverage=${seg.coverageMode} visualId=${seg.visualId ?? "-"} visualRef=${seg.visualRef ?? "-"} ` +
        `subject=${JSON.stringify(seg.subject ?? null)} categoryClaim=${JSON.stringify(seg.categoryClaim ?? null)} ` +
        `findable=${seg.findable ?? "-"} query=${JSON.stringify(seg.query ?? null)} ` +
        `reason=${JSON.stringify(seg.reason ?? null)} text=${JSON.stringify(seg.text.slice(0, 100))}`
      );
    });
    const coverage = summarizeCoverage(corrected);
    console.log(`[segment] reqId=${reqId} coverage=${JSON.stringify(coverage)}`);

    return corrected;
  } catch (err) {
    throw err;
  }
}

export function parseClaudeSegmentsResponse(data) {
  if (data?.stop_reason === "max_tokens") {
    throw new Error("Claude exhausted the 32,000-token output limit before finishing the visual plan");
  }
  if (data?.stop_reason !== "end_turn") {
    throw new Error(`Claude stopped before completing the visual plan (${data?.stop_reason || "missing stop reason"})`);
  }
  const content = extractJson(extractText(data));
  return JSON.parse(content);
}

export function validateScriptCoverage(script, segments) {
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim();
  if (normalize(segments.map(seg => seg.text).join(" ")) !== normalize(script)) {
    throw new Error("Claude's segments did not preserve the complete script exactly");
  }
  return segments;
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

// Reaction/reference retrieval is intentionally out of scope for newly segmented projects. Keep
// the old endpoint and frontend path working for saved legacy projects, but normalize any new
// model-produced reference beat into the stock/editorial path (or nothing when it has no usable
// fallback query).
export function enforceProductFocus(segments) {
  for (const seg of segments) {
    if (seg.family !== "reference") continue;
    seg.family = seg.query && String(seg.query).trim() ? "feel" : "nothing";
    delete seg.findable;
    seg.reason = seg.family === "feel"
      ? `reference replaced by editorial stock: ${seg.reason || "visual fallback"}`
      : "reference has no reliable visual source";
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
    if (seg.family !== "feel") continue;
    const hasQuery = Boolean(seg.query && String(seg.query).trim());
    // Don't rely solely on pipeline order backfilling `query` from `visualQueries[0]` — check
    // both directly, so this stays correct even if a future reorder breaks that assumption again.
    const hasVisualQuery = Array.isArray(seg.visualQueries) &&
      seg.visualQueries.some((q) => String(q || "").trim());
    if (!hasQuery && !hasVisualQuery) {
      seg.family = "nothing";
      seg.reason = "feel had no query — mechanically downgraded, no real anchor found";
    }
  }
  return segments;
}

// New editor-planning fields are additive. Old projects and imperfect model responses retain the
// exact pre-feature behaviour: query is always the first search, evidence defaults to exact, and
// feel defaults to stock. Invalid subject_broll cannot accidentally turn anonymous filler into
// purported footage of a real person.
export function enforceVisualPlan(segments) {
  for (const seg of segments) {
    if (seg.family === "nothing") {
      delete seg.visualMode;
      delete seg.visualQueries;
      delete seg.visualGoal;
      delete seg.eraHint;
      continue;
    }

    const fallbackMode = seg.family === "evidence" ? "exact" : "stock";
    let mode = ["exact", "subject_broll", "stock"].includes(seg.visualMode)
      ? seg.visualMode
      : fallbackMode;
    if (mode === "subject_broll" && !(seg.subject && String(seg.subject).trim())) mode = fallbackMode;
    if (seg.family === "feel") mode = "stock";
    if (seg.family === "evidence" && mode === "stock") mode = "exact";

    const rawQueries = Array.isArray(seg.visualQueries) ? seg.visualQueries : [];
    const queries = [seg.query, ...rawQueries]
      .map((q) => String(q || "").trim())
      .filter(Boolean)
      .filter((q, i, all) => all.findIndex((x) => x.toLowerCase() === q.toLowerCase()) === i)
      .slice(0, 3);

    seg.visualMode = mode;
    seg.visualQueries = queries;
    seg.query = queries[0] || seg.query || null;
    seg.eraHint = seg.eraHint && String(seg.eraHint).trim() ? String(seg.eraHint).trim().slice(0, 100) : null;
    seg.visualGoal = seg.visualGoal && String(seg.visualGoal).trim() ? String(seg.visualGoal).trim().slice(0, 160) : null;
  }
  return segments;
}

const COVERAGE_MODES = new Set(["new", "continue", "callback", "none"]);
const NONE_KINDS = new Set(["deliberate_pause", "narration_only", "unresolved"]);

function hasUsableSearchPlan(seg) {
  return seg.family !== "nothing" && Boolean(
    (seg.query && String(seg.query).trim()) ||
    (Array.isArray(seg.visualQueries) && seg.visualQueries.some(q => String(q || "").trim()))
  );
}

// Normalize both new model output and legacy saved-project shapes. References are validated in
// one ordered pass, so forward refs, duplicate IDs, and chains can never survive. This function
// mutates only the in-memory/API result; the frontend does not rewrite localStorage.
export function normalizeCoveragePlan(segments) {
  const origins = new Map();
  const claimedIds = new Set();

  segments.forEach((seg, index) => {
    const suppliedMode = COVERAGE_MODES.has(seg.coverageMode) ? seg.coverageMode : null;
    let mode = suppliedMode || (seg.family === "nothing" ? "none" : "new");
    const suppliedId = seg.visualId && String(seg.visualId).trim();

    if (mode === "new") {
      let id = suppliedId;
      if (!id || claimedIds.has(id)) {
        id = `legacy-v${index}`;
        while (claimedIds.has(id)) id = `${id}-x`;
      }
      claimedIds.add(id);
      if (hasUsableSearchPlan(seg)) {
        seg.coverageMode = "new";
        seg.visualId = id;
        seg.visualRef = null;
        seg.continuityReason = null;
        seg.noneKind = null;
        origins.set(id, seg);
        return;
      }
      mode = "none";
    }

    if (mode === "continue" || mode === "callback") {
      const ref = seg.visualRef && String(seg.visualRef).trim();
      const origin = ref ? origins.get(ref) : null;
      const subjectConflict = origin && seg.subject && origin.subject &&
        String(seg.subject).trim().toLowerCase() !== String(origin.subject).trim().toLowerCase();
      const eraConflict = origin && seg.eraHint && origin.eraHint &&
        String(seg.eraHint).trim().toLowerCase() !== String(origin.eraHint).trim().toLowerCase();
      if (origin && !subjectConflict && !eraConflict) {
        seg.coverageMode = mode;
        seg.visualId = null;
        seg.visualRef = ref;
        seg.continuityReason = seg.continuityReason && String(seg.continuityReason).trim()
          ? String(seg.continuityReason).trim().slice(0, 200)
          : "continues an earlier visual";
        seg.noneKind = null;
        return;
      }
      if (hasUsableSearchPlan(seg)) {
        let id = suppliedId || `fallback-v${index}`;
        while (claimedIds.has(id)) id = `${id}-x`;
        claimedIds.add(id);
        seg.coverageMode = "new";
        seg.visualId = id;
        seg.visualRef = null;
        seg.continuityReason = null;
        seg.noneKind = null;
        origins.set(id, seg);
        return;
      }
      mode = "none";
    }

    seg.coverageMode = "none";
    seg.visualId = null;
    seg.visualRef = null;
    seg.continuityReason = null;
    seg.noneKind = suppliedMode === "none" && NONE_KINDS.has(seg.noneKind)
      ? seg.noneKind
      : "unresolved";
  });
  return segments;
}

export function summarizeCoverage(segments) {
  const summary = { total: segments.length, new: 0, continue: 0, callback: 0, none: 0, unresolved: 0, fullyNothingRate: 0 };
  for (const seg of segments) {
    if (Object.hasOwn(summary, seg.coverageMode)) summary[seg.coverageMode] += 1;
    if (seg.coverageMode === "none" && seg.noneKind === "unresolved") summary.unresolved += 1;
  }
  summary.fullyNothingRate = summary.total ? summary.none / summary.total : 0;
  return summary;
}
