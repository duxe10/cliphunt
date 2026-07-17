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
- Cloudflare Pages Functions for anything needing a secret API key, under `functions/api/` (routed as `/api/*`): `functions/api/segment.js` (Groq), `functions/api/find-clips.js` (Giphy — feel/gif path), `functions/api/stock-search.js` + `functions/api/stock-download.js` (Pexels — feel/stock + generic-evidence path, see "Stock footage" below), `functions/api/evidence-search.js` (Groq intent + YouTube Data API + LLM rerank for `specific` beats, or Pexels for `generic` beats), `functions/api/reference-search.js` (same YouTube pipeline, reaction-focused). These are ESM (`onRequestPost`/`onRequestGet`, `context.env` for secrets), ported from the old Netlify handlers.
- Mostly-free constraint — Groq (llama-3.3-70b), Giphy, YouTube Data API, and Pexels all have free tiers; keys live only in **Cloudflare Pages secrets** (`GROQ_API_KEY`, `GIPHY_API_KEY`, `YOUTUBE_API_KEY`, `PEXELS_API_KEY`), never in code. NOTE: Pages binds secrets at deploy time — after changing a secret you must **redeploy** for functions to see it. **No non-Cloudflare piece anymore** — the yt-dlp/ffmpeg worker (Render) was decommissioned, see below.

## Evidence & reference pipelines — link-only, no downloading (reworked 2026-07-17)
There used to be a separate worker service (`worker/`, Node+Express+Docker on Render) that ran
`yt-dlp`+`ffmpeg` to download and trim YouTube video server-side and stream it back as a file,
with HMAC-signed URLs authorizing it and a manual-trim signing function (`sign-clip.js`). All of
that — `worker/`, `functions/api/sign-clip.js`, `functions/api/config.js` (existed only to expose
`WORKER_URL`), and every `WORKER_URL`/`WORKER_TOKEN` reference — is now gone. Downloading and
redistributing someone else's YouTube video carried real copyright/ToS risk; the product decision
was to stop taking that risk and to differentiate on NOT locking creators into an editing
workflow ("hunt for clips," not "edit here") rather than on owning the clip file. What's kept:
- `functions/api/evidence-search.js`: unchanged intent-extraction (elliptical-reference resolution,
  generic→Pexels short-circuit) and unchanged YouTube search → `enrichCandidates` (duration/views)
  → LLM `rerankCandidates` (0-100 against the beat's actual claim, demoting reactions/watchalongs/
  compilations) — all of that search-quality work is unaffected by the download removal. The only
  change: the top 5 reranked candidates are mapped to plain `https://www.youtube.com/watch?v=...`
  links and returned directly — no HMAC signing, no worker handoff, no `matchSig`/`exp`.
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
- **feel** — pure emotion beat, no specific referent → searched on Giphy
- **evidence** — a specific real person/thing said or did the exact thing referenced → real footage from YouTube, trimmed & downloadable (WIRED UP — see Evidence pipeline above)
- **reference** — matches a known meme/cultural callback → real raw reaction clip from YouTube, trimmed & downloadable (WIRED UP — see "Reaction clip footage" below; migrated off Giphy)
- **nothing** — pacing beat/transition → no clip forced, and that's deliberate (a forced bad clip is worse than no clip)

This collapsed from a more elaborate original taxonomy (subject_quote/subject_post/meme_callback/etc.) for MVP simplicity — see git history / ask if the fuller version matters later.

