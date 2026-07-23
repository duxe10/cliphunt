import test from "node:test";
import assert from "node:assert/strict";
import { searchNewsArticles } from "../functions/api/_serpapi.js";
import { rerankArticleCandidates } from "../functions/api/evidence-search.js";

function mockOrganicResult(organic_results) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ organic_results }), { status: 200 });
  return () => { globalThis.fetch = originalFetch; };
}

function mockGroqOnce(payload) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 });
  return () => { globalThis.fetch = originalFetch; };
}

// mediaType:"article" is a plain Google web search (organic_results), not google_images — same
// domain-blocklist reasoning as photo search: a video platform link showing up in a web search is
// never a real article to cite.
test("searchNewsArticles drops video-platform and stock-agency links, same blocklists as photo search", async () => {
  const restore = mockOrganicResult([
    { title: "A real analysis piece", link: "https://www.theathletic.com/some-article", source: "The Athletic" },
    { title: "A random video", link: "https://www.youtube.com/watch?v=abc", source: "YouTube" },
    { title: "A pin", link: "https://www.pinterest.com/pin/123", source: "Pinterest" },
  ]);
  try {
    const articles = await searchNewsArticles({ SERPAPI_KEY: "x" }, "some query");
    assert.deepEqual(articles.map((a) => a.domain), ["The Athletic"]);
  } finally {
    restore();
  }
});

test("searchNewsArticles maps organic_results into id/title/snippet/domain/pageUrl", async () => {
  const restore = mockOrganicResult([
    { title: "Golden Generation nickname explained", snippet: "How the press dubbed them...", link: "https://example.com/a", source: "Example News" },
  ]);
  try {
    const [article] = await searchNewsArticles({ SERPAPI_KEY: "x" }, "some query");
    assert.equal(article.id, "article-0");
    assert.equal(article.title, "Golden Generation nickname explained");
    assert.equal(article.snippet, "How the press dubbed them...");
    assert.equal(article.domain, "Example News");
    assert.equal(article.pageUrl, "https://example.com/a");
  } finally {
    restore();
  }
});

// Same judgment layer as rerankPhotoCandidates — relevance AND source credibility, same
// missing-candidate-defaults-to-0 contract (see stock-search.js's rerank fix for why).
test("rerankArticleCandidates scores relevance and drops a candidate missing from the model's own ranking", async () => {
  const restore = mockGroqOnce({
    ranking: [{ id: "a", score: 85, reason: "real contemporary coverage" }],
  });
  try {
    const candidates = [
      { id: "a", title: "Real coverage of the nickname", domain: "Real Outlet", snippet: "..." },
      { id: "b", title: "Unrelated result", domain: "some-content-farm.example", snippet: "..." },
    ];
    const reranked = await rerankArticleCandidates({ segmentText: "moment", subject: "Team" }, candidates, { GROQ_API_KEY: "x" });
    assert.equal(reranked, true);
    assert.equal(candidates.find((c) => c.id === "a").score, 85);
    assert.equal(candidates.find((c) => c.id === "b").score, 0);
  } finally {
    restore();
  }
});

test("rerankArticleCandidates returns false when there's no GROQ_API_KEY", async () => {
  const candidates = [{ id: "a", title: "x" }, { id: "b", title: "y" }];
  const reranked = await rerankArticleCandidates({ segmentText: "moment" }, candidates, {});
  assert.equal(reranked, false);
});
