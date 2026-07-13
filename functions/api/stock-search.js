// Cloudflare Pages Function — POST /api/stock-search
// Pexels video search for the "stock" clip source (atmospheric/conceptual feel beats + generic
// evidence beats). Free, commercially-licensed, direct-CDN MP4s — no worker, no yt-dlp, no cost.
export async function onRequestPost(context) {
  const { request, env } = context;

  let query, orientation;
  try {
    ({ query, orientation } = await request.json());
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!query || !query.trim()) {
    return Response.json({ error: "No query provided" }, { status: 400 });
  }
  if (!env.PEXELS_API_KEY) {
    return Response.json({ error: "PEXELS_API_KEY is not set on this Cloudflare project" }, { status: 500 });
  }

  orientation = orientation === "portrait" || orientation === "square" ? orientation : "landscape";

  try {
    const url =
      "https://api.pexels.com/videos/search" +
      `?query=${encodeURIComponent(query)}&per_page=8&orientation=${orientation}`;
    const res = await fetch(url, { headers: { Authorization: env.PEXELS_API_KEY } });

    if (!res.ok) {
      const errText = await res.text();
      return Response.json({ error: `Pexels error: ${errText}` }, { status: 502 });
    }

    const data = await res.json();
    const clips = (data.videos || [])
      .map((v) => mapPexelsVideo(v))
      .filter((c) => c && c.downloadUrl);

    return Response.json({ clips });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// Shared with evidence-search.js's generic-footage branch — keep this mapping in sync there.
export function mapPexelsVideo(v) {
  const files = (v.video_files || []).filter((f) => f.file_type === "video/mp4");
  if (!files.length) return null;

  const hdCandidates = files.filter((f) => (f.height || 0) <= 1080).sort((a, b) => (b.height || 0) - (a.height || 0));
  const best = hdCandidates.find((f) => f.quality === "hd") || hdCandidates[0] || files[0];

  const sdCandidates = files.filter((f) => f.quality === "sd").sort((a, b) => (b.height || 0) - (a.height || 0));
  const preview = sdCandidates[0] || best;

  return {
    id: `pexels-${v.id}`,
    title: v.user?.name ? `Stock footage by ${v.user.name}` : "Stock footage",
    thumbUrl: v.image,
    duration: v.duration || null,
    author: v.user?.name || null,
    source: "pexels",
    downloadUrl: best.link,
    previewUrl: preview.link || best.link,
  };
}
