// HMAC signing shared by both worker endpoints. The MATCH signature must reproduce, byte
// for byte, what netlify/functions/evidence-search.js produces — keep the two in sync.
const crypto = require("crypto");

function hmac(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

// Constant-time hex compare; false on any length/format mismatch instead of throwing.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Mirrors evidence-search.js signMatch: sorted videoIds, quote ("" when null), expiry.
function signMatch(videoIds, quote, exp, secret) {
  const payload = `${[...videoIds].sort().join(",")}|${quote || ""}|${exp}`;
  return hmac(payload, secret);
}

// Clip params are signed and verified as their exact string forms so query round-tripping
// (numbers → strings → numbers) can never change the signature.
function signClip({ videoId, start, end, mode, exp }, secret) {
  const payload = `${videoId}|${start}|${end}|${mode}|${exp}`;
  return hmac(payload, secret);
}

function notExpired(exp) {
  const n = Number(exp);
  return Number.isFinite(n) && n > Math.floor(Date.now() / 1000);
}

module.exports = { signMatch, signClip, safeEqual, notExpired };
