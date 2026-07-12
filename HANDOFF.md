# ClipHunt — handoff notes

## What this is
A tool for video creators: paste/upload a script (or a voiceover to transcribe), it gets
broken into distinct moments, and each moment gets matched with candidate reaction
clips/gifs/memes to cut to. Live on **Cloudflare Pages** at https://cliphunt.pages.dev
(public GitHub repo github.com/duxe10/cliphunt; deploy with `npx wrangler pages deploy .`).
Migrated off Netlify after hitting its free-tier deploy-credit wall — the old `netlify/` dir is gone.

## Stack, deliberately
- Plain HTML/CSS/JS frontend (`index.html`, `new-project.html`, `workspace.html`, `style.css`, `app.js`) — no framework, no build step.
- Data model: real multi-project history in localStorage under one key, `cliphunt_projects` (array of `{id, title, segments, createdAt, updatedAt}`). No mock/demo data — the old hardcoded "harry" demo project and `MOCK_SEGMENTS` were removed. `app.js` is loaded on all three pages and dispatches by which root element is present (`#project-grid` → dashboard list, `#segments` → workspace). new-project.html appends a project and routes to `workspace.html?id=<id>`; the dashboard lists projects newest-first; workspace loads by `?id=` and its Delete button removes the project. Only raw `segments` are persisted — clips are hydrated live from Giphy on each workspace load (kept fresh, not stored). A one-time `migrateLegacy()` upgrades the pre-history single-project keys (`cliphunt_title`/`cliphunt_segments`).
- Cloudflare Pages Functions for anything needing a secret API key, under `functions/api/` (routed as `/api/*`): `functions/api/segment.js` (Groq), `functions/api/find-clips.js` (Giphy — feel/reference), `functions/api/evidence-search.js` (Groq intent + YouTube Data API + LLM rerank — evidence), `functions/api/config.js` (echoes the non-secret, trimmed `WORKER_URL`). These are ESM (`onRequestPost`/`onRequestGet`, `context.env` for secrets), ported from the old Netlify handlers — prompts + logic byte-identical.
- Mostly-free constraint — Groq (llama-3.3-70b), Giphy, and YouTube Data API all have free tiers; keys live only in **Cloudflare Pages secrets** (`GROQ_API_KEY`, `GIPHY_API_KEY`, `YOUTUBE_API_KEY`, plus `WORKER_URL`/`WORKER_TOKEN`), never in code. NOTE: Pages binds secrets at deploy time — after changing a secret you must **redeploy** for functions to see it. The one non-Cloudflare piece is the evidence worker (Render free tier).

## Evidence pipeline (real footage — NOW WIRED)
The `evidence` family is built: quote → YouTube search → caption match → exact timestamp →
trimmed **downloadable** mp4. Because downloading+trimming video needs `yt-dlp`+`ffmpeg` (can't
run in a short-lived edge function), the heavy work lives in a separate worker service (`worker/`,
Node+Express, Docker, deployed to Render). The smart/cheap steps run as Cloudflare Pages Functions.
- `functions/api/evidence-search.js`: Groq extracts `{footageType,subject,quote,youtubeQuery}`
  grounded in the beat's OWN sentence (a general line must NOT inherit the video's protagonist;
  `footageType:generic` yields person-free b-roll queries). Runs YouTube `search.list` (fetches 10),
  enriches via `videos.list` (duration/views), then an LLM **rerank** scores each candidate 0-100
  against the beat (demoting reactions/watchalongs/compilations) and keeps the best 5. Returns
  candidates + a short-lived HMAC `matchSig`/`exp` authorizing the worker's `/match`.
- `worker/` `POST /match`: `yt-dlp` auto-subs (json3) → fuzzy-match the quote (sliding-window
  token overlap, `lib/captions.js`) → per-candidate `{matched,start,end,snippet,score}` + signed
  `excerptUrl`/`fullUrl`. `GET /clip`: `yt-dlp --download-sections` + ffmpeg → streams the mp4.
- **Auth is HMAC signed URLs, not a bearer token** — `WORKER_TOKEN` never reaches the browser.
  A `<a download>` navigation can't send an Authorization header, so downloads go straight to a
  pre-signed worker URL (streamed, nothing buffered in browser memory). `signMatch` in
  `worker/lib/sign.js` (Node `crypto.createHmac`) must stay byte-for-byte identical to the one in
  `functions/api/evidence-search.js` (WebCrypto `crypto.subtle` — verified byte-identical hex).
- Frontend: evidence beats get a **Find footage** button (user-triggered — real footage costs a
  YouTube search + caption fetch, so it does NOT auto-hydrate like feel/reference). Candidates
  render as cards; preview plays only the matched excerpt via a YouTube embed (`?start=&end=`);
  download shows the trimmed clip + full video (full-only when no confident match). Evidence
  results are cached in memory on the segment, not persisted. See `worker/README.md` for deploy.

## The 4-category taxonomy (this is the core design decision)
Every segment gets classified into one of:
- **feel** — pure emotion beat, no specific referent → searched on Giphy
- **evidence** — a specific real person/thing said or did the exact thing referenced → real footage from YouTube, trimmed & downloadable (WIRED UP — see Evidence pipeline above)
- **reference** — matches a known meme/cultural callback → searched on Giphy
- **nothing** — pacing beat/transition → no clip forced, and that's deliberate (a forced bad clip is worse than no clip)

This collapsed from a more elaborate original taxonomy (subject_quote/subject_post/meme_callback/etc.) for MVP simplicity — see git history / ask if the fuller version matters later.