## Segmentation (`functions/api/segment.js`)
Hardest part was getting segment *boundaries* right, not the classification. Lessons learned the hard way:
1. Default to splitting on every complete sentence — merging by "topic relation" over-merges (e.g. "For most footballers... / For Harry Kane..." should NOT merge, it's a deliberate contrast pivot).
2. The ONLY real merge signal is grammatical incompleteness — a segment starting with `...` or `—`, or the previous segment ending in a dangling `—`. This is NOT reliably followed by the model (llama-3.3-70b is small/fast, and this rule fights the "split by default" rule) — so it's enforced deterministically in code (`mergeFragments()` at the bottom of `segment.js`), not left to the prompt. Don't try to fix this by wording the prompt harder — it oscillates between over-merge and under-merge across runs. Code-level regex is the actual fix.
3. Words like "but"/"and"/"so" at the start of a sentence are NOT a fragment signal — very common as deliberate stylistic sentence-openers. Only `...`/`—` are unambiguous.

## Clip search (`functions/api/find-clips.js`)
- `feel` (with `source:"gif"`) is searched on Giphy (keyword search) — auto-hydrated on load.
  `reference` no longer uses Giphy — see "Reaction clip footage" below.
- `evidence` and `reference` are each built on their own YouTube pipeline (search → captions →
  fuzzy-match → trim/download); see "Evidence pipeline" and "Reaction clip footage" above/below.
  Both are user-triggered, not auto-hydrated.
- The model generates a `query` field per feel/gif segment now, instead of dumping raw sentence text at Giphy (raw text produced generic/repeated results). IMPORTANT lesson from testing against the live Giphy index: the query must be a SHORT 1-2 word COMMON reaction term (`hope`, `nervous`, `heartbreak`), NOT a clever specific phrase. Giphy search is tag-based — a specific phrase like "nation holds breath" matches almost nothing and Giphy returns an identical generic-junk fallback set for every unmatched phrase. An earlier version of this prompt pushed toward specificity ("finally believing again" over "hope") and it made results strictly worse — don't reintroduce that.
- Ambiguous-word guard (also in the prompt): some plain reaction words have a DOMINANT unrelated meaning on Giphy and pull off-topic content. The known one is "proud" → Giphy returns Pride-month content, so an "incredible achievement" beat that queried "proud" surfaced LGBTQ/Pride gifs. Prompt now tells the model to avoid such words and use unambiguous ones ("impressed"/"amazed"/"standing ovation" for success). If new off-topic drift shows up, it's usually another loaded single word — add it to that guidance.
- Recency: Giphy search has NO date filter and NO recency sort (confirmed against their API docs). Its top results skew to 2013-2016 evergreen reaction gifs. `find-clips.js` returns `importDatetime`/`trendingDatetime` per clip and does a SOFT re-rank (not a hard filter): stable-sort so gifs "active in the 2020s" (uploaded OR last-trended >= 2020) float above older ones, preserving Giphy's relevance order within each group. Deliberately NOT a hard 2020+ cutoff — that deletes most of the good evergreen gifs and thins pools to nothing. Note many 2013-2016 gifs have `trendingDatetime` in 2020-2025, i.e. old uploads that are still actively used — those correctly count as "fresh".
- Cross-segment dedup (wired through `app.js` `hydrateClips()`): each searchable segment fetches a pool of 8 candidates, then after all fetches resolve a client-side pass greedily assigns non-duplicate results (by gif `id`) in segment order, slices to 4, and falls back to a segment's own pool if everything got filtered out — so the same gif doesn't get reused project-wide. `find-clips.js` fetches `limit=8` to leave room for this. The `query` field is threaded through `buildLiveSegments()` and sent as `seg.query || seg.text`.

## Stock footage (Pexels) — the 4th clip source (WIRED UP)
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
- Routing brain lives in two places:
  1. **Segmenter** (`segment.js`): `feel` beats now also get a `"source":"stock"|"gif"` field.
     `"stock"` is for atmospheric/scene-setting/conceptual beats (mood, place, action — no
     specific person or joke); `query` becomes a 2-5 word descriptive scene phrase instead of
     the 1-2 word Giphy tag term. `"gif"` keeps the existing reaction-punch behavior unchanged.
     `reference` never gets a `source`/`query` field at all — see "Meme footage" below, its
     identification happens downstream in its own dedicated search step, not in the segmenter.
  2. **Evidence search** (`evidence-search.js`): the `footageType:"generic"` branch (a category
     statement, no one identifiable person/event) short-circuits straight to Pexels instead of
     YouTube — returns `{footageType:"generic", source:"stock", clips}`. `footageType:"specific"`
     goes YouTube → enrich → rerank → plain links (see "Evidence & reference pipelines" above).
     This means the YOUTUBE_API_KEY guard in `evidence-search.js` only applies once footageType
     resolves to specific — a generic-only deploy works with just GROQ+PEXELS keys.
- Frontend (`app.js`): `hydrateClips()` sends `feel`+`source:"stock"` beats to `/api/stock-search`
  instead of `/api/find-clips`; `findFootage()` checks `data.source === "stock"` on the
  evidence-search response and renders straight from `data.clips` (via the shared `clipCardHtml`/
  `openPreview`). `openPreview` branches on `clip.source === "pexels"` to show `#modal-video` (a
  real `<video>` playing `previewUrl`) instead of the gif `#modal-thumb`/`#modal-iframe` treatment,
  and the download button points at `/api/stock-download?url=<downloadUrl>&name=<id>`. Stock clip
  ids are prefixed `pexels-<id>` so they never collide with Giphy ids in cross-segment dedup.
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
- `find-clips.js`/`GIPHY_API_KEY` are NOT removed — `feel` beats with `source:"gif"` still depend
  on them.

## What's NOT built yet
- Twitter/Instagram post lookup for `subject_post`-style evidence (oEmbed-based, no OCR — was the plan, not started)
- Voiceover transcription (Whisper or similar) — the "Voiceover" choice card on `new-project.html` is UI-only, not functional
- File upload for pasted-script (.txt/.docx/.pdf) — also UI-only
- Any persistence beyond localStorage (projects are lost on clearing browser storage; no server-side/cross-device store)

## Known constraints from the person building this
- Cost-conscious but no longer strictly $0 (heading toward a sellable product): free tiers where possible (Cloudflare Pages, Groq, Giphy, YouTube API, Pexels). No paid pieces at all as of 2026-07-17 — the one that was (the Render worker) is gone. Ask before introducing anything meaningfully paid.
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
