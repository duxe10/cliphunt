// ClipHunt worker — the only piece that touches yt-dlp/ffmpeg. Two jobs:
//   POST /match : fetch captions for candidate videos, fuzzy-match the quote → timestamps,
//                 and hand back pre-signed download URLs for each candidate.
//   GET  /clip  : verify a signed URL, download+trim, stream the mp4 as an attachment.
// Auth is HMAC signed URLs (shared WORKER_TOKEN, never in the browser). See lib/sign.js.
const express = require("express");
const fs = require("fs");
const { signMatch, signClip, safeEqual, notExpired } = require("./lib/sign");
const { fetchTranscript, matchQuote } = require("./lib/captions");
const { probeDuration, makeClip } = require("./lib/clip");

const TOKEN = process.env.WORKER_TOKEN;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const MAX_MATCH = 5; // caption-match all candidates evidence-search returns (it sends 5)
const MAX_EXCERPT_SEC = 60;
const MAX_FULL_SEC = 20 * 60;
const MAX_FULL_FILESIZE = "500M";

if (!TOKEN) {
  console.error("WORKER_TOKEN is not set — refusing to start.");
  process.exit(1);
}

// YouTube blocks datacenter IPs (Render's) with "confirm you're not a bot", which fails caption
// fetches and downloads. If a base64 cookies.txt blob is provided, materialize it once and point
// yt-dlp at it (lib/captions.js + lib/clip.js pick up YTDLP_COOKIES_FILE). Optional — the worker
// still runs without it, just more prone to bot blocks.
if (process.env.YTDLP_COOKIES_B64) {
  try {
    fs.writeFileSync("/tmp/yt-cookies.txt", Buffer.from(process.env.YTDLP_COOKIES_B64, "base64"));
    process.env.YTDLP_COOKIES_FILE = "/tmp/yt-cookies.txt";
    console.log("yt-dlp cookies loaded from YTDLP_COOKIES_B64");
  } catch (e) {
    console.error("Failed to load YTDLP_COOKIES_B64:", e.message);
  }
}

const app = express();
app.use(express.json({ limit: "256kb" }));

app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// Build the absolute base URL of this worker for embedding in signed download links.
function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

// Sign one /clip URL for a candidate. start/end are signed as the exact strings placed in the
// query so the round-trip can't invalidate the signature.
function clipUrl(base, { videoId, start, end, mode }, exp) {
  const s = String(start);
  const e = String(end);
  const sig = signClip({ videoId, start: s, end: e, mode, exp }, TOKEN);
  const qs = new URLSearchParams({ videoId, start: s, end: e, mode, exp: String(exp), sig });
  return `${base}/clip?${qs.toString()}`;
}

app.post("/match", async (req, res) => {
  const { videoIds, quote, exp, sig } = req.body || {};
  if (!Array.isArray(videoIds) || !videoIds.length) {
    return res.status(400).json({ error: "videoIds required" });
  }
  if (!notExpired(exp)) return res.status(401).json({ error: "Request expired" });
  const expected = signMatch(videoIds, quote || null, exp, TOKEN);
  if (!sig || !safeEqual(sig, expected)) {
    return res.status(401).json({ error: "Bad signature" });
  }

  const base = baseUrl(req);
  const clipExp = Math.floor(Date.now() / 1000) + 3600; // download links valid 1h
  const targets = videoIds.slice(0, MAX_MATCH);

  const results = await Promise.all(
    targets.map(async (videoId) => {
      let m = { matched: false, start: 0, end: 0, snippet: "", score: 0 };
      // Why there's no trimmed excerpt — so the UI can be honest instead of a blanket
      // "couldn't verify": no_quote (generic/narration beat), no_captions (video has none),
      // low_score (had a quote but couldn't find the line), matched (found it).
      let reason = "no_quote";
      if (quote) {
        try {
          const transcript = await fetchTranscript(videoId);
          if (!transcript.length) {
            reason = "no_captions";
          } else {
            m = matchQuote(transcript, quote);
            reason = m.matched ? "matched" : "low_score";
          }
        } catch {
          reason = "no_captions";
        }
      }

      const links = { fullUrl: clipUrl(base, { videoId, start: 0, end: 0, mode: "full" }, clipExp) };
      if (m.matched) {
        const start = Math.max(0, m.start - 0.5).toFixed(2);
        const end = (m.end + 0.5).toFixed(2);
        links.excerptUrl = clipUrl(base, { videoId, start, end, mode: "excerpt" }, clipExp);
        links.excerptSec = Math.round(Number(end) - Number(start));
      }
      return { videoId, ...m, reason, ...links };
    })
  );

  // Best matches first; unmatched candidates still returned (user can grab the full video).
  results.sort((a, b) => b.score - a.score);
  res.json({ results });
});

app.get("/clip", async (req, res) => {
  const { videoId, start, end, mode, exp, sig } = req.query;
  if (!videoId || !mode) return res.status(400).send("Missing parameters");
  if (!notExpired(exp)) return res.status(401).send("Link expired");
  const expected = signClip(
    { videoId, start: String(start), end: String(end), mode: String(mode), exp: String(exp) },
    TOKEN
  );
  if (!sig || !safeEqual(sig, expected)) return res.status(401).send("Bad signature");

  try {
    let clip;
    if (mode === "excerpt") {
      const len = Number(end) - Number(start);
      if (!(len > 0) || len > MAX_EXCERPT_SEC) return res.status(400).send("Excerpt too long");
      clip = await makeClip({ videoId, start, end, mode: "excerpt" });
    } else if (mode === "full") {
      const dur = await probeDuration(videoId);
      if (dur > MAX_FULL_SEC) return res.status(400).send("Video too long to download in full");
      clip = await makeClip({ videoId, mode: "full", maxFilesize: MAX_FULL_FILESIZE });
    } else {
      return res.status(400).send("Unknown mode");
    }

    const filename = mode === "excerpt" ? `${videoId}_${start}-${end}.mp4` : `${videoId}.mp4`;
    res.set("Content-Type", "video/mp4");
    res.set("Content-Disposition", `attachment; filename="${filename}"`);

    const stream = fs.createReadStream(clip.file);
    stream.pipe(res);
    const cleanup = () => fs.rmSync(clip.dir, { recursive: true, force: true });
    stream.on("close", cleanup);
    stream.on("error", () => {
      cleanup();
      if (!res.headersSent) res.status(500).end();
    });
  } catch (err) {
    res.status(502).send(`Clip failed: ${err.message}`);
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`cliphunt-worker listening on ${PORT}`));
