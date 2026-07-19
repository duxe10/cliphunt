# ClipHunt — handoff notes

## What this is
A tool for video creators: paste/upload a script (or a voiceover to transcribe), it gets
broken into distinct moments, and each moment gets matched with candidate footage to cut to.
Live on **Cloudflare Pages** at https://cliphunt.pages.dev (public GitHub repo
github.com/duxe10/cliphunt; deploy with `npx wrangler pages deploy .`).
Migrated off Netlify after hitting its free-tier deploy-credit wall — the old `netlify/` dir is gone.

## Stack, deliberately
- Plain HTML/CSS/JS frontend (`index.html`, `new-project.html`, `workspace.html`, `style.css`, `app.js`) — no framework, no build step.
- Data model: real multi-project history in localStorage under one key, `cliphunt_projects` (array of `{id, title, segments, createdAt, updatedAt}`). No mock/demo data — the old hardcoded "harry" demo project and `MOCK_SEGMENTS` were removed. `app.js` is loaded on all three pages and dispatches by which root element is present (`#project-grid` → dashboard list, `#segments` → workspace). new-project.html appends a project and routes to `workspace.html?id=<id>`; the dashboard lists projects newest-first; workspace loads by `?id=` and its Delete button removes the project. Only raw `segments` are persisted — clips are hydrated live on each workspace load (kept fresh, not stored). A one-time `migrateLegacy()` upgrades the pre-history single-project keys (`cliphunt_title`/`cliphunt_segments`).
- Cloudflare Pages Functions for anything needing a secret API key, under `functions/api/` (routed as `/api/*`): `functions/api/segment.js` (Groq — segmentation/family classification only, see "Segmentation" below), `functions/api/_groq.js` (shared Groq fetch wrapper with retry/backoff — underscore prefix means Pages excludes it from routing, import-only, see "Reliability & rate-limit lessons" below), `functions/api/stock-search.js` + `functions/api/stock-search-batch.js` + `functions/api/stock-download.js` (Pexels — the only `feel` source, see "Stock footage" below), `functions/api/evidence-search.js` (Groq intent + context resolution + YouTube Data API + LLM rerank, for BOTH `specific` and `generic` beats as of 2026-07-18 — see point 7 under "Segmentation" below), `functions/api/reference-search.js` (same YouTube pipeline, reaction-focused). These are ESM (`onRequestPost`/`onRequestGet`, `context.env` for secrets), ported from the old Netlify handlers.
- Groq (free tier), YouTube Data API, and Pexels keys live in **Cloudflare Pages secrets**
  (`GROQ_API_KEY`, `YOUTUBE_API_KEY`, `PEXELS_API_KEY`), never in code. `GIPHY_API_KEY` is no
  longer used (gifs dropped entirely, see "Clip search" below) — safe to remove from Cloudflare
  secrets. NOTE: Pages binds secrets at deploy time — after changing a secret you must
  **redeploy** for functions to see it. **No non-Cloudflare piece anymore** — the yt-dlp/ffmpeg
  worker (Render) was decommissioned, see below.
- **No longer strictly free-tier (2026-07-18):** segmentation and evidence-search's intent
  extraction moved to Claude Sonnet (`ANTHROPIC_API_KEY`, real billed balance, currently small —
  treat as scarce) — see "Model split" under "Segmentation" below for which call sites moved and
  why, and `functions/api/_claude.js`'s header comment for the request-shape differences from
  Groq. Everything else (rerank, reference-search, stock search) stays on free-tier Groq/Pexels/
  YouTube. Cost-consciousness still applies, just with a real dollar number behind it now instead
  of a quota wall.
- **Groq model split (revised 2026-07-18, second pass):** segmentation (`segment.js`) is back on
  `llama-3.3-70b-versatile` — confirmed live that even after the Narrator-batch revert, a single
  segmentation call for a realistic script requests ~65-72% of `gpt-oss-120b`'s 8k TPM ceiling in
  one shot, so a retry or a second call inside the same minute reliably collided and 429'd (this
  is why testing kept failing even after the earlier fix). `llama-3.3-70b-versatile`'s 12k TPM
  gives real headroom for the same request. This deliberately reopens the 100k-tokens/DAY quota
  risk that caused the original move away from it (see "Reliability & rate-limit lessons" below) —
  watch for that risk resurfacing, don't silently swap back without re-checking.
  Evidence/reference intent-extraction stay on `openai/gpt-oss-120b`; mechanical rubric-scoring
  (every rerank step, including the batched stock rerank) stays on `openai/gpt-oss-20b` — both are
  per-click, lower call frequency, so they don't share segmentation's TPM pressure.

## Evidence & reference pipelines — link-only, no downloading (reworked 2026-07-17)
There used to be a separate worker service (`worker/`, Node+Express+Docker on Render) that ran
`yt-dlp`+`ffmpeg` to download and trim YouTube video server-side and stream it back as a file,
with HMAC-signed URLs authorizing it and a manual-trim signing function (`sign-clip.js`). All of
that — `worker/`, `functions/api/sign-clip.js`, `functions/api/config.js` (existed only to expose
`WORKER_URL`), and every `WORKER_URL`/`WORKER_TOKEN` reference — is now gone. Downloading and
redistributing someone else's YouTube video carried real copyright/ToS risk; the product decision
was to stop taking that risk and to differentiate on NOT locking creators into an editing
workflow ("hunt for clips," not "edit here") rather than on owning the clip file. What's kept:
- `functions/api/evidence-search.js`: intent-extraction (elliptical-reference resolution,
  generic→Pexels short-circuit at the time of THIS rework, later removed — see point 7 under
  "Segmentation" below) was unchanged, and YouTube search → `enrichCandidates` (duration/views) →
  LLM `rerankCandidates` (0-100 against the beat's actual claim, demoting reactions/watchalongs/
  compilations) — all of that search-quality work is unaffected by the download removal. The only
  change here: the top 5 reranked candidates are mapped to plain
  `https://www.youtube.com/watch?v=...` links and returned directly — no HMAC signing, no worker
  handoff, no `matchSig`/`exp`. (Intent-extraction's elliptical-reference resolution DID change
  later — see "Scene context resolution" below for the current version.)
- `functions/api/reference-search.js`: same shape — emotion/reaction query → YouTube search →
  `filterRawReactionCandidates()` (unchanged) → rerank on capture-quality (unchanged) → plain links.
