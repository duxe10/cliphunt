// Cloudflare Pages Function — POST /api/transcribe
// Voiceover audio -> script text, via Workers AI Whisper (large-v3-turbo — takes base64 input,
// faster and more accurate than the base model; runs on the Workers AI free daily allocation, no
// per-call dollar cost). Session-gated by _middleware.js like everything else.
//
// The client sends the raw audio bytes as the request body (Content-Type: the file's own type) —
// no multipart parsing needed. Cap: 20MB, which comfortably covers ~10 minutes of typical
// voiceover audio (the trial budget) in any common format; bigger than that is refused with a
// clear message rather than timing out inside the model.
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.AI) {
    return Response.json({ error: "Transcription is not configured on this deployment" }, { status: 500 });
  }

  const len = Number(request.headers.get("Content-Length")) || 0;
  if (len > MAX_AUDIO_BYTES) {
    return Response.json({ error: "Audio file is too large — keep it under 20MB (about 10 minutes)" }, { status: 413 });
  }

  let buffer;
  try {
    buffer = await request.arrayBuffer();
  } catch {
    return Response.json({ error: "Couldn't read the uploaded audio" }, { status: 400 });
  }
  if (!buffer.byteLength) {
    return Response.json({ error: "No audio received" }, { status: 400 });
  }
  if (buffer.byteLength > MAX_AUDIO_BYTES) {
    return Response.json({ error: "Audio file is too large — keep it under 20MB (about 10 minutes)" }, { status: 413 });
  }

  // Base64 in chunks — String.fromCharCode(...bigArray) blows the call-stack on large files.
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const audioB64 = btoa(binary);

  try {
    const result = await env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio: audioB64 });
    const text = (result && result.text ? String(result.text) : "").trim();
    if (!text) {
      return Response.json({ error: "Couldn't hear any speech in that audio" }, { status: 422 });
    }
    console.log(`[transcribe] bytes=${buffer.byteLength} chars=${text.length}`);
    return Response.json({ text });
  } catch (err) {
    console.log(`[transcribe] failed: ${err.message}`);
    return Response.json({ error: `Transcription failed: ${err.message}` }, { status: 502 });
  }
}
