# ClipHunt worker

The heavy-work backend for ClipHunt's `evidence` pipeline. It's the only piece that runs
`yt-dlp` + `ffmpeg`, which is why it lives outside Netlify (those binaries + minutes-long
downloads don't fit a serverless function's size/timeout limits).

## Endpoints

- `POST /match` — body `{ videoIds[], quote, exp, sig }`. Verifies the HMAC signature minted by
  the Netlify `evidence-search` function, fetches auto-captions for up to 3 candidates, fuzzy-
  matches the quote to a timestamp, and returns `{ results: [{ videoId, matched, start, end,
  snippet, score, fullUrl, excerptUrl?, excerptSec? }] }`. `excerptUrl`/`excerptSec` are present
  only when a confident match was found.
- `GET /clip?videoId&start&end&mode&exp&sig` — verifies the signature the worker itself minted in
  `/match`, then downloads (`mode=excerpt` trims `[start,end]`; `mode=full` grabs the whole video)
  and streams the mp4 back as an attachment. Guardrails: excerpt ≤ 60s, full ≤ 20min / 500MB.
- `GET /health` — liveness check for the host.

## Auth model

There is no bearer token in the browser. The shared secret `WORKER_TOKEN` lives only here and in
Netlify. Netlify signs the first `/match` call; this worker signs the `/clip` download URLs it
returns. Downloads are therefore plain `<a download>` navigations to a pre-signed URL — no header
to set, nothing buffered in browser memory, secret never exposed. The signing logic in
`lib/sign.js#signMatch` must stay byte-for-byte identical to `evidence-search.js`.

## Env vars

| var              | required | purpose                                                        |
|------------------|----------|----------------------------------------------------------------|
| `WORKER_TOKEN`   | yes      | HMAC secret; must equal the same var on Netlify.               |
| `ALLOWED_ORIGIN` | yes      | CORS origin for `/match` (the Netlify site URL).               |
| `PUBLIC_URL`     | no       | Base URL used to build signed `/clip` links. Falls back to `RENDER_EXTERNAL_URL`, then the request host. |
| `PORT`           | no       | Defaults to 8080 (Render sets this automatically).             |
| `YTDLP_PATH`     | no       | Override the yt-dlp binary path (defaults to `yt-dlp` on PATH).|

## Deploy to Render

1. New → Web Service → Docker, pointed at this `worker/` directory.
2. Set `WORKER_TOKEN` (same value as Netlify) and `ALLOWED_ORIGIN` (your Netlify site origin).
3. Deploy. Copy the service URL into Netlify's `WORKER_URL` env var.

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
