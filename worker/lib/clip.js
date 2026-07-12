// Download + trim a YouTube clip to a temp mp4 and hand back its path. Two modes:
//   excerpt → partial download of just [start,end] via --download-sections (fast, small)
//   full    → the whole source video
// Callers must enforce length/size clamps BEFORE calling (see server.js) — this module trusts
// its inputs so the guardrails live in one place.
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
// 720p ceiling keeps files reasonable while staying "high resolution" vs the old gifs.
// Prefer h264/aac mp4 streams so the full-video path can remux straight to a widely-playable
// mp4 with no re-encode; fall back to any 720p, then anything.
const FORMAT =
  "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/bv*[height<=720]+ba/b[height<=720]/b";

function run(args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

// Returns the video's duration in seconds (used to clamp full-video downloads).
async function probeDuration(videoId) {
  const out = await run(
    ["--skip-download", "--no-playlist", "--print", "duration", `https://www.youtube.com/watch?v=${videoId}`],
    60_000
  );
  return parseFloat(String(out).trim()) || 0;
}

// Downloads to a fresh temp dir and returns { file, dir }. Caller deletes dir when done.
async function makeClip({ videoId, start, end, mode, maxFilesize }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clip-"));
  const out = path.join(dir, "%(id)s.%(ext)s");
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const args = ["-f", FORMAT, "--no-playlist", "-o", out];
  if (maxFilesize) args.push("--max-filesize", maxFilesize);
  if (mode === "excerpt") {
    // Trimming needs a real re-encode so the cut starts/ends on a clean frame and lands in mp4.
    // The excerpt is short, so this is cheap even on a small instance.
    args.push(
      "--download-sections", `*${start}-${end}`,
      "--force-keyframes-at-cuts",
      "--recode-video", "mp4"
    );
  } else {
    // Full video: remux only (no re-encode) so a long download doesn't pin the CPU for minutes
    // and blow the timeout on a small host. Fast, IO-bound.
    args.push("--merge-output-format", "mp4");
  }
  args.push(url);

  await run(args, 10 * 60_000);

  const file = fs.readdirSync(dir).find((f) => f.endsWith(".mp4"));
  if (!file) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error("Download produced no mp4 (video may be unavailable or too large)");
  }
  return { file: path.join(dir, file), dir };
}

module.exports = { probeDuration, makeClip };
