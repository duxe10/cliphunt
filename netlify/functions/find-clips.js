// Dumb-for-now clip search: just hands the segment text straight to Giphy.
// No idiomatic-phrasing / named-template query tiers yet — that's a refinement
// pass once basic real search is proven end to end, same as segmentation was.
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let text;
  try {
    ({ text } = JSON.parse(event.body || "{}"));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  if (!text || !text.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: "No text provided" }) };
  }

  if (!process.env.GIPHY_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "GIPHY_API_KEY is not set on this Netlify site" }) };
  }

  const query = text.length > 60 ? text.slice(0, 60) : text;

  try {
    const url = `https://api.giphy.com/v1/gifs/search?api_key=${process.env.GIPHY_API_KEY}&q=${encodeURIComponent(query)}&limit=8&rating=pg-13`;
    const res = await fetch(url);

    if (!res.ok) {
      const errText = await res.text();
      return { statusCode: 502, body: JSON.stringify({ error: `Giphy error: ${errText}` }) };
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

    // Soft recency re-rank (not a hard filter): Giphy has no date sort, and its top
    // results skew to 2013-2016 evergreen reaction gifs. Many are still fine, so instead
    // of dropping old ones we just float the ones that have been active in the 2020s
    // (uploaded or last-trended >= 2020) to the top, keeping Giphy's relevance order
    // within each group. Stable sort preserves that order (Node's sort is stable).
    const activeIn2020s = (c) => year(c.trendingDatetime) >= 2020 || year(c.importDatetime) >= 2020;
    clips.sort((a, b) => (activeIn2020s(a) === activeIn2020s(b) ? 0 : activeIn2020s(a) ? -1 : 1));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clips }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// Pulls the 4-digit year out of a Giphy datetime like "2020-11-05 10:30:13".
// Returns 0 for null/empty and for Giphy's placeholder dates ("0000-00-00",
// "1970-01-01"), so those never count as "active in the 2020s".
function year(dt) {
  const y = parseInt((dt || "").slice(0, 4), 10);
  return Number.isNaN(y) ? 0 : y;
}
