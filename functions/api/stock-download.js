// Cloudflare Pages Function — GET /api/stock-download
// A cross-origin `<a download>` to a CDN mp4 just plays it in a tab instead of saving — this
// same-origin proxy streams the upstream body back with Content-Disposition so it actually saves.
export async function onRequestGet(context) {
  const { request } = context;
  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get("url");
  const name = reqUrl.searchParams.get("name") || "clip";

  if (!target) {
    return Response.json({ error: "No url provided" }, { status: 400 });
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return Response.json({ error: "Invalid url" }, { status: 400 });
  }

  // Open-proxy guard: only ever fetch Pexels' own CDN hosts, never an arbitrary attacker-supplied URL.
  const host = parsed.hostname.toLowerCase();
  const allowed = host.endsWith(".pexels.com") || host === "pexels.com" || host.endsWith(".vimeo.com");
  if (!allowed) {
    return Response.json({ error: "URL host not allowed" }, { status: 400 });
  }

  let upstream;
  try {
    upstream = await fetch(parsed.toString());
  } catch (err) {
    return Response.json({ error: `Fetch failed: ${err.message}` }, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return Response.json({ error: `Upstream error: ${upstream.status}` }, { status: 502 });
  }

  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60) || "clip";
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Disposition": `attachment; filename="cliphunt-stock-${safeName}.mp4"`,
    },
  });
}
