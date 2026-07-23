import test from "node:test";
import assert from "node:assert/strict";
import { rerankStockCandidates, rerankStockCandidatesBatch } from "../functions/api/stock-search.js";

function mockGroqOnce(payload) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 });
  return () => { globalThis.fetch = originalFetch; };
}

function mockGroqFailure() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("upstream error", { status: 500 });
  return () => { globalThis.fetch = originalFetch; };
}

// Regression: confirmed live — a rerank call can succeed overall but silently omit a specific
// candidate's id from its own ranking array (despite being told "include EVERY candidate exactly
// once"). The old code treated that missing id as score:null and then KEPT it unfiltered — showing
// an unvetted, sometimes flatly wrong clip (an unrelated subject entirely) with no score line at
// all, indistinguishable from a genuinely reviewed low-confidence result.
test("rerankStockCandidates drops a candidate the model silently omitted from a successful ranking", async () => {
  const restore = mockGroqOnce({
    ranking: [
      { id: "a", score: 80, reason: "good match" },
      // "b" is deliberately missing, simulating the model dropping a candidate it was sent.
    ],
  });
  try {
    const clips = [{ id: "a", title: "relevant clip" }, { id: "b", title: "unrelated clip" }];
    const kept = await rerankStockCandidates({ segmentText: "moment", query: "q" }, clips, { GROQ_API_KEY: "x" });
    assert.deepEqual(kept.map((c) => c.id), ["a"]);
  } finally {
    restore();
  }
});

test("rerankStockCandidatesBatch drops a candidate silently missing from its own segment's ranking", async () => {
  const restore = mockGroqOnce({
    segments: [{ i: 0, ranking: [{ id: "a", score: 80, reason: "good" }] }],
  });
  try {
    const items = [{ i: 0, segmentText: "moment", query: "q", clips: [{ id: "a", title: "ok" }, { id: "b", title: "junk" }] }];
    const [kept] = await rerankStockCandidatesBatch(items, { GROQ_API_KEY: "x" });
    assert.deepEqual(kept.map((c) => c.id), ["a"]);
  } finally {
    restore();
  }
});

// A whole segment missing from the batch response is a DIFFERENT case from a total call failure —
// the model substantively responded and scored OTHER segments, it just skipped this one entirely.
// Confirmed live: unfiltered pass-through here let an entirely wrong-sport clip through with no
// score shown. Must drop, same as the per-candidate case.
test("rerankStockCandidatesBatch drops every candidate for a segment index missing entirely from an otherwise-successful response", async () => {
  const restore = mockGroqOnce({
    segments: [{ i: 0, ranking: [{ id: "a", score: 80, reason: "good" }] }],
    // segment index 1 never appears anywhere in the response.
  });
  try {
    const items = [
      { i: 0, segmentText: "moment 0", query: "q0", clips: [{ id: "a", title: "ok" }, { id: "b", title: "b" }] },
      { i: 1, segmentText: "moment 1", query: "q1", clips: [{ id: "c", title: "wrong sport" }, { id: "d", title: "d" }] },
    ];
    const [kept0, kept1] = await rerankStockCandidatesBatch(items, { GROQ_API_KEY: "x" });
    assert.deepEqual(kept0.map((c) => c.id), ["a"]);
    assert.deepEqual(kept1, []);
  } finally {
    restore();
  }
});

// A TOTAL call failure (the whole Groq request itself failed) is different from the model
// substantively responding but skipping something — there's genuinely no signal for anyone in
// this case, so unfiltered pass-through stays the least-bad option rather than silently failing
// every feel beat in the project.
test("rerankStockCandidatesBatch falls back to unfiltered pass-through only on a total call failure", async () => {
  const restore = mockGroqFailure();
  try {
    const items = [
      { i: 0, segmentText: "moment 0", query: "q0", clips: [{ id: "a", title: "a" }, { id: "b", title: "b" }] },
    ];
    const [kept0] = await rerankStockCandidatesBatch(items, { GROQ_API_KEY: "x" });
    assert.deepEqual(kept0.map((c) => c.id), ["a", "b"]);
  } finally {
    restore();
  }
});
