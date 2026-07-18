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
- Cloudflare Pages Functions for anything needing a secret API key, under `functions/api/` (routed as `/api/*`): `functions/api/segment.js` (Groq — segmentation/family classification only, see "Segmentation" below), `functions/api/_groq.js` (shared Groq fetch wrapper with retry/backoff — underscore prefix means Pages excludes it from routing, import-only, see "Reliability & rate-limit lessons" below), `functions/api/stock-search.js` + `functions/api/stock-search-batch.js` + `functions/api/stock-download.js` (Pexels — the only `feel` source, and generic-evidence's source, see "Stock footage" below), `functions/api/evidence-search.js` (Groq intent + context resolution + YouTube Data API + LLM rerank for `specific` beats, or Pexels for `generic` beats), `functions/api/reference-search.js` (same YouTube pipeline, reaction-focused). These are ESM (`onRequestPost`/`onRequestGet`, `context.env` for secrets), ported from the old Netlify handlers.
- Mostly-free constraint — Groq, YouTube Data API, and Pexels all have free tiers; keys live only in **Cloudflare Pages secrets** (`GROQ_API_KEY`, `YOUTUBE_API_KEY`, `PEXELS_API_KEY`), never in code. `GIPHY_API_KEY` is no longer used (gifs dropped entirely, see "Clip search" below) — safe to remove from Cloudflare secrets. NOTE: Pages binds secrets at deploy time — after changing a secret you must **redeploy** for functions to see it. **No non-Cloudflare piece anymore** — the yt-dlp/ffmpeg worker (Render) was decommissioned, see below.
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
  generic→Pexels short-circuit) as of THIS rework was unchanged, and YouTube search →
  `enrichCandidates` (duration/views) → LLM `rerankCandidates` (0-100 against the beat's actual
  claim, demoting reactions/watchalongs/compilations) — all of that search-quality work is
  unaffected by the download removal. The only change here: the top 5 reranked candidates are
  mapped to plain `https://www.youtube.com/watch?v=...` links and returned directly — no HMAC
  signing, no worker handoff, no `matchSig`/`exp`. (Intent-extraction's elliptical-reference
  resolution DID change later — see "Scene context resolution" below for the current version.)
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
- **evidence** — a specific real person/thing did the exact thing referenced, OR a category-level statement needing real illustrative footage → real footage from YouTube (link-only, not downloaded) for a named subject, or Pexels (downloadable) for a category statement — see "Evidence & reference pipelines" above
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
6. **`feel`/`evidence` atmosphere boundary — fixed twice, still not fully closed (2026-07-18):**
   `"feel"` covers pure atmosphere/mood/ordinary background human activity with no narrative
   significance (rain on a window, hands typing at a desk, an empty stadium); `"evidence"`(b)
   covers a CATEGORY doing/experiencing something real. These overlap in a way that's genuinely
   hard to word unambiguously: a script built from the prompt's OWN canonical `"feel"` examples
   came back `"evidence"` for all of them after the model swap (point above) — the same prompt had
   worked fine on the old model, so **prompt behavior is not portable across models; re-verify
   boundary cases after any model swap, don't assume a working prompt keeps working.** Fixed once
   by making the two bullets' exclusion lists actually match each other (they'd drifted). Tested
   again with a genuinely novel example never in the prompt ("A barista wiped down the counter as
   the cafe emptied out for the night") — still misclassified as `"evidence"`. Added an explicit
   "this is a pattern, not a fixed list" instruction plus more paired examples — tested AGAIN with
   yet another fresh example ("An aide shuffled papers at an empty podium...") — **still
   misclassified.** Concluded (not fixed further): the model reliably reads a "[a/an + role] +
   [specific verb] + [specific scene]" grammatical SHAPE as a narrative beat worth `"evidence"`
   regardless of content, and more prompt examples haven't closed this. Not chasing it further for
   now — the practical cost is low (evidence-search.js's own classifier hits the same ambiguity and
   likely routes to the same Pexels footage anyway; the real cost is an extra click + Groq call,
   not wrong footage). If this comes up again, a schema change (forcing an explicit "does this name
   a specific real entity? Y/N" field) is a more promising direction than another prompt example.

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

## Stock footage (Pexels) — the ONLY `feel` source, also generic-evidence's source (WIRED UP)
Stock lives entirely on Cloudflare — no worker, no HMAC, no yt-dlp. Pexels returns direct-CDN
MP4s that are already short, licensed, and the right resolution, so there's nothing to trim or
sign, just a same-origin download proxy so `<a download>` actually saves instead of playing the
CDN url in a tab (cross-origin `download` attributes are ignored by the browser).
- `functions/api/stock-search.js` (`POST /api/stock-search`, body `{query, orientation?}`):
  calls `GET api.pexels.com/videos/search` with header `Authorization: <PEXELS_API_KEY>` (raw
  key, NOT `Bearer` — that's Pexels' convention, not this app's). Exports `mapPexelsVideo(v)`
  (best `<=1080p` mp4 as `downloadUrl`, an `sd`-quality mp4 as `previewUrl`) so evidence-search's
  generic branch (below) can reuse the exact same mapping instead of duplicating it.
- `functions/api/stock-download.js` (`GET /api/stock-download?url=&name=`): streams the upstream
  CDN mp4 back with `Content-Disposition: attachment` (no buffering). Open-proxy guard: only
  fetches hosts ending in `.pexels.com` or `.vimeo.com` — never an arbitrary caller-supplied URL.
- Routing lives in two places:
  1. **Segmenter** (`segment.js`): every `feel` beat gets a `query` — a 2-5 word descriptive
     scene phrase — and is sent to Pexels. `reference` never gets a `query` field at all — its
     identification happens downstream in its own dedicated search step, not in the segmenter.
  2. **Evidence search** (`evidence-search.js`): the `footageType:"generic"` branch (a category
     statement, no one identifiable person/event) short-circuits straight to Pexels instead of
     YouTube — returns `{footageType:"generic", source:"stock", clips}`. `footageType:"specific"`
     goes YouTube → enrich → rerank → plain links (see "Evidence & reference pipelines" above).
     This means the YOUTUBE_API_KEY guard in `evidence-search.js` only applies once footageType
     resolves to specific — a generic-only deploy works with just GROQ+PEXELS keys.
- Frontend (`app.js`): `hydrateClips()` sends every `feel` beat to `/api/stock-search`;
  `findFootage()` checks `data.source === "stock"` on the evidence-search response and renders
  straight from `data.clips` (via the shared `clipCardHtml`/`openPreview`). `openPreview` always
  shows `#modal-video` (a real `<video>` playing `previewUrl`) and points the download button at
  `/api/stock-download?url=<downloadUrl>&name=<id>` — no more branching on clip source, since
  every `feel`/generic-evidence clip is Pexels now. Stock clip ids are prefixed `pexels-<id>`.
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

## What's NOT built yet
- Twitter/Instagram post lookup for `subject_post`-style evidence (oEmbed-based, no OCR — was the plan, not started)
- Voiceover transcription (Whisper or similar) — the "Voiceover" choice card on `new-project.html` is UI-only, not functional
- File upload for pasted-script (.txt/.docx/.pdf) — also UI-only
- Any persistence beyond localStorage (projects are lost on clearing browser storage; no server-side/cross-device store)

## Known constraints from the person building this
- Cost-conscious but no longer strictly $0 (heading toward a sellable product): free tiers where possible (Cloudflare Pages, Groq, YouTube API, Pexels). No paid pieces at all as of 2026-07-17 — the one that was (the Render worker) is gone. Ask before introducing anything meaningfully paid.
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