- **The rerank score/reason IS the honesty signal now**, surfacing directly in the UI (e.g. "87% ·
  primary broadcast footage") instead of feeding a caption-match verification step — it already
  answers "does this actually back up the claim," so there was no separate verification logic to
  rebuild when captions went away.
- Frontend (`app.js`): evidence/reference beats still get a **Find footage**/**Find reaction clip**
  button (user-triggered, same reasoning as before — quota-limited YouTube search). Preview is a
  plain (non-trimmed) YouTube embed; the single action button is **"Watch on YouTube ↗"** — an
  external link, not a download. `evidenceLabel()` reads `cand.score`/`cand.reason` from the
  rerank instead of the old worker's `matched`/`start`/`end`/`reason` shape. The manual trim row
  that used to live here (`setupTrimRow`, signed via `sign-clip.js`) is gone — trimming moved to
  stock/Pexels clips only, see below, since that's the one source this app is actually allowed to
  redistribute.

## The 4-category taxonomy (this is the core design decision)
Every segment gets classified into one of:
- **feel** — pure emotion beat, or atmosphere/mood/action with no specific referent → real stock footage from Pexels, downloadable and trimmable (gifs dropped entirely, see "Clip search" below)
- **evidence** — a specific real person/thing did the exact thing referenced, OR a genuine category-level claim about a class of real people/things needing real illustrative footage → real footage from YouTube (link-only, not downloaded), for EITHER a named subject or a category claim (2026-07-18: category claims used to short-circuit to Pexels stock instead — that was reverted, stock b-roll isn't authentic footage of the claim, see point 7 under "Segmentation" below) — see "Evidence & reference pipelines" above
- **reference** — matches a known meme/cultural callback → real raw reaction clip from YouTube, link-only (see "Reaction clip footage" below; migrated off Giphy)
- **nothing** — GENUINELY has no visual content of its own (connective narration, a meta aside) — not a default for "no one named," see the Segmentation section's classification-gap note below

This collapsed from a more elaborate original taxonomy (subject_quote/subject_post/meme_callback/etc.) for MVP simplicity — see git history / ask if the fuller version matters later.

## Segmentation (`functions/api/segment.js`)
Getting segment *boundaries* right was the original hard part; getting *family classification*
right (below) turned out to have its own sharp edge too. Lessons learned the hard way:
1. Default to splitting on every complete sentence — merging by "topic relation" over-merges (e.g. "For most footballers... / For Harry Kane..." should NOT merge, it's a deliberate contrast pivot).
2. The ONLY real merge signal is grammatical incompleteness — a segment starting with `...` or `—`, or the previous segment ending in a dangling `—`. This is NOT reliably followed by the model regardless of which model runs segmentation (this rule fights the "split by default" rule) — so it's enforced deterministically in code (`mergeFragments()` at the bottom of `segment.js`), not left to the prompt. Don't try to fix this by wording the prompt harder — it oscillates between over-merge and under-merge across runs. Code-level regex is the actual fix.
3. Words like "but"/"and"/"so" at the start of a sentence are NOT a fragment signal — very common as deliberate stylistic sentence-openers. Only `...`/`—` are unambiguous.
4. **Classification gap (fixed 2026-07-17):** category-level statements with no named subject
   ("For most footballers, scoring at a World Cup is the highlight of their career") were falling
   through to `"nothing"` (discarded, no clip) — `"evidence"` was originally defined as needing
   ONE named person, so a sentence with no name and no pure emotion had nowhere to land.
   `evidence-search.js` already had a well-built generic branch for exactly this pattern, it just
   never got reached. Fixed by explicitly widening `"evidence"` to cover category-level statements
   alongside named-person ones, and narrowing `"nothing"` to genuinely visual-free connective
   narration only — see the prompt itself for the current wording, it's the source of truth.
5. **Domain bias:** every illustrative example in these prompts used to be football (Harry Kane's
   missed penalty, "most footballers..."), since that's what got tested against first. Real risk:
   an LLM pattern-matches to few-shot examples, so an all-sports prompt can subtly skew
   classification/query-writing toward sports-shaped reasoning even for unrelated scripts. Every
   example across `segment.js` and `evidence-search.js` is now paired with a second example from
   a different domain (a startup/business one) specifically to break that anchor. If you add a new
   example anywhere in these prompts, pair it with one from a different domain, don't add a third
   sports one.
6. **`feel`/`evidence` atmosphere boundary — actually fixed 2026-07-18, via schema not wording.**
   Three prompt rewordings in a row failed to stop the model reading a "[a/an + role] + [specific
   verb] + [specific scene]" grammatical SHAPE as evidence-worthy regardless of content (a barista,
   a groundskeeper, an aide — all misclassified `"evidence"` despite naming no one real). Same
   lesson as `mergeFragments()` elsewhere in this file: when the model won't reliably hold a rule
   no matter how it's worded, stop wording it and enforce it in code instead. Fix: the model now
   names a `"subject"` per segment (the one specific real entity/event, or `null` if there isn't
   one) — a narrower, more mechanical question than "which family" — and `enforceSubjectRule()`
   deterministically downgrades `family:"evidence"` to `"feel"` whenever `subject` came back empty.
   This can't misfire on a real evidence claim (one always implies a nameable subject), and it
   can no longer matter if the model's shape-bias miscalls the family label, since the subject
   check catches it regardless. `"feel"` absorbed the old `"evidence"`(b) category-statement case
   (`"Most startups fail..."` etc.) since both always routed to Pexels anyway — one fewer
   ambiguous line to draw **(revised same day — see point 7: this specific call turned out to be
   wrong, category claims needed to stay a distinct evidence flavor, not merge into feel)**. Every
   non-`"nothing"` segment now gets a `"query"` (previously `"feel"`-only) so a downgraded segment
   already has a stock-search query ready, no extra call needed. Re-verify this against a real
   script with the specific phrasings above if it's ever touched again — don't assume the fix
   holds without testing live, same as everywhere else here.
7. **Category claims need real YouTube footage, not stock — and a findability gate for both
   evidence flavors (2026-07-18, third pass).** Point 6's fix was right to stop the model
   misreading incidental scene-setting (a barista, a groundskeeper, an aide) as `"evidence"`, but
   it over-corrected by merging category-level claims ("For most footballers, scoring at a World
   Cup is the highlight of their career") into `"feel"` too, on the reasoning that both ultimately
   routed to Pexels anyway. That reasoning broke once someone actually looked at the *product*
   question: a category claim like that deserves real footage of players actually celebrating a
   real World Cup goal, not generic stock b-roll — Pexels was never the right source for it, it
   was just where the OLD `evidence-search.js` generic branch happened to route. So `"evidence"`
   now covers two flavors, both searching YouTube, distinguished by two mechanical fields
   (same pattern as `"subject"` in point 6, not left to prompt wording): `"subject"` (a named
   entity, unchanged) or `"categoryClaim"` (a short phrase naming the real phenomenon, set only
   when the segment makes a genuine quantifier-signalled claim about a class of real people/things
   — `null` for the barista/groundskeeper/aide-style incidental activity, which must stay `"feel"`).
   `enforceEvidenceRule()` (replacing `enforceSubjectRule()`) is now bidirectional: downgrades
   `"evidence"` → `"feel"` when NEITHER field is set, and upgrades `"feel"` → `"evidence"` when
   EITHER is set but the model's own family word didn't follow through.

   Second, separate problem folded into the same pass: some evidence/reference-shaped segments
   describe something that will never realistically have real, indexed footage regardless of
   flavor — e.g. "The chat lost it when the demo video hit the front page" names an unnamed
   "chat" and an unnamed demo, nothing real or searchable, but reads specific enough to trigger a
   wasted click + Groq call + quota-limited YouTube search that was always going to come back
   empty. Fixed with a third field, `"findable"` (`"likely"|"unsure"|"unlikely"`), asked whenever
   `subject`/`categoryClaim` is set or family is `"reference"` — biased firmly toward `"unsure"` as
   the safe default (searching is cheap; skipping a real find isn't). `enforceFindabilityRule()`
   downgrades straight to `"nothing"` on `"unlikely"`, intercepting the segment before the frontend
   ever shows a doomed "Find footage" button. **Built its trigger condition from the raw
   `subject`/`categoryClaim`/`family==="reference"` fields, not from `family` itself** — this makes
   it commute with `enforceEvidenceRule()` (order-independent, provably), rather than depending on
   which of the two functions happens to run first. `"unsure"`/`"likely"` segments are unaffected —
   the existing per-click search+rerank+`MIN_RERANK_SCORE` threshold in `evidence-search.js`/
   `reference-search.js` already implements "search, verify against real results, empty if nothing
   matches" (confirmed by reading both files — no changes needed there). `"feel"` gets no
   findability gate at all, deliberately — Pexels search is cheap, auto-triggered, and already
   fails open on any rerank error (see `stock-search.js`'s `rerankStockCandidates`), so there's no
   wasted-click/wasted-quota cost to guard against for that family.

   Consequence for `evidence-search.js`: its `footageType:"generic"` branch, which used to
   short-circuit straight to Pexels, is deleted entirely — both `"specific"` and `"generic"` now
   run the same `searchYouTubeVideos` → `enrichCandidates` → `rerankCandidates` → `MIN_RERANK_SCORE`
   pipeline, differing only in the `youtubeQuery` framing (a person/event name vs. a concrete
   action + category phrase). `RERANK_PROMPT` needed no changes — it already scored "does this
   illustrate THIS concept" for the generic case, it just never got real YouTube candidates to
   score before. `stockQuery`, `mapPexelsVideo`/`rerankStockCandidates` imports, and the
   `PEXELS_API_KEY` guard are gone from this file; `app.js` needed no changes at all, since the
   Pexels branch's distinct response shape (`source:"stock"`, `clips`) disappeared along with it
   and generic now returns the exact same `{subject, footageType, quote, candidates}` shape
   `renderEvidence()` already handled.

   `max_completion_tokens`'s flat constant bumped `600` → `900` in this same pass (two new keys —
   `categoryClaim` on every segment, `findable` on a subset) — estimated, not measured; re-confirm
   against Groq's actual reported "Requested" tokens on a real dense script before trusting it, per
   this file's own established practice for every other number in that formula.
8. **Abstract states/outcomes need `"nothing"`, not `"feel"` (2026-07-18).** `"Everything was
   level going into the final minutes."` was landing as `"feel"` with a useless query — "level"
   describes a fact about a scoreboard, not a scene a camera could point at. Widened `"nothing"`'s
   definition to cover abstract states/outcomes with no concrete visual (a tied score, a deal
   "still on the table"), distinct from mood/atmosphere (stays `"feel"` — a tense crowd's faces
   ARE a real shot) and from a real action in the same beat (stays `"evidence"`/`categoryClaim`
   territory). Prompt-only, no new field — this is a conceptual "is there a scene to film"
   judgment, not the kind of grammatical-shape pattern-matching that needed code enforcement
   elsewhere in this file. Confirmed live on the worked examples; re-verify if it turns out to
   need a mechanical field after all (same escalation path as `subject`/`categoryClaim`).
9. **Model split — segmentation moved to Claude Sonnet (2026-07-18).** Segmentation was the
   highest-stakes, most failure-prone call all session on Groq (TPM ceiling fights, the shape-bias
   misclassifications in points 6-8). Moved to `claude-sonnet-5` via `functions/api/_claude.js` —
   a genuinely different request shape from Groq's OpenAI-compatible API (system prompt is a
   top-level `system` field, `max_tokens` not `max_completion_tokens`, no native JSON mode —
   `extractJson()` strips an occasional ```json fence before `JSON.parse`). This account is on a
   small **real billed** Anthropic balance, not a free tier — `ANTHROPIC_API_KEY` must be set as
   a Cloudflare Pages secret (same redeploy-after-secret-change rule as every other key here).
   Evidence-search's intent extraction moved too (see its own file header comment); reranking and
   reference-search stay on free-tier Groq deliberately — see "Model split" note at the top of
   `evidence-search.js`. **Two more real bugs found live in the same pass, see point 10.**
10. **`claude-sonnet-5` quirks that broke this on first deploy (2026-07-18) — read before touching
    `_claude.js` or its two call sites again.**
    - **`temperature` is rejected outright** on this model ("`temperature` is deprecated for this
      model", a hard 400) — unlike Groq/older Claude models where it's a normal sampling knob.
      Dropped entirely from `claudeChat()` rather than made conditional, since every call site
      here targets `claude-sonnet-5`.
    - **Adaptive thinking is ON BY DEFAULT and CANNOT be disabled** on this model — confirmed via
      `GET /v1/models`' own capability listing for `claude-sonnet-5`:
      `"thinking":{"types":{"enabled":{"supported":false},"adaptive":{"supported":true}}}` — only
      `"adaptive"` is a valid `thinking.type` here, there's no `"disabled"` option at all, unlike
      older/smaller models. Finding `effort`'s actual placement took THREE live attempts, each a
      real billed call — worth reading in full so it isn't re-litigated: (1) nested inside
      `thinking` (`thinking:{type:"adaptive",effort:"low"}`) — rejected, "Extra inputs are not
      permitted"; (2) bare top-level (`effort:"low"`) — also rejected, same error, because a
      conceptual doc-guide page's summary and `/v1/models`' capability-flag naming both implied
      but never actually stated the real location; (3) the ACTUAL Messages API reference (the
      literal parameter-by-parameter endpoint schema, a different and more authoritative doc page
      than either of the first two sources) shows `effort` living inside a top-level
      `output_config` object. **Correct shape:**
      `{ ..., thinking: { type: "adaptive" }, output_config: { effort: "low" } }` — `thinking` and
      `output_config` are both top-level, `effort` is nested in the latter only. **Lesson: for an
      exact request-body field location, go straight to the parameter-by-parameter API reference,
      not a conceptual guide page or a capability-flag name that merely implies a shape** — the
      guide page and the `/v1/models` capability object were both real and both insufficient to
      get this right on the first or second try.

      The default-on, unstoppable thinking silently broke both call sites on first deploy: a
      response can come back with ONLY a `"thinking"` content block and no `"text"` block at all,
      because thinking consumed the entire `max_tokens` budget before reaching an answer — not a
      truncated-JSON error, a response with nothing to parse. Compounded by a second bug: the
      code originally read `content[0].text` positionally, so when thinking came first that was
      silently `undefined`, fell through an `|| "{}"` fallback, and surfaced as the confusing
      **"Model did not return a segments array"** — nothing in that message pointed at the real
      cause. Fixed two ways together: `claudeChat()` now explicitly requests `effort:"low"` (a
      deliberate cost control, not just a reliability fix — thinking tokens are real billed spend
      on a small account, so this bounds it rather than leaving it to the model), and
      `extractText()` (`_claude.js`) finds the actual `"text"`-type block by type instead of
      position, throwing a clear diagnostic error if none exists instead of degrading silently
      into that same confusing downstream message — same "fail loudly, don't silently paper over
      it" instinct as this file's other lessons.
    - **`max_tokens` must budget for thinking AND the answer, not just the answer** — since both
      share the same cap. First pass (`Math.min(16000, Math.ceil(script.length/2.5)+2500)`) still
      truncated a real response mid-JSON (`Unterminated string in JSON`) — bumped again to
      `Math.min(32000, Math.ceil(script.length/1.5)+6000)` (segmentation) / `4096`
      (evidence-search). **Important, and different from the Groq-era rule right above this
      section:** Anthropic bills by tokens actually GENERATED, not the declared `max_tokens`
      ceiling — Groq's TPM accounting reserved the whole declared cap upfront regardless of
      actual use, which is exactly why the old Groq-era formula had to stay tight (the "over-
      padded cap eats the TPM budget" lesson two sections up). That constraint doesn't apply to
      Claude, so there's no cost reason to keep this number tight the way the Groq one had to be —
      err generous here. Still **not yet confirmed against real usage** — re-verify actual token
      consumption on real scripts before trusting these specific numbers, same standing rule as
      every other constant in this area.
11. **`categoryClaim` was still a shape test, not a content test — fixed 2026-07-19, now that a
    genuinely capable model is doing this reasoning.** Live-tested: `"To this day, many England
    fans wonder scoring there would have changed football history forever."` has the exact
    grammatical shape of a `categoryClaim` (quantifier "many" + category "England fans" + a
    verb) — the OLD test ("signalled by quantifier language... attached to a concrete real
    action, not an abstract feeling") let it through, and `family:"feel"` then had to write a
    `query` for it, producing a generic, wrong one ("football stadium fans") because the model
    was trying to visualize the sentence's surface topic instead of its actual content. This is
    the same shape-over-content failure mode documented repeatedly elsewhere in this file — just
    a different trigger (a quantifier word, not a grammatical role+verb+scene pattern) hitting
    the same underlying weakness. **The fix, deliberately different from every earlier fix of
    this type: don't add another mechanical rule, lean on the model's own reasoning instead** —
    now that segmentation runs on Claude Sonnet (see point 9), it's reasonable to trust it with a
    genuinely semantic test rather than another surface pattern. Quantifier language is now a
    *signal to notice*, not the decisive test; the decisive test is "if you point a camera at one
    real instance, does it capture a visible external action, or just a person existing while
    something invisible happens inside them (wondering, hoping, wanting)?" Only the former sets
    `categoryClaim`. **A cross-reference was added deliberately**: excluding a mental state from
    `categoryClaim` does NOT make the segment `"nothing"` (it stays `"feel"`) — the `"nothing"`
    rule's wording ("no concrete scene a camera could point at") is close enough to this new
    test's wording that without an explicit note, the model could plausibly conflate the two and
    start dropping these segments entirely instead of searching stock footage for them.

    Paired fix, same underlying cause: `query`-writing for `"feel"` segments whose real content is
    an internal/reflective state (wondering, missing, regretting, "what could have been") now has
    explicit guidance to write the SYMBOLIC representative shot an editor would actually reach for
    (someone gazing into the distance, a hand turning an old photograph) rather than a literal
    noun lifted from the sentence's surface topic/setting — this is what fixes the England-fans
    query itself, on top of `categoryClaim` correctly staying `null` for it.

    `findable` was NOT rewritten — no reported failure, all seven worked examples kept verbatim —
    just given one added instruction to reason from real-world documentation/coverage patterns for
    the specific case at hand rather than pattern-matching to the nearest worked example. Smallest
    change that answers "make this more robust, the model can handle it" without touching anything
    already verified working. `enforceEvidenceRule()`/`enforceFindabilityRule()` needed NO changes
    — both operate on the output fields, not on how the model reasons its way to them.

    **The generalizable lesson, worth remembering next time a smarter model gets swapped in**: not
    every weak-model workaround needs replacing, but when a bug traces back to a rule that was
    itself a blunt surface-pattern proxy for a real semantic test, a stronger model is often better
    served by the real test stated plainly than by another layer of pattern-matching. The
    deterministic code-level guardrails (`enforceEvidenceRule`/`enforceFindabilityRule`) are a
    different kind of thing and stay — they're cheap insurance against ANY model's mistakes, not a
    crutch for a specific model's weakness, and there's no reason to remove them just because the
    model improved.

    **Superseded/generalized the next day — see point 12.** This fix only touched `categoryClaim`.
    The user caught, correctly, that this risked being a one-off patch rather than a structural
    fix — and follow-up live testing on new sentences (never seen in this conversation) proved it:
    `subject` had the exact same latent bug (a resolvable name was sufficient to trigger `evidence`
    regardless of whether the attached content was an actual action), just never exercised by the
    one reported case. Point 12 replaces both fields' separate content-tests with one unified gate.
12. **One unifying concreteness gate, replacing the per-field patches in points 6 and 11
    (2026-07-19).** Point 11's fix only checked `categoryClaim`'s content — `subject` still let a
    resolvable name through with no check on whether the attached content was an actual depictable
    action. Live-tested and confirmed: "That resilience is the reason teammates and managers
    trusted him" resolves "him" to a real player, so `subject` got set and `evidence` fired, even
    though the actual content is a retrospective character/trust judgment with nothing to film.
    Same root cause hit `feel`'s query-writing from a different angle: bare aspirational/emotional
    claims with zero physical anchor ("the dream was alive", "gives me a little hope", "the
    pressure couldn't have been greater") were getting a query forced out of them — inventing a
    generic "reflective" shot untethered from anything the text actually says, rather than being
    recognized as having nothing to film.

    **The fix**: one gate, stated once, near the top of the prompt, that `subject`, `categoryClaim`,
    `feel`'s query-writing, and `nothing` all defer to instead of each running their own version of
    "is this real enough": can you point to ONE concrete, physically depictable thing doing or
    happening, using only the words actually in this segment? Two parts — (1) concrete, not an
    internal state/judgment/aspiration, (2) actually present in this segment's own text, not
    invented or borrowed from a segment it's merely setting up for. `subject` now requires the
    *content* attached to a resolved name to pass this test, not just the name itself. `nothing`'s
    four historical special-cases (connective narration, abstract state, bare internal claims,
    rhetorical name-dropping) are now explicitly framed as ONE failure mode in different grammar,
    not four separate rules — this made the prompt shorter and more consistent, not longer, which
    is a good sign a genuinely structural fix was found rather than another special case bolted on.

    New `reason` field (nothing-only, a few words, e.g. "reputation judgment, no action") lets the
    classification be audited straight from the API response — not read by any code, not rendered
    in the UI, survives `mergeFragments()`'s full-spread and both enforcement functions untouched
    since neither deletes fields. Added specifically because the user is actively auditing whether
    this reasoning generalizes, not pattern-matches — direct visibility into *why* a segment landed
    on `nothing` is what makes that audit possible without guessing.

    **Consequence, handled explicitly**: two of the file's own existing worked examples ("Many
    England fans wonder...", "Some founders spend years afterward replaying...") flip from `feel`
    to `nothing` under the new rule — both have zero physical anchor on their own. Left as stale
    would have contradicted the new rule; moved into `nothing`'s own example list instead, and the
    query-writing section's examples were replaced with genuinely anchored ones (a person sitting
    in a locker room / by a window — anchor present, unlike the old pair).

    **Confirmed unaffected, same reasoning as point 11**: `enforceEvidenceRule()` and
    `enforceFindabilityRule()` need no changes — both inspect only whether fields are non-empty and
    only ever reassign `family`, never caring how the model arrived at a value. `app.js` needs no
    changes — it already whitelists fields into a smaller display object, dropping `subject`/
    `categoryClaim`/`reason` silently; the raw API response is where the new field is visible.

    **Methodological note, worth repeating given it's now happened twice**: verification for a
    prompt-reasoning fix must include sentences genuinely novel to the conversation, not just the
    reported failures — a fix that only passes on the exact sentences that motivated it hasn't been
    shown to generalize, it's been shown to memorize. Re-verify this specific fix against the
    reported cases (the resilience/dream/hope/pressure/missed-penalty examples), genuinely novel
    stress tests in non-sports domains, AND the existing regression set (footballers/startups
    categoryClaim, barista/groundskeeper feel, chat-lost-it findability) before trusting it holds.
13. **Point 12 live-tested: mostly right, two real follow-up bugs — tuned 2026-07-19, not
    re-patched.** The "nation watching decades of disappointment" segment actually worked
    correctly (found the "watching" anchor, correctly stayed `feel`) — the reported problem was
    query QUALITY, not classification: it generated `"crowd watching"`, too generic. Separately,
    `family:"nothing"` was reported as firing "a little too much" across broader testing, with no
    specific failing sentence available to diagnose against this time.

    **The query-vagueness bug had a concrete, verifiable root cause, not a guess**: the
    query-writing paragraph stated a hard "2-5 words" cap, but 2 of its own 6 "good" example
    queries were 6-7 words, and both worked examples in the anchor+tone section were also 7 words
    — the prompt's own examples already contradicted its stated rule, giving the model a
    legitimate reason to default short when unsure. Fixed: loosened to "roughly 3-7 words," with
    explicit guidance to err toward the fuller end whenever an anchor needs an emotional tone/arc
    layered onto it — a query too short to carry both loses the tone first, which is what makes a
    query read as generic. `"crowd watching"`-style output (a bare verb-only anchor, technically
    tied to the text but generic enough to match any scene) is now a named bad-example category.
    Added a third worked example to the anchor+tone section for the specific shape that was
    under-represented (only 2 examples existed, both "anchor as the plain main clause of a short
    sentence" — the reported case is a different, harder shape: an anchor buried inside a longer
    collective/retrospective claim), using the reported sentence itself: BAD `"crowd watching"` vs
    GOOD `"dejected fans slowly turning hopeful"` — same anchor, but carrying the arc the text
    actually describes.

    **The `nothing`-over-triggering fix is a counted structural adjustment, not a guess** — no
    specific failing sentence was available this time, so before proposing anything the actual
    file was counted rather than assumed (same discipline point 12 established): distinct
    "route to nothing" example sentences appear ~11 times but are repeated across sections ~20+
    times total, while the "anchor buried inside abstract/collective framing" pattern — the exact
    shape of the one confirmed report — appeared exactly ONCE, in a parenthetical, never built
    into a full worked example anywhere. This is the same example-density-imbalance failure shape
    documented in points 6/11/12, just biasing the model in the opposite direction this time
    (toward `nothing` instead of toward `evidence`). Fixed with an explicit tie-breaker inserted
    right after the concreteness gate: when abstract/collective framing and a physical anchor both
    appear in the same sentence, **the anchor wins** — read the whole sentence for a hidden anchor
    before concluding `nothing`, don't stop at the first clause that sounds abstract. Illustrated
    with the reported sentence plus two new cross-domain examples (a founder/investors case, a
    family/doctor case — deliberately non-sports, per point 5's "pair examples across domains, no
    third sports one" rule), and cross-referenced directly from the `nothing` bullet's own
    bare-internal-state sub-clause so the two sections can't drift apart again.

    **`reason` generalized from `nothing`-only to every family.** Direct ask: "we have
    classification reasons and query generated saved so we can improve better." For `feel`, names
    the anchor found (or its absence) plus the emotional tone/arc; for `evidence`, what made
    `subject`/`categoryClaim` pass the gate; for `reference`, the recognized meme; for `nothing`,
    unchanged. The actual diagnostic value: a vague query paired with a thin `reason` means the
    anchor itself was weak (a reasoning problem); a vague query paired with a specific `reason`
    means the query PHRASING was weak despite sound reasoning (a different, more mechanical
    problem) — this is what makes future tuning passes evidence-based instead of another guess.

    **Live logging added, deliberately NOT durable storage** — user's explicit choice: a real-time
    `console.log` per segment in `segment.js` (family/subject/categoryClaim/findable/query/reason,
    tagged with a short `reqId`), visible via `wrangler pages deployment tail --project-name
    cliphunt`, one line per segment so it's greppable mid-stream. Logged AFTER both enforcement
    functions run, so it reflects final decided values, not raw pre-enforcement model output.
    `evidence-search.js` got a parallel log of its own raw intent-extraction output
    (`footageType`/`subject`/`youtubeQuery`/`quote`) right after parsing, before `footageType`
    normalization — that endpoint doesn't get a `reason` field of its own; those four fields
    already are its reasoning trail, and a redundant field would be scope creep. No env flag/debug
    gate on either — `console.log` on Workers costs nothing whether or not anyone is tailing, and
    the ask was zero-friction visibility, not a gated mode. If this needs to survive across
    sessions later (not just live-tailed during active testing), Cloudflare KV or Analytics Engine
    are the next step — deliberately not built now, matching this project's standing "don't add
    infrastructure ahead of a real need" principle.

    **Confirmed unaffected, same reasoning as points 11/12**: `enforceEvidenceRule()`,
    `enforceFindabilityRule()`, `mergeFragments()`, and `app.js` need no changes — none of them
    read or touch `reason`/`query`, and `mergeFragments()`'s full-spread already passes new fields
    through untouched.
14. **`enforceFeelQueryRule()` — the concreteness gate's first code-level safety net
    (2026-07-19).** Self-audit, not a live bug report: every other fuzzy boundary in this file
    (`mergeFragments`, `enforceEvidenceRule`, `enforceFindabilityRule`) has a deterministic backup
    because the model can't be trusted to hold a semantic rule reliably on wording alone — that's
    the throughline of points 6/9/11/12/13. The `feel`/`nothing` concreteness-gate decision (the
    newest, most example-heavy rule in the prompt) had NO such backup, entirely prompt-reliant.
    Full semantic verification ("was there really an anchor?") isn't checkable in code — but one
    concrete self-contradiction the prompt itself defines IS: `"feel"` requires a real anchor, and
    the query-writing section builds `"query"` directly from that anchor, so a `"feel"` segment
    with an empty/missing `"query"` is proof the model applied the label without actually finding
    (or using) one — `query` is mandatory for every non-`"nothing"` family by the prompt's own
    rules, there's no legitimate case for it being blank on a `"feel"` segment. Concretely
    dangerous if left uncaught: `app.js`'s `hydrateClips()` falls back to `seg.query || seg.text`
    when calling Pexels, so a hollow `"feel"` would search stock footage using a raw, often
    multi-clause sentence — reliably bad results, not just missing data.

    `enforceFeelQueryRule()` downgrades `family:"feel"` to `"nothing"` when `query` is empty, and
    overwrites `reason` to say so explicitly (`"feel had no query — mechanically downgraded, no
    real anchor found"`) so a tail-log reader can tell this was a code override, not the model's
    own classification. Runs LAST in the pipeline (`mergeFragments` → `enforceEvidenceRule` →
    `enforceFindabilityRule` → `enforceFeelQueryRule`) — specifically AFTER `enforceEvidenceRule`,
    since that function can still toggle a segment `feel`<->`evidence`, and this new rule needs to
    see the FINAL family value, not a pre-toggle one, to avoid missing a segment that only becomes
    `"feel"` partway through the pipeline.

    **Explicitly scoped, not a general fix**: this only catches ONE failure direction — a hollow
    `"feel"` with no query at all. It cannot catch the opposite (a real anchor existed in the text
    but the model dropped the segment to `"nothing"` anyway) — that needs semantic judgment a
    mechanical check can't provide. That failure direction (suspected over- or under-triggering of
    `"nothing"`) is what the live logging from point 13 exists to surface with real data instead
    of another guess.
15. **Tie-breaker strength qualifier — self-audit before live data existed to confirm it
    (2026-07-19).** Point 13's tie-breaker ("the anchor wins" whenever abstract framing and a
    physical anchor both appear in a sentence) had no strength/centrality qualifier — as written,
    ANY physical anchor, however thin or incidental, rescued an otherwise-abstract sentence into
    `"feel"`. Caught by self-review, not a live bug report: the tie-breaker section only ever
    showed "anchor wins" examples, never a case where a nominal anchor was too weak to rescue the
    segment — the same example-density asymmetry that caused points 12 and 13's bugs, just
    pre-empted this time instead of found after the fact. Left unfixed, this risked trading the
    original over-triggering-`"nothing"` problem for its mirror image: any incidental
    sitting/standing/walking verb anywhere in an otherwise fully abstract sentence would now force
    a `"feel"` classification and an invented low-value query.

    Added a concrete, checkable strength test rather than an unhelpfully subjective "use
    judgment" instruction: could this anchor phrase be swapped for a different, unrelated
    placeholder action (sitting, standing, walking) WITHOUT changing what the sentence is actually
    describing? If yes, it's backgrounded stage direction, not a real anchor, and does NOT win the
    tie-breaker. If no — the anchor is specific/load-bearing to the sentence's actual point — it
    wins. Verified this doesn't break the existing "anchor wins" examples: "watching disappointment
    after disappointment" clearly fails the swap ("standing there" loses the entire point); "the
    doctor walking in WITH A SMILE" wins because of the specific detail ("with a smile"), not
    despite the bare "walking in" being generic on its own. Added two new counter-examples
    (personal-life and business domains) showing the swap test correctly rejecting a nominal
    anchor and keeping the segment at `"nothing"`, so the tie-breaker section now demonstrates
    restraint as well as rescue.

    Not yet confirmed against real usage — same standing caveat as every other number/rule tuned
    today. The live logging from point 13 is what will actually confirm whether this qualifier
    helps or needs further adjustment, not this reasoning alone.
16. **Canonical example set diversified — lower-confidence, precautionary, not a demonstrated bug
    (2026-07-19).** Self-audit: the same ~6 short phrases ("gives me a little hope", "the dream
    was alive", "the pressure couldn't have been greater", "many fans wonder...", the
    resilience/trust example, the missed-penalty example) recur as the go-to illustrative shorthand
    for "bare internal state, no anchor" across four different sections of this prompt. Worth
    flagging as a real risk in principle (a narrow canonical set could teach recognition of those
    specific strings rather than the underlying pattern) — but weaker evidence than points 6/12/13,
    which were confirmed live bugs or counted imbalances. The novel stress tests already run this
    session (mentor-reputation, sourdough-starter, bare-belief examples — none reused from the
    prompt itself) already showed the model generalizing past this exact canonical set, which cuts
    against this being a live problem right now.

    Given that, treated as light, low-risk prevention rather than a rewrite: added 2 new example
    phrases spanning different emotional registers (fear, regret) to the foundational Part 1 list
    in the concreteness gate (the first and most authoritative appearance), plus one more to the
    `"nothing"` bullet's own example list (the actual decision point). Deliberately did NOT touch
    every downstream repetition of the original set (the Note paragraph, the query-writing
    fallback) — diminishing returns against real risk of introducing a typo/inconsistency for
    marginal benefit on an already very long prompt. If the live logging ever shows the model
    failing to generalize past near-verbatim matches of the canonical set, that's the signal to
    revisit this more thoroughly; nothing currently indicates that's happening.
17. **Anchor inheritance from a preceding segment — a real gap, not yet exercised live
    (2026-07-19).** `"subject"` has always explicitly resolved from earlier context (a pronoun
    continuing an established story). The concreteness gate's part (2) never clarified whether a
    physical ANCHOR gets the same treatment — it explicitly forbids borrowing an anchor from a
    NEXT segment (the missed-penalty rhetorical-setup example), but said nothing about a PRECEDING
    one. Real scripts hit this constantly: an action beat followed immediately by a pure-reaction
    beat with no anchor of its own ("He stood at the podium, hands trembling... In that moment, it
    finally felt like all those years had led somewhere.") — without inheritance, the second
    segment would wrongly drop to `"nothing"` despite being clearly, continuously inside the first
    segment's scene.

    Fixed by extending the same resolution pattern `"subject"` already uses, with an explicit
    boundary so it doesn't become a loophole: an anchor inherits from the immediately preceding
    segment ONLY when this segment is a direct, continuous extension of that same physical moment
    (same instant, same scene) — not a later reflection on it. Worked contrast pair: the podium
    example (inherits, stays `"feel"`) against "He scored the winning goal in the final minute.
    Three years later, he still couldn't explain why that moment meant so much." (does NOT
    inherit — a later reflection from a different time/vantage point, not a continuation; the
    second segment is also independently a bare internal state with nothing of its own to anchor
    to, so it lands on `"nothing"` either way). The test given to the model: is this segment still
    physically INSIDE the moment the previous one established, or has it stepped OUTSIDE to
    reflect on it from later/elsewhere?

    This was identified by self-audit, not a live failure — no test script run this session
    happened to exercise consecutive action-then-reaction segments, so this gap existed
    undetected. Worth specifically testing a real multi-segment script with this exact pattern
    (an action beat immediately followed by a reaction beat) before trusting this holds.
18. **A real 71-segment script surfaced a confirmed bug — "remember/recall X" wrongly disqualifies
    a real, findable X (2026-07-19).** First real live test of the concreteness gate against a
    dense, full-length script (48 of 71 segments landed on `"nothing"`) — worth reading the actual
    per-segment breakdown before assuming that rate itself is the problem, because it mostly
    isn't: line-by-line review of all 48 found roughly 40+ correctly `"nothing"` (the script leans
    heavily on short dramatic fragments and pure connective narration — "Then came France.",
    "Again.", "1–1." — several segments are near-verbatim matches to canonical examples already
    in this file, e.g. "The pressure couldn't have been greater."). **The 68% rate is a property
    of this script's fragment-heavy style, not evidence the gate is broadly over-triggering** —
    don't retune based on the raw percentage alone next time this comes up.

    The real bug was narrow and specific, confirmed by direct comparison of two adjacent,
    identically-shaped segments: `"For Lionel Messi, it was finally lifting the trophy in 2022."`
    correctly resolved `evidence` (lifting a trophy is an unambiguous action), but
    `"For Cristiano Ronaldo, many remember the World Cup that slipped away."` — same sentence
    shape — wrongly landed on `"nothing"`, and `"...one penalty in Qatar became part of his
    story."` hit the same mechanism. Root cause: any memory/retrospective-framing verb (remember,
    recall, became part of his story) was being treated as automatically disqualifying, the same
    way genuine hypotheticals are (correctly) disqualified — but a memory-verb wrapping a
    reference to a REAL, SPECIFIC, nameable event ("the World Cup that slipped away", from
    Ronaldo) is not the same as a memory-verb wrapping pure speculation ("how different history
    would have been", naming nothing real). The framing verb was being read as content instead of
    as narrative dressing around real content.

    Fixed by adding a strip-the-verb test to the `"subject"` paragraph (and cross-referenced for
    `"categoryClaim"`): remove the memory-framing verb — is there still a real, specific, nameable
    event/entity standing on its own, or does removing the verb leave nothing actually named?
    Only the latter stays disqualified. Explicitly distinguished from the existing rhetorical-
    setup exclusion (`"It wasn't just a missed penalty."`) — that one is disqualified for being
    INCOMPLETE (gestures at a payoff the next segment delivers), whereas "many remember X" is a
    complete, standalone claim about a real X.

    **Not yet re-verified live.** Re-run the same 71-segment script (or at minimum the Messi/
    Ronaldo/Kane trio) after this deploys to confirm Ronaldo and the Kane-penalty-callback segment
    now resolve to `evidence`, and — just as importantly — that the ~40 correctly-`"nothing"`
    segments from this same script (the fragments, the canonical abstract-judgment lines) did NOT
    shift, since this fix only targets the strip-the-verb pattern specifically.

    A few smaller, lower-confidence borderline cases surfaced in the same review but were left
    alone deliberately (not evidence-backed enough to act on yet, and some may be legitimate
    redundancy-avoidance rather than bugs — e.g. segments restating an outcome already fully
    depicted by an earlier `evidence` segment in the same script, like "England lost 2–1." right
    after the actual missed penalty was shown): "The defending world champions." (a fragment
    naming France without an action), "He was already England's all-time leading goalscorer..."
    (a real record stated as a reputation claim, though a near-duplicate fact gets `evidence`
    coverage one segment later), and "He's remembered because he kept coming back." (a
    perseverance theme handled correctly elsewhere in the same script via the rhythmic-list
    exception, but not here in prose form). Worth another look only if the live logging shows a
    recurring pattern, not worth chasing from a single script's data alone.

## Scene context resolution — per click again, NOT a whole-script pass (reverted 2026-07-18)
**This was a real, shipped-then-reverted mistake, worth reading in full before touching this area
again.** A "Narrator" pass was added 2026-07-17: a second Groq call inside `segment.js`'s handler,
`narrateSegments()`, that resolved pronouns/elliptical fragments ("A missed penalty." → "Harry
Kane misses a penalty against France") for EVERY `evidence`/`reference` segment in ONE batched call
at project-creation time, instead of each "Find footage" click resolving its own context from raw
preceding text. The reasoning at the time was sound in isolation (one call with the whole script
in view beats many calls each re-deriving context from a sentence dump) — but it missed the actual
reason the original per-click design existed: **keeping every individual action small and
independent so no single request's cost scales with the whole script.** Batching broke that.

Confirmed live with a real ~4.7k-character, ~90-segment script (see "Reliability & rate-limit
lessons" below for the full chain of failures this caused): segmentation + narrate together, both
on the same model in the same request, could require MORE tokens than that model's entire
per-minute quota — not as an occasional contention issue, but structurally, every time, for any
script around that length or longer. No amount of waiting or retrying fixes a single request that
needs more tokens than an entire minute's allowance permits in one shot.

**Fix: `narrateSegments()`/`NARRATE_PROMPT` were removed from `segment.js` entirely.** Segmentation
is back to being ONLY family classification — small and fast regardless of script length. The two
hard-won resolution rules the Narrator had learned (always carry forward the specific time/edition/
event established earlier, not just on first mention; resolve a "next opponent/next stage"
fragment as the relationship to the subject already being followed, not a standalone topic) were
folded directly into `evidence-search.js`'s own per-click intent-extraction prompt instead of
lost — see the "TWO RULES" block in its `SYSTEM_PROMPT`, same two paired sports/business examples
as before. Each "Find footage"/"Find reaction clip" click now resolves its own segment's context
from a raw concatenation of preceding segment text (`app.js`'s `findFootage()`), same as
originally, just carrying the better resolution logic this time. `seg.context` no longer exists
anywhere in the data model — it was removed from `buildLiveSegments()` and every call site that
read it, rather than left as dead unused shape.

**The lesson, generalized:** if a piece of work was deliberately kept small/incremental/per-action,
that's very likely load-bearing for exactly the kind of scaling failure this caused — check why
before centralizing it "for efficiency," and if you do centralize it, test against a REALISTIC
full-size input, not a small hand-picked example, before believing it's safe.

## Reliability & rate-limit lessons (2026-07-18) — read before touching Groq call sites
The app was crashing/hanging under real use. Root-caused and fixed across several real, live-
confirmed bugs — several fed into each other, and the mistakes here are as important as the fixes.

**1. Auto-hydrate burst → batched instead.** `app.js`'s `hydrateClips()` fired one
`/api/stock-search` call PER "feel" segment, all via `Promise.all` on EVERY workspace load — a
script with 10-15 feel beats meant that many concurrent Groq rerank calls at once, bursting past
Groq's per-minute limit on every reload, not just a rare edge case. Fixed with a new
`/api/stock-search-batch` endpoint: Pexels searches still run per-segment (each needs its own
query) but through a small concurrency pool (`PEXELS_CONCURRENCY = 4`) instead of all-at-once, and
ALL segments' candidates get reranked in ONE combined Groq call (`rerankStockCandidatesBatch` in
`stock-search.js`) instead of one per segment. `hydrateClips()` now calls this once per page load.

**2. Shared retry wrapper (`functions/api/_groq.js`).** Every Groq call in the app now goes
through `groqChat(env, {...})` instead of a raw `fetch()`. Two distinct retry behaviors, don't
conflate them:
   - **429 (rate limit):** retries only if the wait is short (capped at `MAX_WAIT_MS = 2000`).
     A 429's `Retry-After` means different things depending on why it fired — a few seconds for a
     brief per-minute burst (worth waiting out), or minutes for a daily-quota wall (waiting just
     delays the same inevitable failure and makes the request hang instead of failing fast). The
     cap is what tells these apart; don't remove it or "helpfully" honor a longer `Retry-After`.
   - **400 `json_validate_failed`:** retries IMMEDIATELY, no wait. This is Groq's own JSON-mode
     enforcement rejecting the model's malformed/truncated output — a stochastic generation slip,
     not a rate limit, and resampling the same prompt often just produces valid JSON the second
     time. Needs to peek at the response body to tell this apart from a genuinely bad request,
     since the 400 status code alone doesn't distinguish them.

**3. `max_completion_tokens` was never set — real, reproducible truncated-JSON failures on long
scripts.** Segmentation's output has to echo back nearly the ENTIRE script verbatim (every
segment's `"text"` is a substring of it) plus per-segment JSON overhead, so its output size scales
with script length, not a fixed small amount. Never setting an explicit cap meant relying on
whatever default Groq applies — reproduced live, 3/3 tries, on a real ~4.7k-character/~90-segment
script: it consistently failed with `json_validate_failed` and an EMPTY `failed_generation`
(truncated mid-generation, not stochastic). **This was never once caught by testing, because every
regression test all session had been a hand-picked 1-3 sentence snippet** — scale-dependent bugs
like this don't exist at that size. Always include at least one full-length realistic script in
verification for this file, not just small boundary-case snippets.
   - Fix: `max_completion_tokens` set explicitly, sized off `script.length`. (The same cap was also
     added to the now-removed `narrateSegments()` call — moot since that whole call was reverted,
     see the section above, but the "cap = size off actual output volume, not a flat constant"
     principle applies to any Groq call whose output scales with input.)
   - **Second-order mistake, also confirmed live:** the first version of this cap was padded
     generously ("to be safe" against truncation) — `Math.ceil(script.length / 2) + 800`. That
     itself became a NEW problem: Groq's TPM rate limiter reserves the FULL declared
     `max_completion_tokens` value upfront as "Requested" tokens, regardless of how much the model
     actually generates (confirmed live — adding the cap alone jumped a real request's `Requested`
     figure from 2660 to 5837 tokens). An over-padded cap can single-handedly eat most of an
     entire per-minute budget in one call. Tightened to `Math.ceil(script.length / 2.5) + 600` —
     sized close to the actual minimum need (echoed text + JSON overhead ≈ input length, not 2x)
     rather than padded "to be safe." **The general lesson: a safety margin against one failure
     mode (truncation) can directly cause a different one (TPM exhaustion) if it consumes the same
     limited resource — size it to the actual need, don't just pad generously and call it safe.**

**4. Model-swap trap: a "bigger daily quota" model can have a WORSE per-minute quota.**
`llama-3.3-70b-versatile` (100k tokens/DAY, 12k tokens/MINUTE) was swapped for `gpt-oss-120b`
(200k/day, but only 8k/minute) specifically to fix the daily-quota wall — and it did — but this
traded a rare, severe failure (blocked for the rest of a UTC day) for a milder, MORE FREQUENT one
(blocked for up to a minute), because 8k TPM is a small, easy-to-hit ceiling once several call
types share it. **Always check TPM, not just TPD, before moving load onto a model to fix a quota
problem — the axis you're not looking at can be worse.** (Current published Groq free-tier
numbers, useful as a reference next time this comes up: `llama-3.1-8b-instant` 30 RPM/6k TPM/500k
TPD, `llama-3.3-70b-versatile` 30 RPM/12k TPM/100k TPD, `gpt-oss-120b` and `gpt-oss-20b` both 30
RPM/8k TPM/200k TPD. `qwen/qwen3.6-27b` exists but is preview/evaluation-only — not used here on
purpose, don't add it without flagging that risk.)

**5. Don't fix a real problem by re-centralizing what was deliberately decentralized.** See the
"Scene context resolution" section above — the batched Narrator pass, not just the token-cap
tuning, was the actual structural cause of the worst of this session's failures. This is listed
here too because it's as much a rate-limit lesson as a design lesson: distributing Groq calls
across TIME (per user action) is a real, load-bearing mitigation on a free tier, same in spirit as
distributing them across MODELS (point 4). Don't undo one kind of spreading while fixing the other.

## Clip search — Pexels only now (`functions/api/stock-search.js`, gifs dropped 2026-07-17)
Gifs (Giphy) used to cover the `feel` family's reaction-punch beats alongside Pexels' atmosphere/
action beats — that `"stock"`/`"gif"` split, `find-clips.js`, and `GIPHY_API_KEY` are all gone
now. Reason: gifs were consistently low-quality and too short to be a useful cut in an actual
edit — the exact thing this app is supposed to hand over. `feel` is Pexels-only: every beat gets
a 2-5 word descriptive VISUAL SCENE PHRASE (describe the shot, not a mood word — Pexels indexes
what's on screen, not a feeling) and searches real stock footage. `evidence` and `reference` are
unaffected — each is still built on its own YouTube pipeline; see "Evidence & reference
pipelines" above. All three are covered by "Stock footage" below for the actual search mechanics.
- Cross-segment dedup (wired through `app.js` `hydrateClips()`): each searchable segment fetches
  a pool of 8 candidates, then after all fetches resolve a client-side pass greedily assigns
  non-duplicate results (by clip `id`) in segment order, slices to 4, and falls back to a
  segment's own pool if everything got filtered out — so the same clip doesn't get reused
  project-wide. The `query` field is threaded through `buildLiveSegments()` and sent as
  `seg.query || seg.text`.

## Stock footage (Pexels) — the ONLY `feel` source (WIRED UP)
Stock lives entirely on Cloudflare — no worker, no HMAC, no yt-dlp. Pexels returns direct-CDN
MP4s that are already short, licensed, and the right resolution, so there's nothing to trim or
sign, just a same-origin download proxy so `<a download>` actually saves instead of playing the
CDN url in a tab (cross-origin `download` attributes are ignored by the browser).
- `functions/api/stock-search.js` (`POST /api/stock-search`, body `{query, orientation?}`):
  calls `GET api.pexels.com/videos/search` with header `Authorization: <PEXELS_API_KEY>` (raw
  key, NOT `Bearer` — that's Pexels' convention, not this app's). Exports `mapPexelsVideo(v)`
  (best `<=1080p` mp4 as `downloadUrl`, an `sd`-quality mp4 as `previewUrl`).
- `functions/api/stock-download.js` (`GET /api/stock-download?url=&name=`): streams the upstream
  CDN mp4 back with `Content-Disposition: attachment` (no buffering). Open-proxy guard: only
  fetches hosts ending in `.pexels.com` or `.vimeo.com` — never an arbitrary caller-supplied URL.
- Routing: **Segmenter** (`segment.js`) is the only place Pexels gets used now — every `feel`
  beat gets a `query` (a 2-5 word descriptive scene phrase) and is sent to Pexels. (2026-07-18:
  `evidence-search.js` used to have a second Pexels route here too — a `footageType:"generic"`
  short-circuit for category-level claims — removed, see point 7 under "Segmentation"; ALL
  `evidence` now goes to YouTube regardless of flavor.) `reference` never gets a `query` field at
  all — its identification happens downstream in its own dedicated search step, not in the
  segmenter.
- Frontend (`app.js`): `hydrateClips()` sends every `feel` beat to `/api/stock-search` and renders
  via `clipCardHtml`/`openPreview`. `openPreview` shows `#modal-video` (a real `<video>` playing
  `previewUrl`) and points the download button at `/api/stock-download?url=<downloadUrl>&name=<id>`.
  Stock clip ids are prefixed `pexels-<id>`. `findFootage()`'s `data.source === "stock"` check is
  now dead code (evidence-search.js never returns that shape anymore) — harmless but unreachable,
  optional cleanup if this file gets touched again.
- Needs `PEXELS_API_KEY` as a Cloudflare Pages secret (Production env) — free tier, 200 req/hour.

## Trim-to-download (Pexels/stock clips only, added 2026-07-17)
Downloading a whole clip just to cut it down in another editor is friction Pexels' license
actually lets this app remove — YouTube-sourced clips stay link-only (see above), but Pexels
content is genuinely licensed for reuse, so trimming here is a real feature, not a legal
question. Deliberately kept minimal per the product's own principle (don't turn into an editor,
don't bloat the app): entirely client-side, no server component, no new library/dependency.
- `setupStockTrimRow(clip)` (`app.js`, wired from `openPreview()` for `clip.source === "pexels"`
  only) reuses the existing `#trim-row` DOM (start/end timecode inputs, Preview range, Download
  range) that used to belong to the now-removed YouTube manual-trim feature. **Preview range**
  just seeks/plays the already-visible `#modal-video` between the chosen times — plain playback,
  no CORS concern. **Download range** calls `recordClipRange(clip, start, end)`.
- `recordClipRange()`: creates its own hidden `<video crossOrigin="anonymous">`, sets `src` to
  `clip.downloadUrl` (Pexels' own CDN, NOT proxied through `/api/stock-download`), and once it's
  seeked to `start`, captures it via `HTMLVideoElement.captureStream()` into a `MediaRecorder`,
  stopping at `end`. Resolves a `Blob` that's handed to the browser as a normal file download.
  **Verified via curl that Pexels' CDN sends `Access-Control-Allow-Origin: *`** — that's what
  makes the direct-CDN `crossOrigin="anonymous"` capture legal instead of a tainted/blocked
  stream; if that ever changes, the capture would need to route through `/api/stock-download`
  instead (same-origin, guaranteed CORS-safe, but double-fetches the file).
- Output is **`.webm`**, not `.mp4` — that's `MediaRecorder`'s native format on Chromium (codec
  picked from `vp9,opus` → `vp8,opus` → generic `webm`, whichever `MediaRecorder.isTypeSupported`
  first accepts). Shipping an mp4 re-encoder client-side would mean bundling `ffmpeg.wasm`
  (~25MB) for one feature — not worth it. Every modern editor, CapCut included, opens `.webm` fine.
- Known real bug caught during testing, worth remembering: setting `video.currentTime` to the
  value it's *already at* (start=0 on a freshly-loaded video, the common case) never fires a
  `seeked` event — code that only starts recording on `onseeked` hangs forever with a default
  0:00 start. Fixed by checking `Math.abs(video.currentTime - start) < 0.05` in `onloadedmetadata`
  and skipping straight to `beginRecording()` when already there.
- Browser support: needs `HTMLVideoElement.captureStream` (Chromium — the actual target, since
  this app's own maintainer is on a Chromebook — not Safari). Feature-detected; shows a plain
  error string if unsupported rather than failing silently.

## Reaction clip footage (reference beats) — migrated off Giphy onto the evidence skeleton (WIRED UP)
Giphy/Tenor are a tag-based reaction-gif index, not a meme database — they can't represent an
actual *named* meme ("Surprised Pikachu," "This Is Fine," "Stonks Guy") and skew to old (2013-2016)
evergreen gifs, so `reference` results were low-quality and disconnected from actual meme culture.
The first fix asked an LLM to name the specific meme — but an LLM's meme knowledge is stuck at its
training cutoff and can't track what's actually current, so that was replaced with this: search
YouTube by **emotion/reaction** the same way `feel` already searches Giphy (no meme naming at
all), then lean on **deterministic filtering heuristics** — not frame/caption analysis — to
surface genuine raw reaction clips instead of compilations, reaction-channel commentary, or
YouTube Shorts. The evidence pipeline (YouTube search → enrich → LLM rerank → plain links) never
actually depended on "real event" semantics — so `reference` reuses it wholesale with a
differently-tuned intent + rerank prompt, same as before.
- `functions/api/reference-search.js`: Groq generates `{"query":"..."}` — a short emotion/reaction
  search phrase in the spirit of `feel`'s Giphy query style but phrased for real YouTube footage
  ("shocked crowd reaction," "stunned silence reaction real footage"), not a meme name and not a
  gif tag. `quote` is dropped from the response shape entirely — reactions aren't quote-based, so
  it's always signed as `null` downstream.
- **`filterRawReactionCandidates()`** (new, plain code, no LLM call) runs after `enrichCandidates()`
  and before rerank: drops titles matching a junk regex (compilations, "top 10," "best of,"
  reaction-to-reaction/commentary like "reacts to"/"review"/"explained," multi-part videos), drops
  anything with a `#shorts`/`#short` marker in title or description (actual YouTube Shorts are
  often remixes/compilations themselves, not the raw clip), and drops anything with unknown
  duration or `durationSec > 180` — the length-as-proxy-signal: with no frame/caption analysis
  attempted for this family, a long video can't be trimmed down to the moment, so it's excluded
  outright rather than kept and mis-trimmed. If everything gets filtered out, returns empty
  `candidates` — the frontend's existing "No footage candidates found" state already handles it.
- Its rerank prompt (still the same exported `rerankCandidates(intent, candidates, env,
  systemPrompt)` from `evidence-search.js`, just a different `systemPrompt`) scores survivors on
  **capture quality/authenticity** — is this genuinely a raw, single, undoctored capture of the
  reaction, not a video *about* the reaction — rather than evidence's "primary/official footage"
  rubric or the old meme-recognizability rubric.
- Reuses `evidence-search.js`'s YouTube search/enrich/rerank machinery directly —
  `searchYouTubeVideos`, `enrichCandidates`, `rerankCandidates` are named exports from
  `evidence-search.js`, imported into `reference-search.js` (same "export from the canonical
  file" pattern already used for `mapPexelsVideo` between `stock-search.js`/`evidence-search.js`).
- Frontend (`app.js`): `reference` stays out of `SEARCHABLE_FAMILIES` (just `["feel"]`) onto the
  same user-triggered pattern as evidence — auto-hydrating would re-fire a YouTube search on
  *every* workspace load for *every* reference beat, burning through the free 10k-units/day quota
  fast (`search.list` alone is 100 units). `findFootage()` routes by family
  (`/api/reference-search` vs `/api/evidence-search`) but is otherwise unchanged — both endpoints
  return the same candidate shape, so `renderEvidence`/`evidenceCardHtml`/`openEvidencePreview`
  needed no changes at all. Button label is "Find reaction clip" for this family.
  **(2026-07-19: this last sentence is now only half true — see below. `evidenceCardHtml`/
  `openEvidencePreview` themselves still needed zero changes, but `findFootage()` gained a new
  branch and a new render function, since `reference-search.js` now returns TWO result sets, not
  one candidate shape.)**

**2026-07-19 — always-parallel YouTube + Pexels search, not a fallback.** Every "Find reaction
clip" click now searches BOTH YouTube (reaction/meme clips) AND Pexels (stock footage) in
parallel, always — not sequentially, not as a fallback that only tries Pexels when YouTube comes
up empty. Direct product decision: a genuine raw meme/reaction clip and licensed stock b-roll of
the same emotion serve different purposes (authenticity vs. clean footage), so both should be
available together whenever either finds something, not one gatekeeping the other. The segment
only ends up with no clip if BOTH searches come up empty.
- Query-generation (`SYSTEM_PROMPT`) now produces two fields from one Groq call: `query` (YouTube)
  judges per moment whether the emotion is a common, well-indexed reaction-culture category (shock,
  laughter, disbelief, cringe) — for which it strings the emotion + "reaction" + literally "meme"
  together (e.g. "shock reaction meme"), since that's what's actually well-indexed — versus
  something more unusual/narratively-specific, where plainer emotion-only phrasing avoids biasing
  toward meme-culture matches that don't exist for that nuance. `stockQuery` (Pexels) is generated
  unconditionally either way — a concrete visual-scene phrase (a visible gesture/expression/
  posture), same rule `segment.js`'s `feel` query already follows, since Pexels indexes what's on
  screen, not emotion keywords. The meme-keyword judgment only affects `query`'s phrasing; it has
  no bearing on whether Pexels runs (it always does).
- `onRequestPost()` was split into two never-throwing pipeline functions —
  `searchYouTubeReaction()` (the existing search→enrich→`filterRawReactionCandidates()`→
  `rerankCandidates()` chain, unchanged in substance, just extracted) and `searchPexelsReaction()`
  (fetch→`mapPexelsVideo()`→`rerankStockCandidates()`, reusing `stock-search.js`'s exports) — run
  concurrently via a plain `Promise.all`. Neither function ever throws; every failure mode (API
  error, zero results, parse failure) resolves to `[]` internally, so one path's failure can never
  block or reject the other. `PEXELS_API_KEY` is deliberately NOT hard-guarded at the top of
  `onRequestPost()` the way `GROQ_API_KEY`/`YOUTUBE_API_KEY` are — this endpoint's core identity is
  still "find a reaction clip" (YouTube); Pexels broadens it, so a missing/misconfigured Pexels key
  degrades to YouTube-only results rather than 500ing a request YouTube alone could serve —
  `searchPexelsReaction()` checks for the key itself. Response shape is now
  `{subject, stockQuery, candidates, clips}` — both result arrays always present (possibly empty),
  never an either/or switch the way an earlier fallback-only draft of this feature would have made
  it.
- `app.js`'s `findFootage()` now branches on `family === "reference"` to populate BOTH
  `seg.evidence.candidates` and `seg.clips` from the one response, then calls a new
  `renderReferenceFootage()` — confirmed safe because `SEARCHABLE_FAMILIES` is `["feel"]` only, so
  `hydrateClips()` never touches a reference segment's `seg.clips`. `renderReferenceFootage()`
  concatenates `evidenceCardHtml()` output (YouTube) and `clipCardHtml()` output (Pexels) into one
  `.clip-queue` — each keeps its own existing, unmodified card renderer and click handler
  (`openEvidencePreview`/`openPreview`), working off its own independent array + index; no
  collision risk. No section headers — the existing "YT"/"STOCK" source-chip (already fully wired:
  `SOURCE_LABEL`, `mapPexelsVideo`'s `source:"pexels"`, `.src-youtube`/`.src-pexels` CSS) is the
  established way every other clip-queue in this app distinguishes source, so it's sufficient on
  its own. An empty side just contributes nothing to the concatenation — only when both are empty
  does the "No footage candidates found for this moment." message show.
- **Deleted** a dead `if (search.source === "stock")` branch that had been sitting unreachable in
  `findFootage()` since evidence-search.js's own generic-Pexels routing was removed (2026-07-18,
  see "Segmentation" point 7 above) — neither current endpoint ever set `source`, and this new
  design's response shape doesn't use it either (both result sets are always present together,
  never switched), so it would have stayed permanently dead and confusing if left in place.

## Google Images on evidence beats (SerpAPI, added 2026-07-19)
Google's Programmable Search Engine was ruled out first — its "search the entire web" option was
killed for all new engines in Jan 2026 (new engines are capped at 50 fixed domains; whole-web
needs enterprise Vertex pricing), so SerpAPI's `google_images` engine is the whole-web image
source instead. **Free plan: 250 searches/month, no card** — every evidence "Find footage" click
spends one, so this is the tightest quota in the app (~8/day); identical searches within an hour
hit SerpAPI's cache free. Upgrade path is $25/mo for 1,000 if the product ever needs it.
- **Scope: evidence beats ONLY, deliberately.** An images-for-reference-beats variant (meme
  stills via the same emotion+"reaction meme" query logic) was planned and then explicitly cut
  by the user before building ("drop the meme/feel part... just evidence for now") — if it comes
  back, the design was: third intent field in `reference-search.js`, same common-vs-unusual
  emotion judgment as the YouTube query, meme-native-domain preference (knowyourmeme/imgflip/
  i.redd.it) in the filter profile.
- `functions/api/_serpapi.js` (underscore = import-only, same as `_groq.js`): one export,
  `searchGoogleImages(env, query)`. Fixed params do the type filtering AT GOOGLE — 
  `image_type=photo` (excludes animated gifs/clipart/lineart at the source, per the user's
  explicit "no gifs" requirement), `imgsz=l` (no icons/tiny thumbs), `safe=active`. Code-level
  backstops behind that: a `.gif` extension check on the original URL, and a blocked-domain regex
  (Pinterest = aggregator pointing at pins not sources; Getty/Alamy/Shutterstock/iStock/
  Dreamstime/123rf/Depositphotos = watermarked-preview-only, useless to an editor). NEVER throws;
  missing `SERPAPI_KEY`, quota exhaustion, or any fetch failure resolves to `[]` — images are
  additive, so `evidence-search.js` deliberately does NOT hard-guard the key the way it guards
  `ANTHROPIC_API_KEY`/`YOUTUBE_API_KEY` (same reasoning as `PEXELS_API_KEY` in
  `reference-search.js`).
- **No LLM rerank on images, deliberately** (unlike every other result type): with no vision, a
  rerank could only score title+domain metadata — weak signal for an extra per-click Groq call.
  Google Images' own ranking for a well-formed specific query is kept as-is; the deterministic
  domain/type filters do the real quality work. Revisit only if live results are actually bad.
- `evidence-search.js`: the Claude intent extraction gained an `"imageQuery"` field (rides the
  existing call — NOT a new Claude call site) — same subject/year/event as `youtubeQuery` but
  phrased for a still photo (drop video-title words, name the frozen instant). Falls back to
  `youtubeQuery` if absent. The SerpAPI fetch starts before the YouTube pipeline and runs
  concurrently with all of it (search+enrich+rerank), awaited only at response time. Response
  gains `images: [...]`; the per-click log line now includes `imageQuery`, and `_serpapi.js` logs
  raw/kept counts per search.
- Frontend (`app.js`): `renderEvidence()` concatenates `imageCardHtml()` cards after the YouTube
  candidates in the same `.clip-queue` (same pattern as `renderReferenceFootage()`), distinguished
  by a new "IMG" `src-chip` (`.src-image`, blue). **An image card is a plain `<a target="_blank">`
  to the image's SOURCE PAGE** — no preview modal, no full-res display, no download. The thumbnail
  shown is Google's own hosted thumb (`encrypted-tbn`/data URI); the full-res `original` URL is
  never returned by the API at all, so the frontend can't accidentally hotlink it — same link-only
  boundary as YouTube evidence, enforced at the data shape, not just the UI.
- Setup: `SERPAPI_KEY` as a Cloudflare Pages secret (Production), then force a redeploy
  (`npx wrangler pages deploy . --project-name cliphunt --branch master --commit-dirty=true`) —
  secrets bind at deploy time, standing rule.
- Not yet verified live at the time of writing — needs a real script's evidence beats clicked
  through with the secret set: confirm the IMG cards render, the queries in the tail log are
  photo-shaped (not video-title-shaped), and junk domains actually get filtered.

## What's NOT built yet
- Twitter/Instagram post lookup for `subject_post`-style evidence (oEmbed-based, no OCR — was the plan, not started)
- Voiceover transcription (Whisper or similar) — the "Voiceover" choice card on `new-project.html` is UI-only, not functional
- File upload for pasted-script (.txt/.docx/.pdf) — also UI-only
- Any persistence beyond localStorage (projects are lost on clearing browser storage; no server-side/cross-device store)

## Known constraints from the person building this
- Cost-conscious but no longer strictly $0 (heading toward a sellable product): free tiers where possible (Cloudflare Pages, Groq, YouTube API, Pexels). As of 2026-07-18, one deliberately-scoped paid piece exists: Claude Sonnet for segmentation + evidence-search intent extraction, on a small real Anthropic balance — see "Model split" under "Segmentation" above. Ask before expanding Claude usage to more call sites or introducing anything else paid.
- No emoji as icons anywhere — inline SVG only (see existing icon usage in the HTML files for the established style).
- Dark "editing bay" theme (near-black warm background, amber accent, Bricolage Grotesque + IBM Plex Sans/Mono) — this was a deliberate reaction against generic AI-template looks (cream background, emoji icons, purple gradients). Keep it consistent if extending the UI.
- Product principle (2026-07-17): don't turn into a video editor, and don't lock creators into
  editing inside this app — that's the differentiation from tools like Kapwing/OpusClip/CapCut's
  built-in AI features. ClipHunt hunts for clips and hands over options (a link to judge, or a
  real file where it's legally clean to hand one over); it never tries to own the timeline. This
  is *why* YouTube results are link-only rather than downloadable even though downloading would
  be a "nicer" UX — it's a deliberate boundary, not a limitation to work around later.
- Deploy: this project is now **git-connected** (added 2026-07-17) — Cloudflare Pages watches
  `master` on github.com/duxe10/cliphunt and auto-builds/deploys on push, same as the worker used
  to. `npx wrangler pages deploy . --project-name cliphunt --branch master --commit-dirty=true` is
  still available for a manual direct-upload deploy (useful to force a redeploy after changing a
  secret without a code change), but **the branch name matters**: deploying with `--branch
  production` (the OLD convention, from before git-connect) now lands as a **Preview** deployment
  with no access to Production secrets, not Production — always deploy with `--branch master` to
  match the actual configured production branch. `.assetsignore` keeps `.git`/`worker`/docs out of
  the Pages upload (the `worker` line is now vestigial since the directory's gone, harmless to
  leave). Netlify is fully decommissioned.
- After changing a Cloudflare secret (`GROQ_API_KEY` etc.) you must also redeploy — Pages binds
  secrets at deploy time, so the running functions won't see a new secret until the next deploy.
  A git push alone won't trigger this if nothing else changed in the commit — use the manual
  `wrangler pages deploy --branch master` command above to force one.
- Known gotcha from the migration: a GitHub merge once silently reverted a whole fix (evidence relevance) — if behavior regresses after a merge, check the deployed file actually contains the change (`git show <ref>:functions/api/evidence-search.js | grep footageType`), don't trust the commit graph alone.
- Local dev (`wrangler pages dev .`) has shown real latency flakiness in at least one environment
  (a `/api/stock-search` call to Pexels took 20+ seconds locally vs under 1s via direct curl, and
  the dev server has wedged/stopped responding after sustained repeated requests) — this hasn't
  been seen on the actual deployed Cloudflare edge, so treat local-dev slowness/hangs as a tooling
  quirk to route around (redeploy and test live) rather than a code bug, unless it reproduces live too.
- Workflow in this project: Claude Code web (Opus, via "Ultraplan") does planning/design and code review; this local session (recently switched planning/default model to Sonnet 5, per the user) does the actual implementation + deploy + live verification, since local has push/deploy access and web does not. Both read/write the same GitHub repo — "access to HANDOFF.md" just means whoever last did `git pull` has the current version; there's no live shared state beyond git.