## Segmentation (`functions/api/segment.js`)
Hardest part was getting segment *boundaries* right, not the classification. Lessons learned the hard way:
1. Default to splitting on every complete sentence — merging by "topic relation" over-merges (e.g. "For most footballers... / For Harry Kane..." should NOT merge, it's a deliberate contrast pivot).
2. The ONLY real merge signal is grammatical incompleteness — a segment starting with `...` or `—`, or the previous segment ending in a dangling `—`. This is NOT reliably followed by the model (llama-3.3-70b is small/fast, and this rule fights the "split by default" rule) — so it's enforced deterministically in code (`mergeFragments()` at the bottom of `segment.js`), not left to the prompt. Don't try to fix this by wording the prompt harder — it oscillates between over-merge and under-merge across runs. Code-level regex is the actual fix.
3. Words like "but"/"and"/"so" at the start of a sentence are NOT a fragment signal — very common as deliberate stylistic sentence-openers. Only `...`/`—` are unambiguous.

## Clip search (`functions/api/find-clips.js`)
- `feel` and `reference` families are searched on Giphy (keyword search) — auto-hydrated on load.
- `evidence` is now built on its own pipeline (YouTube → captions → fuzzy-match → trim/download);
  see the "Evidence pipeline" section above. It's user-triggered, not auto-hydrated.
- The model generates a `query` field per feel/reference segment now, instead of dumping raw sentence text at Giphy (raw text produced generic/repeated results). IMPORTANT lesson from testing against the live Giphy index: the query must be a SHORT 1-2 word COMMON reaction term (`hope`, `nervous`, `heartbreak`), NOT a clever specific phrase. Giphy search is tag-based — a specific phrase like "nation holds breath" matches almost nothing and Giphy returns an identical generic-junk fallback set for every unmatched phrase. An earlier version of this prompt pushed toward specificity ("finally believing again" over "hope") and it made results strictly worse — don't reintroduce that.
- Ambiguous-word guard (also in the prompt): some plain reaction words have a DOMINANT unrelated meaning on Giphy and pull off-topic content. The known one is "proud" → Giphy returns Pride-month content, so an "incredible achievement" beat that queried "proud" surfaced LGBTQ/Pride gifs. Prompt now tells the model to avoid such words and use unambiguous ones ("impressed"/"amazed"/"standing ovation" for success). If new off-topic drift shows up, it's usually another loaded single word — add it to that guidance.
- Recency: Giphy search has NO date filter and NO recency sort (confirmed against their API docs). Its top results skew to 2013-2016 evergreen reaction gifs. `find-clips.js` returns `importDatetime`/`trendingDatetime` per clip and does a SOFT re-rank (not a hard filter): stable-sort so gifs "active in the 2020s" (uploaded OR last-trended >= 2020) float above older ones, preserving Giphy's relevance order within each group. Deliberately NOT a hard 2020+ cutoff — that deletes most of the good evergreen gifs and thins pools to nothing. Note many 2013-2016 gifs have `trendingDatetime` in 2020-2025, i.e. old uploads that are still actively used — those correctly count as "fresh".
- Cross-segment dedup (wired through `app.js` `hydrateClips()`): each searchable segment fetches a pool of 8 candidates, then after all fetches resolve a client-side pass greedily assigns non-duplicate results (by gif `id`) in segment order, slices to 4, and falls back to a segment's own pool if everything got filtered out — so the same gif doesn't get reused project-wide. `find-clips.js` fetches `limit=8` to leave room for this. The `query` field is threaded through `buildLiveSegments()` and sent as `seg.query || seg.text`.

## What's NOT built yet
- `feel`→stock (Pexels/Pixabay direct-mp4, no worker needed) and `reference`→YouTube-meme
  migrations onto the evidence skeleton — both still use Giphy for now. Once migrated, remove
  `find-clips.js`, `GIPHY_API_KEY`, and the gif-specific UI.
- Twitter/Instagram post lookup for `subject_post`-style evidence (oEmbed-based, no OCR — was the plan, not started)
- Voiceover transcription (Whisper or similar) — the "Voiceover" choice card on `new-project.html` is UI-only, not functional
- File upload for pasted-script (.txt/.docx/.pdf) — also UI-only
- Any persistence beyond localStorage (projects are lost on clearing browser storage; no server-side/cross-device store)

## Known constraints from the person building this
- Cost-conscious but no longer strictly $0 (heading toward a sellable product): free tiers where possible (Cloudflare Pages, Groq, Giphy, YouTube API) plus the Render worker. Ask before introducing anything meaningfully paid.
- No emoji as icons anywhere — inline SVG only (see existing icon usage in the HTML files for the established style).
- Dark "editing bay" theme (near-black warm background, amber accent, Bricolage Grotesque + IBM Plex Sans/Mono) — this was a deliberate reaction against generic AI-template looks (cream background, emoji icons, purple gradients). Keep it consistent if extending the UI.
- Deploy: `npx wrangler pages deploy . --project-name cliphunt --branch production` from this folder (Cloudflare Pages project `cliphunt`, account `bashirmubarak08@gmail.com`; `npx wrangler login` if the token lacks pages/workers scopes). Repo is on GitHub now (github.com/duxe10/cliphunt, PUBLIC — that also removed Netlify's old "unrecognized contributor" build block). `.assetsignore` keeps `.git`/`worker`/docs out of the Pages upload. Netlify is fully decommissioned.
- Known gotcha from the migration: a GitHub merge once silently reverted a whole fix (evidence relevance) — if behavior regresses after a merge, check the deployed file actually contains the change (`git show <ref>:functions/api/evidence-search.js | grep footageType`), don't trust the commit graph alone.
