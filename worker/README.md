# ClipHunt worker

The heavy-work backend for ClipHunt's `evidence` pipeline. It's the only piece that runs
`yt-dlp` + `ffmpeg`, which is why it lives outside Cloudflare Pages (those binaries + minutes-long
downloads don't fit an edge function's size/timeout limits).

## Endpoints

- `POST /match` — body `{ videoIds[], quote, exp, sig }`. Verifies the HMAC signature minted by
  the Cloudflare `evidence-search` function, fetches auto-captions for up to 5 candidates, fuzzy-
  matches the quote to a timestamp, and returns `{ results: [{ videoId, matched, start, end,
  snippet, score, fullUrl, excerptUrl?, excerptSec? }] }`. `excerptUrl`/`excerptSec` are present
  only when a confident match was found.
- `GET /clip?videoId&start&end&mode&exp&sig` — verifies the signature the worker itself minted in
  `/match`, then downloads (`mode=excerpt` trims `[start,end]`; `mode=full` grabs the whole video)
  and streams the mp4 back as an attachment. Guardrails: excerpt ≤ 60s, full ≤ 20min / 500MB.
- `GET /health` — liveness check for the host.

## Auth model

There is no bearer token in the browser. The shared secret `WORKER_TOKEN` lives only here and in
the Cloudflare Pages project. The Cloudflare `evidence-search` function signs the first `/match`
call (WebCrypto), and `/api/sign-clip` signs user-chosen trim ranges; this worker signs the
`/clip` download URLs it returns in `/match`. Downloads are therefore plain `<a download>`
navigations to a pre-signed URL — no header to set, nothing buffered in browser memory, secret
never exposed. The signing logic in `lib/sign.js` (`signMatch`/`signClip`, Node `crypto`) must stay
byte-for-byte identical to the WebCrypto versions in `functions/api/evidence-search.js` and
`functions/api/sign-clip.js`.

## Env vars

| var              | required | purpose                                                        |
|------------------|----------|----------------------------------------------------------------|
| `WORKER_TOKEN`      | yes | HMAC secret; must equal the same var on the Cloudflare site.    |
| `ALLOWED_ORIGIN`    | yes | CORS origin for `/match` (the Cloudflare Pages site URL).       |
| `YTDLP_COOKIES_B64` | no  | base64 of a youtube.com `cookies.txt` — lets yt-dlp past datacenter-IP bot checks (see below). |
| `PUBLIC_URL`        | no  | Base URL used to build signed `/clip` links. Falls back to `RENDER_EXTERNAL_URL`, then the request host. |
| `PORT`              | no  | Defaults to 8080 (Render sets this automatically).             |
| `YTDLP_PATH`        | no  | Override the yt-dlp binary path (defaults to `yt-dlp` on PATH).|

## Getting past YouTube bot detection (`YTDLP_COOKIES_B64`)

YouTube blocks datacenter IPs (like Render's) with "Sign in to confirm you're not a bot", which
makes caption fetches and downloads fail. Supplying authenticated cookies fixes it:

1. In a browser signed into a **throwaway** Google account, export youtube.com cookies with a
   "Get cookies.txt LOCALLY" extension → `cookies.txt`.
2. base64-encode it: `base64 -w0 cookies.txt` (macOS: `base64 -i cookies.txt`).
3. Set the output as the Render env var `YTDLP_COOKIES_B64`, then redeploy.

On boot the worker decodes it to `/tmp/yt-cookies.txt` and passes `--cookies` to every yt-dlp
call. Optional — without it the worker still runs, just more prone to bot blocks. Use a throwaway
account (cookies can be invalidated / the account rate-limited).

## Deploy to Render

1. New → Web Service → Docker, pointed at this `worker/` directory.
2. Set `WORKER_TOKEN` (same value as the Cloudflare site) and `ALLOWED_ORIGIN` (your Cloudflare Pages origin).
3. Deploy. Copy the service URL into the Cloudflare Pages `WORKER_URL` secret.

Free tier spins down after ~15 min idle, so the first `/match` after a lull takes ~30–60s — the
frontend shows a "waking the clip server…" spinner to cover it. Bump `YTDLP_VERSION` in the
Dockerfile when YouTube changes break downloads.

## Local run

```
cd worker
npm install
WORKER_TOKEN=dev-secret ALLOWED_ORIGIN='*' PORT=8080 npm start
```

Requires `yt-dlp` and `ffmpeg` on your PATH.
