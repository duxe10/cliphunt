// Cloudflare Pages Function — POST /api/segment
// Ported from netlify/functions/segment.js (Netlify handler -> Pages onRequestPost,
// process.env -> context.env). Prompt + mergeFragments logic is unchanged.
// Moved to Claude Sonnet (2026-07-18) from Groq's llama-3.3-70b-versatile — the highest-stakes,
// most failure-prone call all session (TPM limits, the barista/groundskeeper shape-bias, the
// abstract-state gap), and the one call per script, so cost stays predictable per project. This
// is a real billed Anthropic balance, not a free tier — see _claude.js's header comment.
import { claudeChat, extractText, extractJson } from "./_claude.js";
import { ipTrialKey, scriptSeconds, TRIAL_SECONDS_MAX, TRIAL_SECONDS_MAX_ACCOUNT } from "./_auth.js";

// 2026-07-22: EDITORIAL VISUAL PLANNING + SEQUENCE COVERAGE. Two additive layers on top of the
// classification prompt above (unchanged): (1) per-segment visualMode/visualQueries/eraHint/
// visualGoal so a skilled-editor inference (subject b-roll, an honest stock metaphor) can be
// planned up front instead of only ever searching the literal claim; (2) a whole-sequence
// coverageMode pass (new/continue/callback/none) so adjacent beats about the same moment share one
// visual instead of re-searching per segment. Both are consumed by evidence-search.js/app.js as
// optional priors — a segment with none of these fields degrades to exactly the old behavior.

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

