// Cloudflare Pages Function — POST /api/find-clips
// Ported from netlify/functions/find-clips.js. Giphy keyword search for feel/reference beats,
// with a soft recency re-rank (Giphy has no date sort). Logic unchanged from the Netlify version.
export async function onRequestPost(context) {
  const { request, env } = context;

  let text;
  try {
    ({ text } = await request.json());
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!text || !text.trim()) {
    return Response.json({ error: "No text provided" }, { status: 400 });
  }
  if (!env.GIPHY_API_KEY) {
    return Response.json({ error: "GIPHY_API_KEY is not set on this Cloudflare project" }, { status: 500 });
  }

  const query = text.length > 60 ? text.slice(0, 60) : text;

  try {
    const url = `https://api.giphy.com/v1/gifs/search?api_key=${env.GIPHY_API_KEY}&q=${encodeURIComponent(query)}&limit=8&rating=pg-13`;
    const res = await fetch(url);

    if (!res.ok) {
      const errText = await res.text();
      return Response.json({ error: `Giphy error: ${errText}` }, { status: 502 });
    }

    const data = await res.json();
    const clips = (data.data || []).map((g) => ({
      id: g.id,
      title: g.title || query,
      url: g.images.original.url,
      thumbUrl: g.images.fixed_height_small.url,
      source: "giphy",
      importDatetime: g.import_datetime || null,
      trendingDatetime: g.trending_datetime || null,
    }));

    // Soft recency re-rank: float gifs active in the 2020s to the top, keep the rest as fallback.
    const activeIn2020s = (c) => year(c.trendingDatetime) >= 2020 || year(c.importDatetime) >= 2020;
    clips.sort((a, b) => (activeIn2020s(a) === activeIn2020s(b) ? 0 : activeIn2020s(a) ? -1 : 1));

    return Response.json({ clips });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// Pulls the 4-digit year out of a Giphy datetime; 0 for null/empty/placeholder dates.
function year(dt) {
  const y = parseInt((dt || "").slice(0, 4), 10);
  return Number.isNaN(y) ? 0 : y;
}
