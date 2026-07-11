# ClipHunt — handoff notes

## What this is
A tool for video creators: paste/upload a script (or a voiceover to transcribe), it gets
broken into distinct moments, and each moment gets matched with candidate reaction
clips/gifs/memes to cut to. Live at the Netlify site tied to this folder (deployed via
`netlify deploy --prod` from this directory).

## Stack, deliberately
- Plain HTML/CSS/JS frontend (`index.html`, `new-project.html`, `workspace.html`, `style.css`, `app.js`) — no framework, no build step.
- Data model: real multi-project history in localStorage under one key, `cliphunt_projects` (array of `{id, title, segments, createdAt, updatedAt}`). No mock/demo data — the old hardcoded "harry" demo project and `MOCK_SEGMENTS` were removed. `app.js` is loaded on all three pages and dispatches by which root element is present (`#project-grid` → dashboard list, `#segments` → workspace). new-project.html appends a project and routes to `workspace.html?id=<id>`; the dashboard lists projects newest-first; workspace loads by `?id=` and its Delete button removes the project. Only raw `segments` are persisted — clips are hydrated live from Giphy on each workspace load (kept fresh, not stored). A one-time `migrateLegacy()` upgrades the pre-history single-project keys (`cliphunt_title`/`cliphunt_segments`).
- Netlify Functions for anything needing a secret API key: `netlify/functions/segment.js` (Groq) and `netlify/functions/find-clips.js` (Giphy).
- $0-cost constraint is intentional — Groq (llama-3.3-70b) and Giphy both have free tiers, both keys live only in Netlify's env vars (`GROQ_API_KEY`, `GIPHY_API_KEY`), never in code.

## The 4-category taxonomy (this is the core design decision)
Every segment gets classified into one of:
- **feel** — pure emotion beat, no specific referent → searched on Giphy
- **evidence** — a specific real person/thing said or did the exact thing referenced → needs real footage (YouTube), **not wired up yet**
- **reference** — matches a known meme/cultural callback → searched on Giphy
- **nothing** — pacing beat/transition → no clip forced, and that's deliberate (a forced bad clip is worse than no clip)

This collapsed from a more elaborate original taxonomy (subject_quote/subject_post/meme_callback/etc.) for MVP simplicity — see git history / ask if the fuller version matters later.

## Segmentation (`netlify/functions/segment.js`)
Hardest part was getting segment *boundaries* right, not the classification. Lessons learned the hard way:
1. Default to splitting on every complete sentence — merging by "topic relation" over-merges (e.g. "For most footballers... / For Harry Kane..." should NOT merge, it's a deliberate contrast pivot).
2. The ONLY real merge signal is grammatical incompleteness — a segment starting with `...` or `—`, or the previous segment ending in a dangling `—`. This is NOT reliably followed by the model (llama-3.3-70b is small/fast, and this rule fights the "split by default" rule) — so it's enforced deterministically in code (`mergeFragments()` at the bottom of `segment.js`), not left to the prompt. Don't try to fix this by wording the prompt harder — it oscillates between over-merge and under-merge across runs. Code-level regex is the actual fix.
3. Words like "but"/"and"/"so" at the start of a sentence are NOT a fragment signal — very common as deliberate stylistic sentence-openers. Only `...`/`—` are unambiguous.

## Clip search (`netlify/functions/find-clips.js`)
- Only `feel` and `reference` families get searched right now (Giphy, keyword search).
- `evidence` needs a fundamentally different pipeline: search YouTube → pull captions (no download) → fuzzy-match the claimed quote against the transcript → locate timestamp → only then is it safe to extract. Not started.
- The model generates a `query` field per feel/reference segment now, instead of dumping raw sentence text at Giphy (raw text produced generic/repeated results). IMPORTANT lesson from testing against the live Giphy index: the query must be a SHORT 1-2 word COMMON reaction term (`hope`, `nervous`, `heartbreak`), NOT a clever specific phrase. Giphy search is tag-based — a specific phrase like "nation holds breath" matches almost nothing and Giphy returns an identical generic-junk fallback set for every unmatched phrase. An earlier version of this prompt pushed toward specificity ("finally believing again" over "hope") and it made results strictly worse — don't reintroduce that.
- Ambiguous-word guard (also in the prompt): some plain reaction words have a DOMINANT unrelated meaning on Giphy and pull off-topic content. The known one is "proud" → Giphy returns Pride-month content, so an "incredible achievement" beat that queried "proud" surfaced LGBTQ/Pride gifs. Prompt now tells the model to avoid such words and use unambiguous ones ("impressed"/"amazed"/"standing ovation" for success). If new off-topic drift shows up, it's usually another loaded single word — add it to that guidance.
- Recency: Giphy search has NO date filter and NO recency sort (confirmed against their API docs). Its top results skew to 2013-2016 evergreen reaction gifs. `find-clips.js` returns `importDatetime`/`trendingDatetime` per clip and does a SOFT re-rank (not a hard filter): stable-sort so gifs "active in the 2020s" (uploaded OR last-trended >= 2020) float above older ones, preserving Giphy's relevance order within each group. Deliberately NOT a hard 2020+ cutoff — that deletes most of the good evergreen gifs and thins pools to nothing. Note many 2013-2016 gifs have `trendingDatetime` in 2020-2025, i.e. old uploads that are still actively used — those correctly count as "fresh".
- Cross-segment dedup (wired through `app.js` `hydrateClips()`): each searchable segment fetches a pool of 8 candidates, then after all fetches resolve a client-side pass greedily assigns non-duplicate results (by gif `id`) in segment order, slices to 4, and falls back to a segment's own pool if everything got filtered out — so the same gif doesn't get reused project-wide. `find-clips.js` fetches `limit=8` to leave room for this. The `query` field is threaded through `buildLiveSegments()` and sent as `seg.query || seg.text`.

## What's NOT built yet
- Real evidence/subject-footage search (YouTube + transcript matching)
- Twitter/Instagram post lookup for `subject_post`-style evidence (oEmbed-based, no OCR — was the plan, not started)
- Actual video/gif download-and-trim (currently downloads the full Giphy asset directly since gifs are already the right length; real video clip trimming isn't needed yet since evidence isn't wired)
- Voiceover transcription (Whisper or similar) — the "Voiceover" choice card on `new-project.html` is UI-only, not functional
- File upload for pasted-script (.txt/.docx/.pdf) — also UI-only
- Any persistence beyond localStorage (projects are lost on clearing browser storage; no server-side/cross-device store)

## Known constraints from the person building this
- Zero additional cost — free tiers only (Groq, Giphy). Ask before introducing anything paid.
- No emoji as icons anywhere — inline SVG only (see existing icon usage in the HTML files for the established style).
- Dark "editing bay" theme (near-black warm background, amber accent, Bricolage Grotesque + IBM Plex Sans/Mono) — this was a deliberate reaction against generic AI-template looks (cream background, emoji icons, purple gradients). Keep it consistent if extending the UI.
- Deploys via `netlify deploy --prod` run manually from this folder — not connected to GitHub (a permissions issue blocked that; not resolved, not urgent).