Before naming a categoryClaim, judging "feel" vs. "nothing", or judging "depictionType", run one
test on the segment's actual content — this is the single test that governs every one of those
judgments, not a separate check for each field: can you point to ONE concrete, physically
depictable thing that is doing or happening, using only the words actually in THIS segment? Two
parts, both required:
(1) CONCRETE, not abstract — the thing must be an action, event, or physical scene (a body doing
something, an object, a setting, a crowd's visible reaction) — not a mental state, a value
judgment, a reputation claim, a vague aspiration, or an abstract intensity ("gives me a little
hope", "the dream was alive", "the pressure couldn't have been greater", "he'd never admit how
scared he really was", "she carried the weight of every year that led to this"). This is a
PATTERN across any register or domain — hope, fear, pride, regret, certainty, longing — not a
fixed list of phrasings to pattern-match against.
(2) PRESENT IN THIS SEGMENT, not borrowed or invented — the concrete thing has to actually be
there in this segment's own words, resolved from earlier context the way "subject" already is (a
pronoun can resolve to an established person), but not manufactured to paper over a gap, and not
inherited from a NEXT segment this one is merely setting up for ("It wasn't just a missed
penalty." references a penalty but doesn't depict it happening now — it's a rhetorical stepping
stone into whatever comes next).

Note what this test does NOT govern: naming "subject" itself. "Subject" has its own, looser test
(below, right after this gate) — a real, specific, identifiable entity/event is enough on its own,
even without a concrete action attached (a reputation/character judgment like "trusted him for
that resilience" no longer nulls "subject" the way it used to — see below). This concreteness gate
still fully governs "categoryClaim" (a class-level version of the same test), "feel" vs. "nothing",
and — once a real subject exists — "depictionType" (whether that subject's content is specific
enough for a photo search). Keep these separate: "is there a real subject here" is a different,
looser question than "is there a concrete action here."

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

The same inheritance principle extends to "subject" itself, not just to a "feel" anchor: when a
segment names no person/action of its own, but the immediately preceding segments have already
established a specific, real, ongoing EVENT this segment is still narratively inside — not a new
topic, not a later reflection — inherit that event as "subject", with "depictionType":"fallback"
(see below): there's no NEW depicted instant here, just continuation of the one already
established. "Then Croatia slowly took control." — no subject of its own, but several preceding
segments already established a real 2018 World Cup semi-final against Croatia — inherits subject:
"2018 World Cup semi-final, England vs Croatia", depictionType: "fallback"; the query searches for
real footage of the match generally, not a fabricated new instant. Contrast: "Four years later, in
Qatar, he did." also inherits the subject whose story this is, but ALSO introduces genuinely new,
specific, locatable content of its own (a new tournament, a new place — "he got another chance" —
in Qatar) — this is "instant", not "fallback", since "in Qatar" is new information this segment
adds, not bare continuation. Same test as the feel-anchor case above: is this segment still
narratively INSIDE the event the preceding segments established (inherits), or has it moved to a
new topic or a later vantage point (does not inherit)?

A separate, easily-confused case: a short "Then/But then came [NAME]." fragment that introduces a
BRAND NEW opponent/event for the first time — not a later reflection, not a repeat mention of
someone already fully established, but the NEXT STEP in an ongoing progression (a next match, a
next round). This is real, specific content (a genuine real fixture is happening), not a bare
name-drop, even though the sentence is short and gives no further detail itself — resolve subject
to the actual matchup/event, not just the bare new name. "Then came France." — after a script
narrating England's group stage and Round of 16 win over Senegal, this introduces France as the
NEXT, brand-new opponent for the first time: subject: "England vs France, 2022 World Cup
quarterfinal", depictionType: "instant" (a specific, real, newly-established fixture — a real
photo/video search is worth trying, same reasoning \`evidence-search.js\`'s own context-resolution
rules already apply once they get the chance). Same pattern, same script: "But then came Croatia."
introduces Croatia as the next opponent for the first time (the semi-final) — subject: "England
vs Croatia, 2018 World Cup semi-final", depictionType: "instant" for the same reason.

Do NOT confuse this with the "asserts nothing about a real name" guard below (the "Then Harry Kane
happened." case) — the test that tells them apart: does "Then [X]" introduce a NEW real
name/event that wasn't the established subject a moment ago (a new opponent, a new stage — real
content, subject gets set), or does it just re-mention someone who WAS ALREADY the entire story's
subject, adding no new person, event, or fact at all (bare hype, subject stays null)? "Then came
France." names someone NEW; "Then Harry Kane happened." names someone the whole script had already
been about for several segments and adds nothing further about him.

If either part fails, there is nothing here for a stock-footage search to find via "feel" — a
quantifier+category grammar shape or an emotionally loaded phrase is not sufficient on its own to
rescue it into "feel". This is the test "categoryClaim", "feel"'s query-writing, "nothing", and
"depictionType" all apply below — treat it as one gate for those, not a separate check for each.
"Subject" is the one field that does NOT run through this same gate — see below for its own,
looser test.

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
"A missed penalty." has subject "Harry Kane"). Naming a subject requires only ONE thing: is there
a real, specific, identifiable entity or event actually being talked about — NOT whether the
content attached to it is a depictable action. A trait, a reputation claim, a record, or an
inherited real event about a real named subject is enough on its own; a resolvable name is still
necessary, but the old requirement that a depictable action be attached to it is gone — see
"depictionType" below for how that distinction is made instead, without gating whether "subject"
gets set at all.

Two ways subject can still fail to resolve, and they are NOT the same failure — keep them
separate, don't blur them into one test:
(1) No real, specific, identifiable entity/event survives at all, from this segment or from
context — "The chat lost it when the demo video hit the front page." names an unnamed "chat," an
unnamed demo, nothing real anywhere. subject: null.
(2) A real name DOES resolve, but the segment asserts literally nothing about it beyond bare
existence or mention — strip the name/pronoun out and there is nothing left. "Then Harry Kane
happened." resolves to a real player but claims no trait, no record, no event, nothing at all —
subject: null, family "nothing", same as before. Cross-reference: this is NOT the same as "Then
came France."/"But then came Croatia." (see the event-inheritance section above) — those introduce
a brand NEW opponent/event for the first time, which IS real content (a genuine new fixture), not
a bare re-mention of an already-fully-established subject. Re-check that section's distinguishing
test before nulling a short "Then [X]" fragment.
Contrast both of those against: "That resilience is one of the reasons teammates and managers
continue to trust him." resolves "him" to a real, already-established player, AND makes a real,
complete, standalone claim about him (a reputation/trust judgment) — strip the pronoun and "is
trusted for this resilience" survives as real content. subject: "[player name]", NOT null — this
is exactly the kind of segment that used to be wrongly nulled just because a trust judgment isn't
a depictable action.

A third, different failure stays exactly as strict as it was — don't let the loosening above
rescue this one too: an evidence-sounding noun phrase used only as an INCOMPLETE rhetorical
stepping stone toward whatever the NEXT segment delivers, not a complete claim in its own right.
"It wasn't just a missed penalty." doesn't depict the penalty happening now and doesn't stand on
its own — it exists only to set up a contrast the next segment pays off. subject: null. The test
that tells this apart from the resilience/trust case above: does this segment need the NEXT
segment to deliver its actual content (stays null), or is it already a complete claim, needing
nothing further (subject gets set)? "That resilience is why they trust him" doesn't need a
following segment to mean anything; "It wasn't just a missed penalty." does.

A fourth failure, easy to miss because it passes the "real, specific, identifiable entity" test on
a technicality: a mid-roll SPONSOR/AD READ — a pivot to a product or service pitch that has nothing
to do with the video's actual subject, typically signaled by "this episode/video is sponsored by",
"today's sponsor", "use code X", "download the Y app", or a similarly abrupt tonal/topic break into
promotional copy. The sponsor is often a real, nameable company — that alone does NOT qualify it as
"subject". The test isn't "is a real entity named", it's "is this actually part of the narrative
this video is about". A sponsor plug is about the sponsor, not the video's topic — finding real
footage of the sponsor's product/app is never useful evidence for the story being told, and
searching for it wastes a real API call on something no editor would ever cut to here. subject:
null, categoryClaim: null, family: "nothing", reason: "sponsor/ad read, not part of the narrative" —
regardless of how many real, checkable facts the sponsor copy itself contains.

Contrast with a genuinely depicted action, still the strongest case: "He was still out training
alone at 6am, months after the injury." — subject: "[player name]", and (see "depictionType"
below) this one is "instant", not "fallback". Set "subject" to null whenever neither a real entity
nor a real claim/event about it survives — null is still correct whenever nothing real can be
identified at all; the bar that moved is "does this depict an action," not "is there a real
subject here."

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

Once "subject" or "categoryClaim" is set, also judge "depictionType": "instant" or "fallback" —
NOT "does this segment show an action," but "is there a well-defined, SPECIFIC visual target worth
searching an actual photograph for," which is a broader question than that. This judgment is
diagnostic/UI display only now — evidence-search.js judges its own per-claim "mediaType"
independently per click and does not read this field; reason about the four cases below purely as
a specificity classification exercise, not as something that drives a real search decision. Four
cases:
- "instant": a specific physical action/moment ("He was still out training alone at 6am..."), a
  specific real event that this segment adds genuinely new, locatable detail to (the Qatar-arrival
  example above), a specific real event embedded elsewhere in the SAME sentence even when the
  sentence's main clause is a general claim (see the post-match-interview example below), or a
  checkable stat/record/ranking claim that a graphic could represent (see below). A real photo
  search is worth trying.
- "fallback": a real subject/event is set, but nothing in this segment is a specific enough target
  for a photo search — a bare trait/reputation/role claim (Bellingham "emerged as a superstar,"
  Saka "was electric," the resilience/trust example above), or an inherited event with nothing new
  added (the Croatia example above). A general real-footage search is still worth trying; a photo
  search is not (too likely to return generic, unverifiable junk for a query this broad).
categoryClaim-based evidence is almost always "instant" — a categoryClaim by definition names a
real, capturable class-level action ("footballers celebrating a World Cup goal" already IS a
specific enough visual target).

Two special cases worth naming explicitly, since they're easy to under- or over-apply:
- A checkable stat/record/ranking claim about a subject — a real, countable fact, not just
  superlative praise — is "instant" even though nothing is physically happening: "He was already
  England's all-time leading goalscorer and one of the greatest strikers the country has ever
  produced." names a real, checkable record (a specific stat) — depictionType: "instant", and the
  query should target a STATS GRAPHIC or leaderboard representing the fact (e.g. "England men's
  all-time goalscorers chart"), not a generic photo of the player and not a fabricated action.
  Contrast: "He was one of the greatest strikers of his generation" alone, with no attached
  number/record/ranking, is bare superlative praise with nothing a chart could represent either —
  this stays "fallback" (a general subject search), not a stats-graphic search.
- When a sentence's MAIN clause is a general/fallback claim but it ALSO contains a separate, real,
  specific event elsewhere in its own text, the specific event wins: "After the match, he accepted
  responsibility and continued captaining England instead of letting the miss define him." — "he
  accepted responsibility" names a real, specific, genuinely broadcast event (a post-match
  interview/press conference), even though "continued captaining England" alone would only be
  "fallback". depictionType: "instant" — prefer the specific real event over the generic claim
  sitting next to it in the same sentence, don't average them or default to the weaker one.

Omit "depictionType" entirely for "feel", "reference", and "nothing" segments.

Then pick one "family":
- "feel" — "subject" is null AND "categoryClaim" is null, AND the concreteness test above still
  finds a real, present-in-the-text anchor to work with: atmosphere, mood, scene-setting, ordinary
  unnamed incidental background activity, or an internal/emotional state that's genuinely anchored
  to a physical gesture or setting described in the segment (see the query-writing guidance
  below). All of it gets real stock footage.
- "evidence" — EITHER "subject" is set (a specific real person/team/org/event this segment is
  about, or has inherited from an already-established event — see the subject rules above; no
  depicted action is required, just a real, identifiable entity/event with real content attached),
  OR "categoryClaim" is set (a genuine categorical claim about a class of real people/things doing
  something a camera could capture). Both flavors search for real footage or images — a named
  subject's exact moment when "depictionType" is "instant", general real footage of that subject
  or event when "fallback" — never stock b-roll, in either case. Because "subject" and
  "categoryClaim" already passed the resolution rules above by the time you reach this point, no
  further content check is needed here — just check whether either field is actually set.
- "reference" is disabled for new projects — reaction/meme discovery is currently out of scope
  (the retrieval side exists for old saved projects and a possible future re-enable, but new
  segmentation must never produce it). A moment that looks like a known meme/cultural callback
  should classify as "feel" (an original stock/editorial visual honestly communicating the beat)
  if a real anchor exists, otherwise "nothing" — run it through those tests exactly as normal,
  don't reach for a meme match.
- "nothing" — the concreteness test above fails outright: after looking for one concrete,
  physically depictable thing actually present in this segment's own text, nothing survives. This
  single test covers several different SURFACES, which are not separate rules but the same
  failure showing up in different grammar:
  - connective narration, meta asides, or a setup clause that only makes sense combined with the
    next segment's visual ("But that wasn't the end of the story.", "Here's the thing.") — there
    was never any content here, concrete or otherwise, only a transition.
    **Do NOT put a "Then/But then came [NAME]." fragment here just because it's short and shaped
    like a transition** — check it against the subject-resolution rule near the top of this prompt
    FIRST, before reaching for this bullet. "Then came France." LOOKS like the same shape as "But
    that wasn't the end of the story." (both short, both start a new beat), but it is NOT the same
    failure: "But that wasn't the end of the story" names nothing at all, real or otherwise, while
    "Then came France" names an actual new opponent — real content, not a transition. A transition
    phrase that also happens to introduce a brand-new real name/event is NOT pure connective
    narration; it gets a subject (see above) and is NOT "nothing". Only land here when stripping
    the transitional framing leaves nothing real behind, the same way stripping a memory-framing
    verb is tested elsewhere in this prompt.
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
  - a resolvable name or evidence-sounding noun phrase used only as an INCOMPLETE rhetorical
    stepping stone toward whatever the NEXT segment delivers, not a complete claim in its own
    right: "It wasn't just a missed penalty." (references a penalty to set up a contrast, doesn't
    depict it happening now, and needs the next segment to mean anything). This is a DIFFERENT
    failure from a real, complete claim about an already-resolved subject — see the "subject"
    rules above for that contrast: a trust/reputation judgment like "that resilience is why they
    trust him" is NOT this failure anymore, since it's a complete claim standing on its own — it
    now sets "subject" (depictionType "fallback"), it does not land here.
  - a real name resolves, but the segment asserts nothing at all beyond bare existence or mention
    — "Then Harry Kane happened." names a real player but claims no trait, record, or event about
    him; strip the name out and nothing real is left. See the "subject" rules above for the fuller
    version of this test.
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
"categoryClaim" resolve, plus "depictionType" — e.g. "resolved subject: Harry Kane; action:
training alone at 6am; instant", "resolved subject: Jude Bellingham; reputation claim, no action;
fallback", "categoryClaim: startups failing; visible action: office packed into boxes; instant".
For
"nothing", keep naming which failure above applies, unchanged — e.g. "abstract state, no action",
"bare internal state, no anchor", "rhetorical setup, not depicted now", "asserts nothing about a
real name", "connective narration only". This field is never shown to the end user; it exists purely
so the classification AND the query can be audited straight from the API response — a vague
"feel"/"evidence" query paired with a thin or generic "reason" points at weak reasoning (the
anchor itself was thin), while a vague query paired with a specific, well-anchored "reason" points
at a phrasing problem in the query itself, not a classification problem. Keep it to a handful of
words, same length as before — this is a diagnostic tag, not a second explanation.

Also include a "query" for every segment EXCEPT "nothing": a SHORT DESCRIPTIVE VISUAL SCENE
PHRASE, roughly 3-7 words, for searching a real stock-footage library — describe the shot itself,
not a mood word or an abstract claim, and never include "subject"'s name in it. Err toward the
fuller end of that range whenever a physical anchor needs an emotional tone or arc layered onto
it (see the anchor+tone special case below) — a query too short to carry both the anchor and the
tone loses the tone first, which is exactly what makes a query read as generic instead of
specific. This is the primary search for "feel" segments, and a fallback for "evidence" segments
in case no specific subject can actually be confirmed later. Good queries:
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

EDITORIAL VISUAL PLANNING — additive, applies only to "feel" and "evidence" segments (never
"reference" or "nothing", which keep their own separate pipelines/no-visual status unchanged).
For each such segment add:
- "visualMode": "exact" | "subject_broll" | "stock"
- "visualQueries": one to three genuinely DIFFERENT searches, best first
- "eraHint": a short year/range/life-stage/team/company-stage clue, or null
- "visualGoal": <=12 words describing what the cut should communicate

"exact" is "evidence"'s existing behavior unchanged: the footage should show or directly document
the stated real event/claim. "subject_broll" is also "evidence" (subject must be set, and every
query must name the subject), but for traits/arcs/compressed narration where a skilled editor would
use truthful illustrative footage OF THAT SUBJECT rather than proof of the literal claim — this is
not evidence the inferred action happened at the narrated instant, so don't invent high-stakes
facts (an unstated event, injury, quote, relationship). "stock" is "feel"'s existing behavior,
just now allowed to infer a conventional, low-factual-stakes visual metaphor when the text has no
literal physical anchor of its own, provided the visualQueries still communicate the line honestly.

Era continuity is NOT limited to subject_broll — set "eraHint" for ANY evidence claim whose subject
recurs at multiple, meaningfully different points in time across the script, "exact" included. A
recurring ORGANIZATION or TEAM subject is exactly as prone to this as an individual: a script that
revisits "England" at 1966, then the early 2000s, then the present day is narrating three real but
completely different squads, kits, eras of footage — an "exact" claim about the 1966 team needs
1966 archival footage exactly as much as a subject_broll claim about a young player needs young-era
footage, and the same silent-current-era-default failure applies equally to both. Infer eraHint
from the whole script so far (explicit year/event wins; otherwise career stage, age language, team/
employer/squad generation, product era, location, kit/clothing, or surrounding dated events) and
put the strongest discriminator into every query for that segment — never silently search a
recurring subject's current/most-recent era for narration that's actually about an earlier one, and
never let one era's resolved eraHint carry over into a segment that has jumped to a different one.

Worked example, a recurring TEAM subject across three widely separated eras, non-adjacent and out
of the order they're later referenced: a script narrates "In 1966, England won their only World
Cup." (subject: "England national team", eraHint: "1966 World Cup winners"), several segments
later "By the early 2000s, England had a so-called Golden Generation — Beckham, Gerrard, Lampard,
all at their peak." (same subject string "England national team", but eraHint: "early 2000s Golden
Generation") — a genuinely different eraHint despite the identical subject name, because this is a
real, different squad/kit/era of footage — and later still "Today's England side plays a completely
different way." (subject: "England national team", eraHint: "current squad"). All three are
evidence, "exact", the same named subject — but three real, distinct, non-interchangeable eras of
archival footage. Confusing any two of them (e.g. searching 1966-era footage for the "today" claim,
or vice versa) is the same class of failure "never silently search a subject's current era for
narration about their youth" already names for individuals, just for a recurring organization
instead of a person.

The visualQueries must diversify the candidate pool, not paraphrase one another — each from a
different observable manifestation (action, process, environment, consequence, contrast), 3-9 words,
search-engine-natural. Backwards compatibility: "query" remains mandatory exactly as the prompt
above already requires, and must equal visualQueries[0].

SEQUENCE-LEVEL COVERAGE PASS — after every segment's factual/editorial decision is made, traverse
the COMPLETE ordered sequence while maintaining the active visual. Keep every segment's exact text,
but add:
- "coverageMode": "new" | "continue" | "callback" | "none"
- "visualId": a unique stable ID such as "v0" only for new, otherwise null
- "visualRef": the visualId of an EARLIER new row for continue/callback, otherwise null
- "continuityReason": a short honest explanation for continue/callback, otherwise null
- "noneKind": "deliberate_pause" | "narration_only" | "unresolved" only for none, otherwise null

Use "continue" when a segment develops, intensifies, labels, or concludes the same onscreen event —
it normally references the currently active visual. Use "callback" only for a deliberate return to
a compatible earlier event/motif. Use "new" when subject, event, time, or emotional direction
materially changes, or for any segment with its own search plan. Use "none" for "nothing" segments,
or wherever an already-established visual can honestly cover a beat without a new search. Every
continue/callback visualRef must point DIRECTLY to an earlier new row, never another reference, and
its subject/era must stay compatible with that origin.

The single test that actually decides "new" vs "continue" within an ongoing match/event, since this
is the most common way this gate gets misapplied — inconsistently, in BOTH directions, not just one:
does THIS segment's own text name a DIFFERENT specific, real, separately-documented action than
whatever the currently-active visual already covers (a different goal, a different player's
specific moment, a different named incident)? If yes, it's "new" — it has its own real, distinct,
individually-findable footage, even though the match/event around it hasn't changed. Only use
"continue" when this segment is narrating or elaborating on the SAME single already-covered
action/instant — not a fresh one — or is genuinely connective/descriptive text with nothing of its
own to search (hype framing, a scoreline restated, a transition).

Two contrasting worked examples, same script, to make the distinction concrete: "England took the
lead through a long-range free kick." (new — a specific, real, individually-findable goal) ->
"The opponent leveled it midway through the second half, then completed the comeback in extra
time." (STILL new, even mid-match — TWO more distinct real goals are named here, neither is the
free kick already covered; if a sentence like this names more than one new action, split it into
separate claims at evidence-search time, not fold it into a continue of the free kick). Contrast:
"He stepped up to the penalty spot." -> "Facing the goalkeeper who was his own club teammate." ->
"He drove it into the corner." — this is ONE continuous real action (a single penalty kick)
narrated across three short sentences — only the FIRST is "new"; the other two are "continue",
because neither adds a different action, they're the same instant continuing. The failure mode to
avoid in both directions: don't collapse several genuinely different real goals into one "continue"
chain just because they're part of the same match (throws away real, specific, findable footage for
each one), and don't split one single continuous action into several "new" entries just because it's
narrated across multiple short sentences (wastes several searches on what is really one clip).

Return strict JSON only, no prose, no markdown fences:
{"segments":[{"text":"...","family":"feel","subject":null,"categoryClaim":null,"query":"...","reason":"...","visualMode":"stock","visualQueries":["..."],"eraHint":null,"visualGoal":"...","coverageMode":"new","visualId":"v0","visualRef":null,"continuityReason":null,"noneKind":null},{"text":"...","family":"evidence","subject":"...","categoryClaim":null,"depictionType":"instant","query":"...","reason":"...","visualMode":"exact","visualQueries":["..."],"eraHint":"...","visualGoal":"...","coverageMode":"new","visualId":"v1","visualRef":null,"continuityReason":null,"noneKind":null},{"text":"...","family":"evidence","subject":null,"categoryClaim":"...","depictionType":"fallback","query":"...","reason":"...","visualMode":"exact","visualQueries":["..."],"eraHint":null,"visualGoal":"...","coverageMode":"continue","visualId":null,"visualRef":"v1","continuityReason":"...","noneKind":null},{"text":"...","family":"nothing","subject":null,"categoryClaim":null,"reason":"...","visualMode":null,"visualQueries":[],"eraHint":null,"visualGoal":null,"coverageMode":"none","visualId":null,"visualRef":null,"continuityReason":null,"noneKind":"narration_only"}]}`;

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
          // "reference" is deliberately excluded here, not just discouraged in the prompt above —
          // this is the actual enforcement (Anthropic's structured output constrains token
          // generation to the schema, so the model literally cannot produce a value outside this
          // list). reference-search.js/the frontend's reference-family rendering are untouched and
          // still work for OLD saved projects with real "reference" segments; only new
          // segmentation calls are affected. Re-add "reference" here to switch reaction/meme
          // discovery back on for new projects.
          family: { type: "string", enum: ["feel", "evidence", "nothing"] },
          subject: nullableString(),
          categoryClaim: nullableString(),
          depictionType: { anyOf: [{ type: "string", enum: ["instant", "fallback"] }, { type: "null" }] },
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
        required: ["text", "family", "subject", "categoryClaim", "depictionType", "query", "reason", "visualMode", "visualQueries", "eraHint", "visualGoal", "coverageMode", "visualId", "visualRef", "continuityReason", "noneKind"],
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

  // A pasted script commonly leads with a markdown-style title line ("# Harry Kane's World Cup
  // Curse") — a label, not narration. Confirmed live: Claude silently drops it from the segments
  // array (reasonably, since it isn't spoken content), which then fails validateScriptCoverage's
  // strict "every character must appear in some segment" check outright — the model was never
  // asked to preserve a heading it correctly judged wasn't part of the narration. Rather than try
  // to prompt the model into treating a title as narration (this file's own established lesson:
  // a judgment call fighting a differently-reasonable interpretation elsewhere doesn't hold),
  // strip it deterministically before it ever reaches Claude, so what's sent — and what
  // validateScriptCoverage checks against — never included it in the first place.
  script = stripLeadingTitle(script);

  // ONE-TIME TRIAL ENFORCEMENT — this is the endpoint that spends real money (billed Anthropic
  // balance), so the budget check lives here, server-side, not in the UI. The budget is
  // TRIAL_SECONDS_MAX (10 min of estimated narration) per account, tracked against BOTH the
  // account record and a keyed hash of the caller's IP — whichever has used more wins, so a fresh
  // account from the same network doesn't reset the clock (see _auth.js). Checked BEFORE the
  // Claude call; consumed only AFTER a successful generation, so a failed run never burns budget.
  // Guests are welcome (no account needed) — their budget is TRIAL_SECONDS_MAX tracked purely on
  // the IP-hash record; accounts get TRIAL_SECONDS_MAX_ACCOUNT (+5 min, the honest half of the
  // "sign up for more usage" nudge). Either way spend is written to the IP record, so no network
  // can exceed the account cap in total across any mix of guests and fresh accounts.
  const user = (context.data && context.data.user) || null;
  const maxSeconds = user ? TRIAL_SECONDS_MAX_ACCOUNT : TRIAL_SECONDS_MAX;
  const secondsNeeded = scriptSeconds(script);
  const ipKey = await ipTrialKey(request, env);
  const ipUsed = Number(await env.AUTH_KV.get(ipKey)) || 0;
  const usedSoFar = Math.max((user && user.trialSecondsUsed) || 0, ipUsed);
  const remaining = Math.max(0, maxSeconds - usedSoFar);
  if (secondsNeeded > remaining) {
    const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    const outOfBudget = user
      ? "Your free trial is used up. Upgrade to keep using SceneHunt."
      : "Your free guest trial is used up. Sign up free for 5 more minutes, or upgrade for full access.";
    const trimHint = user
      ? `This script is about ${fmt(secondsNeeded)} of narration, but your trial has ${fmt(remaining)} left. Trim the script or upgrade for full access.`
      : `This script is about ${fmt(secondsNeeded)} of narration, but your guest trial has ${fmt(remaining)} left. Trim the script, or sign up free for 5 more minutes.`;
    return Response.json({
      error: remaining === 0 ? outOfBudget : trimHint,
      trialSecondsUsed: usedSoFar,
      trialSecondsMax: maxSeconds,
    }, { status: 402 });
  }
  const consumeTrial = async () => {
    const newUsed = Math.min(TRIAL_SECONDS_MAX_ACCOUNT, usedSoFar + secondsNeeded);
    if (user) {
      const updated = { ...user, trialSecondsUsed: newUsed };
      await env.AUTH_KV.put(`user:${user.email.toLowerCase()}`, JSON.stringify(updated));
    }
    await env.AUTH_KV.put(ipKey, String(newUsed));
    console.log(`[segment] trial consumed: +${secondsNeeded}s -> ${newUsed}/${maxSeconds}s for ${user ? user.email : "guest"}`);
  };

  // Structured JSON-schema output plus the coverage-pass fields can make this a long response —
  // long enough to risk Cloudflare's non-streaming edge timeout (524). Stream the upstream
  // Anthropic SSE response server-side (collectClaudeStream in _claude.js) instead, and keep the
  // browser-facing connection alive with a leading whitespace flush + periodic heartbeat padding
  // (harmless: valid JSON tolerates leading/interior whitespace before the payload).
  const encoder = new TextEncoder();
  const upstreamAbort = new AbortController();
  let cancelled = false;
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(" ".repeat(2048)));
      const heartbeat = setInterval(() => {
        if (!cancelled) controller.enqueue(encoder.encode("\n" + " ".repeat(1024)));
      }, 10000);
      try {
        const segments = await generateVisualPlan(env, script, upstreamAbort.signal);
        // Consume trial budget only on SUCCESS — a failed/errored run costs the user nothing.
        await consumeTrial();
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
  const claudeRes = await claudeChat(env, {
    model: "claude-sonnet-5",
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: script }],
    // The declared ceiling is not prepaid: Anthropic bills tokens actually generated, not the
    // declared max_tokens cap — always leave the full supported headroom rather than tuning this
    // tightly against script length the way the Groq-era cap needed to.
    max_tokens: 32000,
    output_schema: SEGMENT_OUTPUT_SCHEMA,
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
  // enforceVisualPlan runs BEFORE enforceFeelQueryRule: it backfills the legacy `query` field from
  // `visualQueries[0]` when the model only populated the new field. Running the downgrade check
  // first would wrongly, permanently drop a segment with a real visualQueries but an empty legacy
  // query to "nothing" before the backfill ever gets a chance — enforceFeelQueryRule also checks
  // visualQueries directly as a second line of defense, so this stays correct either way.
  const visualResolved = enforceVisualPlan(evidenceResolved);
  const queryResolved = enforceFeelQueryRule(visualResolved);
  const corrected = normalizeCoveragePlan(queryResolved);

  // Live-tail visibility only (wrangler pages deployment tail) — NOT a durable/queryable store,
  // just real-time eyes on what the model actually decided per segment while testing. One line
  // per segment (not one JSON blob for the whole script) so each is independently greppable
  // mid-stream (e.g. `wrangler pages deployment tail --project-name cliphunt | grep family=nothing`)
  // without scrolling one giant line. A short reqId ties every segment in one script back
  // together when several test scripts run back to back in the same tail session. Logged AFTER
  // enforcement so this reflects final decided values, not raw pre-enforcement model output.
  const reqId = Math.random().toString(36).slice(2, 8);
  console.log(`[segment] reqId=${reqId} script_len=${script.length} segments=${corrected.length}`);
  corrected.forEach((seg, i) => {
    console.log(
      `[segment] reqId=${reqId} #${i} family=${seg.family} ` +
      `coverage=${seg.coverageMode} visualId=${seg.visualId ?? "-"} visualRef=${seg.visualRef ?? "-"} ` +
      `subject=${JSON.stringify(seg.subject ?? null)} categoryClaim=${JSON.stringify(seg.categoryClaim ?? null)} ` +
      `depictionType=${seg.depictionType ?? "-"} query=${JSON.stringify(seg.query ?? null)} ` +
      `reason=${JSON.stringify(seg.reason ?? null)} text=${JSON.stringify(seg.text.slice(0, 100))}`
    );
  });
  const coverage = summarizeCoverage(corrected);
  console.log(`[segment] reqId=${reqId} coverage=${JSON.stringify(coverage)}`);

  return corrected;
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
  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const reconstructed = normalize(segments.map((seg) => seg.text).join(" "));
  const original = normalize(script);
  if (reconstructed !== original) {
    // Find the first point the two strings actually diverge, so the error is something a real
    // wrangler-tail session can act on instead of a bare "didn't match" — this check was firing
    // live with no way to tell paraphrasing/dropped text from a benign punctuation substitution
    // (smart quotes, dash variants) the model may have silently "cleaned up" despite being told
    // not to.
    let i = 0;
    const len = Math.min(reconstructed.length, original.length);
    while (i < len && reconstructed[i] === original[i]) i++;
    const context = 40;
    const originalAround = original.slice(Math.max(0, i - context), i + context);
    const reconstructedAround = reconstructed.slice(Math.max(0, i - context), i + context);
    console.log(
      `[segment] script coverage mismatch at char ${i} (original len=${original.length}, ` +
      `reconstructed len=${reconstructed.length})\n` +
      `  original:      …${originalAround}…\n` +
      `  reconstructed: …${reconstructedAround}…`
    );
    throw new Error(
      `Claude's segments did not preserve the complete script exactly (diverged at character ${i} — ` +
      `original: "…${originalAround}…" vs reconstructed: "…${reconstructedAround}…")`
    );
  }
  return segments;
}

// Strips one or more consecutive leading markdown-heading lines ("# Title", "## Subtitle") from
// the very start of a pasted script — a title/label a video creator often includes out of habit
// (see new-project.html's own placeholder text, which uses exactly this shape), not narration to
// be spoken or segmented. Only strips from the START of the script — a heading-shaped line
// appearing later is left alone as real script content, not assumed to be a title.
export function stripLeadingTitle(script) {
  const raw = String(script || "");
  const stripped = raw.replace(/^\s*(?:#{1,6}[ \t]+[^\r\n]*(?:\r?\n)+)+/, "");
  // If the whole "script" turned out to be just a title line with no real body, don't strip it
  // down to nothing — better to try segmenting the title as content than to send Claude (and
  // validateScriptCoverage) an empty string.
  return stripped.trim() ? stripped : raw;
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
export function enforceEvidenceRule(segments) {
  for (const seg of segments) {
    const hasSubject = seg.subject && String(seg.subject).trim();
    const hasCategoryClaim = seg.categoryClaim && String(seg.categoryClaim).trim();
    const isRealEvidence = hasSubject || hasCategoryClaim;
    if (seg.family === "evidence" && !isRealEvidence) {
      seg.family = "feel";
      // depictionType is only ever meaningful for "evidence" (the prompt has the model omit it —
      // set null — for every other family). Without this, a flipped segment could carry a stale
      // "instant"/"fallback" value into app.js's display, rendering "· depiction: instant" under
      // a segment now badged "Feel".
      seg.depictionType = null;
    } else if (seg.family === "feel" && isRealEvidence) {
      seg.family = "evidence";
    }
  }
  return segments;
}

// enforceFindabilityRule() used to live here — deleted (2026-07-20). It pre-judged whether real
// footage was likely to exist BEFORE any real search ran, downgrading straight to "nothing" on a
// model guess ("findable":"unlikely"). That's inconsistent with how "feel" (stock-search.js) and
// "reference" (reference-search.js) already work: no upfront gate, always search, let the real
// empirical rerank (MIN_RERANK_SCORE in evidence-search.js) decide "nothing found" — this was the
// one place "evidence" pre-judged instead of just trying. See HANDOFF.md for the full reasoning;
// "findable" itself is gone from the prompt/schema too, replaced by "depictionType" (instant vs.
// fallback), which now only decides whether an IMAGE search is worth running, not whether to
// search at all.

// The one boundary in this file with NO code-level backup until now: every other fuzzy judgment
// here (mergeFragments, enforceEvidenceRule) has a deterministic safety net, but the
// concreteness-gate/tie-breaker decision that produces "feel" vs "nothing" was
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
export function enforceFeelQueryRule(segments) {
  for (const seg of segments) {
    if (seg.family !== "feel") continue;
    const hasQuery = Boolean(seg.query && String(seg.query).trim());
    // Checked directly (not just relying on enforceVisualPlan's earlier backfill) so this stays
    // correct even if the pipeline order changes again later.
    const hasVisualQuery = Array.isArray(seg.visualQueries) &&
      seg.visualQueries.some((q) => String(q || "").trim());
    if (!hasQuery && !hasVisualQuery) {
      seg.family = "nothing";
      seg.reason = "feel had no query — mechanically downgraded, no real anchor found";
      // enforceVisualPlan already set visualMode/visualQueries/eraHint/visualGoal while this was
      // still "feel" — clear them on downgrade so "nothing" never carries stale visual-plan
      // fields, matching enforceVisualPlan's own stated invariant for pre-existing "nothing" rows.
      delete seg.visualMode;
      delete seg.visualQueries;
      delete seg.eraHint;
      delete seg.visualGoal;
    }
  }
  return segments;
}

// New editor-planning fields are additive. Old projects and imperfect model responses retain the
// exact pre-feature behaviour: query is always the first search, evidence defaults to exact, and
// feel defaults to stock. Invalid subject_broll cannot accidentally turn anonymous filler into
// purported footage of a real person. "reference" and "nothing" never get these fields — reference
// keeps its own separate meme/reaction pipeline (reference-search.js) untouched.
export function enforceVisualPlan(segments) {
  for (const seg of segments) {
    if (seg.family !== "feel" && seg.family !== "evidence") {
      delete seg.visualMode;
      delete seg.visualQueries;
      delete seg.visualGoal;
      delete seg.eraHint;
      continue;
    }

    const fallbackMode = seg.family === "evidence" ? "exact" : "stock";
    let mode = ["exact", "subject_broll", "stock"].includes(seg.visualMode) ? seg.visualMode : fallbackMode;
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
    (Array.isArray(seg.visualQueries) && seg.visualQueries.some((q) => String(q || "").trim()))
  );
}

// Normalize both new model output and legacy saved-project shapes. References are validated in
// one ordered pass, so forward refs, duplicate IDs, and chains can never survive. This function
// mutates only the in-memory/API result; the frontend does not rewrite localStorage.
export function normalizeCoveragePlan(segments) {
  const origins = new Map();
  const claimedIds = new Set();

  segments.forEach((seg, index) => {
    // This branch is currently unreachable: this function only ever processes FRESH model output
    // (SEGMENT_OUTPUT_SCHEMA's family enum no longer includes "reference" at all, so Claude can't
    // produce one), and is never re-run against old saved projects — app.js's own buildLiveSegments
    // handles those independently. Kept as insurance for if "reference" is ever re-added to the
    // schema: reference-search.js's retrieval is a dual-source (YouTube reaction + Pexels stock)
    // lookup, always re-searched per click, with no single trackable "visual" to continue/callback
    // into the way one feel/evidence search produces — a reference beat landing in continue/
    // callback would silently drop its "Find reaction clip" button with nothing to replace it.
    if (seg.family === "reference") {
      let id = `legacy-v${index}`;
      while (claimedIds.has(id)) id = `${id}-x`;
      claimedIds.add(id); // reserved so no other row's fallback ID can collide with it
      seg.coverageMode = "new";
      seg.visualId = id;
      seg.visualRef = null;
      seg.continuityReason = null;
      seg.noneKind = null;
      return; // deliberately never added to `origins` — nothing should continue/callback into it
    }

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
