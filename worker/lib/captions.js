// Pull a timestamped transcript for a YouTube video with yt-dlp's auto-subs, and fuzzy-match
// a quote against it to find the exact moment it's spoken.
//
// We ask for auto-subs first (almost every video has them) and fall back to any uploaded
// manual English subs. Format json3 gives us per-caption-event timing without downloading a
// single byte of video.
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const YTDLP = process.env.YTDLP_PATH || "yt-dlp";

function run(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP, args, { timeout: 60_000, maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

// Returns [{ start, end, text }] in seconds, or [] when the video has no usable captions.
async function fetchTranscript(videoId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-"));
  try {
    await run([
      "--skip-download",
      "--write-auto-subs",
      "--write-subs",
      "--sub-langs", "en.*,en",
      "--sub-format", "json3",
      "--no-playlist",
      "-o", path.join(dir, "%(id)s.%(ext)s"),
      `https://www.youtube.com/watch?v=${videoId}`,
    ]);

    const file = fs.readdirSync(dir).find((f) => f.endsWith(".json3"));
    if (!file) return [];
    const raw = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    return (raw.events || [])
      .filter((e) => Array.isArray(e.segs) && e.tStartMs != null)
      .map((e) => ({
        start: e.tStartMs / 1000,
        end: (e.tStartMs + (e.dDurationMs || 0)) / 1000,
        text: e.segs.map((s) => s.utf8 || "").join("").trim(),
      }))
      .filter((e) => e.text);
  } catch {
    return []; // captions disabled / unavailable → caller treats as unverifiable
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// Flatten transcript events into a token stream, each token tagged with its event's timing,
// then slide a quote-sized window across it and score by multiset token overlap. Order isn't
// enforced strictly (captions drift), but window size ≈ quote length keeps it honest enough.
// Returns { matched, start, end, snippet, score }.
function matchQuote(transcript, quote) {
  const q = normalize(quote);
  if (!q.length || !transcript.length) {
    return { matched: false, start: 0, end: 0, snippet: "", score: 0 };
  }

  const tokens = [];
  for (const ev of transcript) {
    for (const w of normalize(ev.text)) tokens.push({ w, start: ev.start, end: ev.end });
  }
  if (!tokens.length) return { matched: false, start: 0, end: 0, snippet: "", score: 0 };

  const qCounts = counts(q);
  let best = { score: 0, i: 0, len: q.length };

  // Try a few window sizes around the quote length to tolerate caption word-count drift.
  for (const len of windowSizes(q.length)) {
    for (let i = 0; i + len <= tokens.length; i++) {
      const window = tokens.slice(i, i + len).map((t) => t.w);
      const score = overlap(qCounts, counts(window), q.length);
      if (score > best.score) best = { score, i, len };
    }
  }

  const win = tokens.slice(best.i, best.i + best.len);
  const start = win.length ? win[0].start : 0;
  const end = win.length ? win[win.length - 1].end : 0;
  return {
    matched: best.score >= 0.6,
    start,
    end,
    snippet: win.map((t) => t.w).join(" "),
    score: Number(best.score.toFixed(3)),
  };
}

function windowSizes(n) {
  const sizes = new Set([n]);
  if (n > 2) sizes.add(n - 1);
  sizes.add(n + 1);
  sizes.add(n + 2);
  return [...sizes].filter((s) => s > 0);
}

function counts(arr) {
  const m = new Map();
  for (const w of arr) m.set(w, (m.get(w) || 0) + 1);
  return m;
}

// Multiset intersection size / quote length → fraction of the quote's words present.
function overlap(qCounts, wCounts, qLen) {
  let inter = 0;
  for (const [w, c] of qCounts) inter += Math.min(c, wCounts.get(w) || 0);
  return inter / qLen;
}

module.exports = { fetchTranscript, matchQuote };
