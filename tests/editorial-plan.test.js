import test from "node:test";
import assert from "node:assert/strict";
import {
  enforceProductFocus,
  enforceVisualPlan,
  normalizeCoveragePlan,
  summarizeCoverage,
} from "../functions/api/segment.js";

test("old evidence output preserves exact search behavior", () => {
  const [seg] = enforceVisualPlan([{ family: "evidence", query: "Kane France penalty 2022" }]);
  assert.equal(seg.visualMode, "exact");
  assert.deepEqual(seg.visualQueries, ["Kane France penalty 2022"]);
});

test("old feel output preserves stock search behavior", () => {
  const [seg] = enforceVisualPlan([{ family: "feel", query: "empty stadium at night" }]);
  assert.equal(seg.visualMode, "stock");
  assert.deepEqual(seg.visualQueries, ["empty stadium at night"]);
});

test("subject b-roll retains diverse searches and era", () => {
  const [seg] = enforceVisualPlan([{
    family: "evidence",
    subject: "Example Player",
    visualMode: "subject_broll",
    query: "Example Player academy training young",
    visualQueries: [
      "Example Player academy training young",
      "Example Player youth behind scenes interview",
      "Example Player early career practice",
      "fourth query must be capped",
    ],
    eraHint: "academy / teenage years",
    visualGoal: "Show obsessive work during his youth",
  }]);
  assert.equal(seg.visualMode, "subject_broll");
  assert.equal(seg.visualQueries.length, 3);
  assert.equal(seg.eraHint, "academy / teenage years");
});

test("anonymous subject b-roll safely falls back to prior exact behavior", () => {
  const [seg] = enforceVisualPlan([{
    family: "evidence",
    subject: null,
    visualMode: "subject_broll",
    query: "training alone",
  }]);
  assert.equal(seg.visualMode, "exact");
});

test("family remains authoritative when model returns a contradictory mode", () => {
  const [feel] = enforceVisualPlan([{ family: "feel", visualMode: "exact", query: "clock near deadline" }]);
  const [evidence] = enforceVisualPlan([{ family: "evidence", visualMode: "stock", query: "real event" }]);
  assert.equal(feel.visualMode, "stock");
  assert.equal(evidence.visualMode, "exact");
});

test("new reference beats use editorial stock without breaking saved legacy rendering", () => {
  const [withFallback] = enforceProductFocus([{
    family: "reference",
    query: "person staring in stunned silence",
    reason: "recognized callback",
  }]);
  const [withoutFallback] = enforceProductFocus([{ family: "reference", query: null }]);
  assert.equal(withFallback.family, "feel");
  assert.equal(withoutFallback.family, "nothing");
});

test("nothing beats cannot leak stale visual searches", () => {
  const [seg] = enforceVisualPlan([{
    family: "nothing",
    visualMode: "stock",
    visualQueries: ["irrelevant visual"],
    visualGoal: "Should disappear",
  }]);
  assert.equal("visualMode" in seg, false);
  assert.equal("visualQueries" in seg, false);
});

test("legacy searchable rows become new and legacy nothing becomes none", () => {
  const rows = normalizeCoveragePlan(enforceVisualPlan([
    { family: "evidence", query: "real event" },
    { family: "feel", query: "empty street" },
    { family: "nothing" },
  ]));
  assert.deepEqual(rows.map(s => s.coverageMode), ["new", "new", "none"]);
  assert.deepEqual(rows.slice(0, 2).map(s => s.visualId), ["legacy-v0", "legacy-v1"]);
  assert.equal(rows[2].noneKind, "unresolved");
});

test("adjacent and consecutive continuations point directly to one new visual", () => {
  const rows = normalizeCoveragePlan([
    { family: "feel", query: "crowd waiting", coverageMode: "new", visualId: "v0" },
    { family: "nothing", coverageMode: "continue", visualRef: "v0", continuityReason: "same wait" },
    { family: "nothing", coverageMode: "continue", visualRef: "v0", continuityReason: "same wait concludes" },
  ]);
  assert.deepEqual(rows.map(s => s.coverageMode), ["new", "continue", "continue"]);
  assert.deepEqual(rows.slice(1).map(s => s.visualRef), ["v0", "v0"]);
});

test("non-adjacent callback can reuse an earlier exact event", () => {
  const rows = normalizeCoveragePlan([
    { family: "evidence", query: "named final", coverageMode: "new", visualId: "event" },
    { family: "feel", query: "city at night", coverageMode: "new", visualId: "city" },
    { family: "nothing", coverageMode: "callback", visualRef: "event", continuityReason: "returns to final" },
  ]);
  assert.equal(rows[2].coverageMode, "callback");
  assert.equal(rows[2].visualRef, "event");
});

test("duplicate IDs are repaired without changing valid search plans", () => {
  const rows = normalizeCoveragePlan([
    { family: "feel", query: "one", coverageMode: "new", visualId: "v0" },
    { family: "feel", query: "two", coverageMode: "new", visualId: "v0" },
  ]);
  assert.equal(rows[0].visualId, "v0");
  assert.equal(rows[1].visualId, "legacy-v1");
});

test("forward, missing and chained references cannot survive", () => {
  const rows = normalizeCoveragePlan([
    { family: "nothing", coverageMode: "continue", visualRef: "later" },
    { family: "feel", query: "valid", coverageMode: "new", visualId: "later" },
    { family: "nothing", coverageMode: "continue", visualRef: "missing" },
    { family: "nothing", coverageMode: "continue", visualRef: "legacy-v0" },
  ]);
  assert.deepEqual(rows.map(s => s.coverageMode), ["none", "new", "none", "none"]);
  assert.ok(rows.filter(s => s.coverageMode === "none").every(s => s.noneKind === "unresolved"));
});

test("invalid continuation falls back to its legacy search or unresolved none", () => {
  const rows = normalizeCoveragePlan([
    { family: "feel", query: "fallback shot", coverageMode: "continue", visualRef: "missing" },
    { family: "nothing", coverageMode: "callback", visualRef: "missing" },
  ]);
  assert.equal(rows[0].coverageMode, "new");
  assert.equal(rows[0].visualId, "fallback-v0");
  assert.equal(rows[1].coverageMode, "none");
  assert.equal(rows[1].noneKind, "unresolved");
});

test("explicit subject or era conflicts invalidate reuse", () => {
  const rows = normalizeCoveragePlan([
    { family: "evidence", query: "A event", subject: "A", eraHint: "2020", coverageMode: "new", visualId: "v0" },
    { family: "nothing", subject: "B", coverageMode: "continue", visualRef: "v0" },
    { family: "nothing", eraHint: "1990", coverageMode: "callback", visualRef: "v0" },
  ]);
  assert.deepEqual(rows.map(s => s.coverageMode), ["new", "none", "none"]);
});

test("coverage summary matches modes and does not enforce a quota", () => {
  const rows = normalizeCoveragePlan([
    { family: "feel", query: "one" },
    { family: "nothing", coverageMode: "continue", visualRef: "legacy-v0" },
    { family: "nothing", noneKind: "narration_only", coverageMode: "none" },
  ]);
  assert.deepEqual(summarizeCoverage(rows), {
    total: 3, new: 1, continue: 1, callback: 0, none: 1, unresolved: 0, fullyNothingRate: 1 / 3,
  });
});
