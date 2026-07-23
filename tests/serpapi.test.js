import test from "node:test";
import assert from "node:assert/strict";
import { searchGoogleImages } from "../functions/api/_serpapi.js";

function mockImagesResult(images_results) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ images_results }), { status: 200 });
  return () => { globalThis.fetch = originalFetch; };
}

// Regression: confirmed live — Google's own image_type=photo filter is not reliable. A TikTok
// video's frame gets indexed by Google Images as an "image" result same as a real photo, with
// nothing in SerpAPI's response distinguishing the two — being in images_results at all doesn't
// mean it's actually a standalone photograph. TikTok is exclusively short-form video, so any
// result from it here can never be a real photo.
test("searchGoogleImages drops TikTok results even though they came back as 'images'", async () => {
  const restore = mockImagesResult([
    { thumbnail: "https://t0", link: "https://www.tiktok.com/@user/video/123", title: "Goal celebration", source: "TikTok" },
    { thumbnail: "https://t1", link: "https://www.bbc.com/sport/article", title: "Real news photo", source: "BBC Sport" },
  ]);
  try {
    const images = await searchGoogleImages({ SERPAPI_KEY: "x" }, "some query");
    assert.deepEqual(images.map((i) => i.domain), ["BBC Sport"]);
  } finally {
    restore();
  }
});

test("searchGoogleImages drops other pure-video platforms the same way", async () => {
  const restore = mockImagesResult([
    { thumbnail: "https://t0", link: "https://www.youtube.com/watch?v=abc", title: "A goal", source: "YouTube" },
    { thumbnail: "https://t1", link: "https://vimeo.com/12345", title: "A clip", source: "Vimeo" },
    { thumbnail: "https://t2", link: "https://apnews.com/article", title: "Real wire photo", source: "AP News" },
  ]);
  try {
    const images = await searchGoogleImages({ SERPAPI_KEY: "x" }, "some query");
    assert.deepEqual(images.map((i) => i.domain), ["AP News"]);
  } finally {
    restore();
  }
});

// Instagram/Facebook are deliberately NOT blocked — they host genuine photo posts too, and a
// domain alone can't reliably tell a real photo from a Reel/video thumbnail there the way it can
// for an exclusively-video platform like TikTok.
test("searchGoogleImages does not block Instagram/Facebook, unlike the pure-video platforms", async () => {
  const restore = mockImagesResult([
    { thumbnail: "https://t0", link: "https://www.instagram.com/p/abc", title: "A photo post", source: "Instagram" },
    { thumbnail: "https://t1", link: "https://www.facebook.com/photo/abc", title: "A photo post", source: "Facebook" },
  ]);
  try {
    const images = await searchGoogleImages({ SERPAPI_KEY: "x" }, "some query");
    assert.deepEqual(images.map((i) => i.domain), ["Instagram", "Facebook"]);
  } finally {
    restore();
  }
});
