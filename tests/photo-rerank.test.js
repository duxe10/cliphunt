import test from "node:test";
import assert from "node:assert/strict";
import { rerankPhotoCandidates, MIN_RERANK_SCORE } from "../functions/api/evidence-search.js";

function mockGroqOnce(payload) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 });
  return () => { globalThis.fetch = originalFetch; };
}

// The actual fix for TikTok/wrong-medium photo results: a domain blocklist (_serpapi.js) can only
// ever catch platforms someone thought to enumerate. This is the general mechanism — an LLM
// judging relevance AND medium-fit from title/domain, the same way rerankCandidates already does
// for YouTube. A video-shaped title/platform should score low regardless of which specific site
// it's on, not because that site's name is on a list.
test("rerankPhotoCandidates scores a video-shaped result low even on a platform not in any blocklist", async () => {
  const restore = mockGroqOnce({
    ranking: [
      { id: "a", score: 85, reason: "real news photo" },
      { id: "b", score: 5, reason: "video highlight reel, wrong medium" },
    ],
  });
  try {
    const candidates = [
      { id: "a", title: "Player pictured after the match", domain: "Reuters" },
      { id: "b", title: "INSANE Goal Celebration Highlights!!", domain: "some-random-clip-site.example" },
    ];
    const reranked = await rerankPhotoCandidates({ segmentText: "moment", subject: "Player" }, candidates, { GROQ_API_KEY: "x" });
    assert.equal(reranked, true);
    assert.equal(candidates.find((c) => c.id === "a").score, 85);
    assert.equal(candidates.find((c) => c.id === "b").score, 5);
    assert.ok(candidates.find((c) => c.id === "b").score < MIN_RERANK_SCORE);
  } finally {
    restore();
  }
});

test("rerankPhotoCandidates defaults a candidate missing from the model's own ranking to score 0, not left unscored", async () => {
  const restore = mockGroqOnce({ ranking: [{ id: "a", score: 90, reason: "good" }] });
  try {
    const candidates = [{ id: "a", title: "ok" }, { id: "b", title: "silently omitted by the model" }];
    await rerankPhotoCandidates({ segmentText: "moment" }, candidates, { GROQ_API_KEY: "x" });
    assert.equal(candidates.find((c) => c.id === "b").score, 0);
  } finally {
    restore();
  }
});

test("rerankPhotoCandidates returns false (not scored) when there's no GROQ_API_KEY, leaving candidates untouched", async () => {
  const candidates = [{ id: "a", title: "x" }, { id: "b", title: "y" }];
  const reranked = await rerankPhotoCandidates({ segmentText: "moment" }, candidates, {});
  assert.equal(reranked, false);
});
