// ClipHunt frontend. Data layer is REAL projects in localStorage — no mock/demo data.
// A "project" is what new-project.html creates from a script:
//   { id, title, segments, createdAt, updatedAt }
// `segments` are the raw {text, family, query} objects straight from the Groq segment
// function. Display fields (timestamps, durations) and clips are derived fresh on load —
// clips are hydrated live (Pexels/YouTube) each time rather than persisted, so results stay
// current and history stays small.

const PROJECTS_KEY = "cliphunt_projects";

function getProjects() {
  try {
    const arr = JSON.parse(localStorage.getItem(PROJECTS_KEY) || "null");
    return Array.isArray(arr) ? arr : migrateLegacy();
  } catch {
    return [];
  }
}

function saveProjects(projects) {
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
}

// One-time migration from the old single-project keys (cliphunt_title / cliphunt_segments)
// used before multi-project history existed, so an in-flight project isn't lost.
function migrateLegacy() {
  let rawSegs = null;
  try { rawSegs = JSON.parse(localStorage.getItem("cliphunt_segments") || "null"); } catch { /* ignore */ }
  if (!Array.isArray(rawSegs)) return [];
  const now = Date.now();
  const project = {
    id: newId(),
    title: localStorage.getItem("cliphunt_title") || "Untitled Project",
    segments: rawSegs,
    createdAt: now,
    updatedAt: now,
  };
  saveProjects([project]);
  localStorage.removeItem("cliphunt_title");
  localStorage.removeItem("cliphunt_segments");
  return [project];
}

function getProject(id) {
  return getProjects().find(p => p.id === id) || null;
}

function deleteProject(id) {
  saveProjects(getProjects().filter(p => p.id !== id));
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

const FAMILY_LABEL = { feel: "Feel", evidence: "Evidence", reference: "Reference", nothing: "No clip" };
const SOURCE_LABEL = { youtube: "YT", pexels: "STOCK", image: "IMG", photo: "PHOTO" };
const READING_WORDS_PER_SEC = 2.5; // ~150wpm, dumb estimate — no real audio/pause detection yet

// Debug/test toggle: swaps evidence beats' "Find footage" button for "Find picture" so the
// SerpAPI photo pipeline (see evidence-search.js's debugImagesOnly) can be tested in isolation —
// forces every claim to search photos and skip video entirely, no YouTube search, no Groq rerank
// call. Lets the picture feature be iterated on without a YouTube-quota/rerank round trip every
// click. Persisted so it survives a reload. Scoped to "evidence" only — "reference" keeps its own
// unrelated "Find reaction clip" button and behavior.
const DEBUG_IMAGES_KEY = "cliphunt_debug_images_only";
let DEBUG_IMAGES_ONLY = localStorage.getItem(DEBUG_IMAGES_KEY) === "1";

const PLAY_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;

let CURRENT_PROJECT = null;
let SEGMENTS = [];

// Turns raw {text, family, query} objects from the Groq function into full display
// segments with estimated timestamps. Clips start null (not yet hydrated).
function buildLiveSegments(raw) {
  let cursor = 0;
  const knownOrigins = new Map();
  return raw.map((s, i) => {
    const words = (s.text || "").trim().split(/\s+/).filter(Boolean).length;
    const durSec = Math.max(0.5, words / READING_WORDS_PER_SEC);
    const start = cursor;
    cursor += durSec;
    // coverageMode/visualId/visualRef (see segment.js's sequence coverage pass): validated the
    // same way normalizeCoveragePlan does server-side — a forward/missing/self reference can't
    // survive into the UI, it just falls back to "new"/"none" the same way a legacy project would.
    let coverageMode = ["new", "continue", "callback", "none"].includes(s.coverageMode)
      ? s.coverageMode
      : (s.family === "nothing" ? "none" : "new");
    let visualId = s.visualId ? String(s.visualId) : null;
    let visualRef = s.visualRef ? String(s.visualRef) : null;
    if (coverageMode === "new") {
      if (!visualId || knownOrigins.has(visualId)) visualId = `legacy-v${i}`;
      knownOrigins.set(visualId, i);
      visualRef = null;
    } else if ((coverageMode === "continue" || coverageMode === "callback") && !knownOrigins.has(visualRef)) {
      coverageMode = s.family === "nothing" ? "none" : "new";
      visualId = coverageMode === "new" ? `legacy-v${i}` : null;
      visualRef = null;
      if (visualId) knownOrigins.set(visualId, i);
    }
    return {
      idx: i,
      time: formatTime(start),
      dur: `${durSec.toFixed(1)}s`,
      family: ["feel", "evidence", "reference", "nothing"].includes(s.family) ? s.family : "feel",
      text: s.text,
      query: s.query || null,
      // subject/categoryClaim/depictionType/reason: the segmenter's own audit trail (see
      // segment.js's SYSTEM_PROMPT — "reason" exists specifically so classification can be
      // checked, not guessed at). Used to get dropped here before ever reaching the page, which
      // is the actual reason "why did this land on X" was only answerable via a live wrangler
      // tail — now it rides along with the segment and segmentHtml() renders it. depictionType
      // ("instant"/"fallback", 2026-07-20) replaced the old "findable" field — it decides only
      // whether findFootage() also gets an image search, see evidence-search.js.
      subject: s.subject || null,
      categoryClaim: s.categoryClaim || null,
      depictionType: s.depictionType || null,
      reason: s.reason || null,
      // Editorial visual plan + sequence coverage (see segment.js) — additive, all null/"new" for
      // any legacy project saved before this feature existed.
      visualMode: s.visualMode || null,
      visualQueries: Array.isArray(s.visualQueries) ? s.visualQueries : [],
      visualGoal: s.visualGoal || null,
      eraHint: s.eraHint || null,
      coverageMode,
      visualId,
      visualRef,
      continuityReason: s.continuityReason || null,
      noneKind: s.noneKind || (coverageMode === "none" ? "unresolved" : null),
      originIdx: visualRef ? knownOrigins.get(visualRef) : null,
      clips: null, // null = not hydrated yet, vs [] = hydrated but genuinely nothing found
    };
  });
}

function formatTime(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Parse a timecode ("m:ss", "h:mm:ss", "ss", or decimals like "12.5") into seconds. NaN on garbage.
function parseTimecode(str) {
  const t = String(str || "").trim();
  if (!t) return NaN;
  if (t.includes(":")) {
    const parts = t.split(":").map(Number);
    if (parts.some((n) => !Number.isFinite(n) || n < 0)) return NaN;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

function relativeTime(ts) {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Families that auto-hydrate on load. "evidence" and "reference" both cost a YouTube search (and
// re-hydrate on every workspace load, not just once), so both stay user-triggered "Find footage"
// buttons instead — see segmentHtml()/findFootage().
const SEARCHABLE_FAMILIES = ["feel"];

// ── Dashboard (index.html) ──────────────────────────────────────────────────
// Renders the real project history. No projects → just the "New Project" card,
// which doubles as the empty state.
function renderDashboard() {
  const grid = document.getElementById("project-grid");
  const projects = getProjects().sort((a, b) => b.updatedAt - a.updatedAt);

  const cards = projects.map(p => {
    const segs = buildLiveSegments(p.segments || []);
    const totalSec = segs.reduce((sum, s) => sum + parseFloat(s.dur), 0);
    return `
      <a class="project-card" href="workspace.html?id=${encodeURIComponent(p.id)}">
        <div class="project-thumb">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>
        </div>
        <h4>${escapeHtml(p.title)}</h4>
        <span class="meta">${formatTime(totalSec)} · ${segs.length} scenes · ${relativeTime(p.updatedAt)}</span>
      </a>`;
  }).join("");

  const newCard = `
    <a class="project-card project-card-new" href="new-project.html">
      <div class="empty-icon" style="margin:0;">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      </div>
      New Project
    </a>`;

  grid.innerHTML = cards + newCard;
}

// ── Workspace (workspace.html) ──────────────────────────────────────────────
function renderWorkspace() {
  const id = new URLSearchParams(location.search).get("id");
  CURRENT_PROJECT = id ? getProject(id) : null;
  const root = document.getElementById("segments");

  if (!CURRENT_PROJECT) {
    root.innerHTML = `<p class="no-clip-msg">Project not found — it may have been deleted. <a href="index.html">Back to projects</a>.</p>`;
    return;
  }

  document.getElementById("project-title").textContent = CURRENT_PROJECT.title;
  document.title = `${CURRENT_PROJECT.title} · ClipHunt`;

  SEGMENTS = buildLiveSegments(CURRENT_PROJECT.segments || []);
  const totalSec = SEGMENTS.reduce((sum, s) => sum + parseFloat(s.dur), 0);
  document.getElementById("stat-duration").textContent = `${formatTime(totalSec)} total`;
  document.getElementById("stat-scenes").textContent = `${SEGMENTS.length} scenes`;
  const newCount = SEGMENTS.filter(s => s.coverageMode === "new").length;
  const reusedCount = SEGMENTS.filter(s => s.coverageMode === "continue" || s.coverageMode === "callback").length;
  const noneCount = SEGMENTS.filter(s => s.coverageMode === "none").length;
  const visualsPill = document.getElementById("stat-visuals");
  if (visualsPill) visualsPill.textContent = `${newCount} new visuals`;
  const reusedPill = document.getElementById("stat-reused");
  if (reusedPill) reusedPill.textContent = `${reusedCount} continued/reused`;
  const pausesPill = document.getElementById("stat-pauses");
  if (pausesPill) pausesPill.textContent = `${noneCount} narration pauses`;
  const edited = document.getElementById("stat-edited");
  if (edited) edited.textContent = `edited ${relativeTime(CURRENT_PROJECT.updatedAt)}`;

  root.innerHTML = SEGMENTS.map(seg => segmentHtml(seg)).join("");
  hydrateClips();

  const delBtn = document.getElementById("delete-project");
  if (delBtn) {
    delBtn.onclick = () => {
      if (confirm(`Delete "${CURRENT_PROJECT.title}"? This can't be undone.`)) {
        deleteProject(CURRENT_PROJECT.id);
        window.location.href = "index.html";
      }
    };
  }

  const debugToggle = document.getElementById("debug-images-only");
  if (debugToggle) {
    debugToggle.checked = DEBUG_IMAGES_ONLY;
    debugToggle.onchange = () => {
      DEBUG_IMAGES_ONLY = debugToggle.checked;
      localStorage.setItem(DEBUG_IMAGES_KEY, DEBUG_IMAGES_ONLY ? "1" : "0");
      refreshFootageButtonLabels();
    };
  }

  // One-shot console dump of every segment's classification/reasoning on load — the segmenter
  // already computes subject/categoryClaim/depictionType/reason per segment (see segment.js),
  // this just surfaces it in the browser instead of requiring a live `wrangler pages deployment
  // tail` to see what was decided and why.
  console.log(`[cliphunt] "${CURRENT_PROJECT.title}" — ${SEGMENTS.length} segments`);
  console.table(SEGMENTS.map(s => ({
    idx: s.idx, family: s.family, subject: s.subject, categoryClaim: s.categoryClaim,
    depictionType: s.depictionType, visualMode: s.visualMode, coverage: s.coverageMode,
    query: s.query, reason: s.reason, text: (s.text || "").slice(0, 60),
  })));
}

// Not gated behind a full re-render (that would re-decide needsSearch/needsFootage off live
// state and clobber any segment whose results are already fetched) — just relabels the buttons
// currently showing "Find footage"/"Find picture" on evidence beats. "reference" buttons are
// untouched (data-family check), matching the toggle's evidence-only scope.
function refreshFootageButtonLabels() {
  document.querySelectorAll(".btn-find-footage").forEach((btn) => {
    if (btn.dataset.family !== "evidence") return;
    const labelEl = btn.querySelector(".btn-label");
    if (labelEl) labelEl.textContent = DEBUG_IMAGES_ONLY ? "Find picture" : "Find footage";
  });
}

function segmentHtml(seg) {
  // coverageMode (see segment.js's sequence coverage pass) is the authoritative "does this beat
  // need its own visual" signal now — "none" subsumes the old family==="nothing" case plus any
  // beat an already-established visual can honestly cover without a new search.
  const isEmpty = seg.coverageMode === "none";
  const isReuse = seg.coverageMode === "continue" || seg.coverageMode === "callback";
  const needsSearch = !isEmpty && !isReuse && seg.clips === null && SEARCHABLE_FAMILIES.includes(seg.family);
  // Evidence AND reference are both user-triggered (each costs a YouTube search, and re-hydrates
  // on every workspace load), so both get a "Find footage" button rather than auto-hydrating.
  const needsFootage = !isEmpty && !isReuse && (seg.family === "evidence" || seg.family === "reference");

  let body;
  if (isEmpty) {
    const noneCopy = seg.noneKind === "deliberate_pause" ? "Intentional visual pause."
      : seg.noneKind === "narration_only" ? "Narration-only beat."
      : "Pacing beat — no clip needed here.";
    body = `<p class="no-clip-msg">${noneCopy}</p>`;
  } else if (isReuse) {
    const verb = seg.coverageMode === "callback" ? "Reuse" : "Continue";
    body = `<div class="continuity-note"><a href="#scene-${seg.originIdx}">${verb} SC.${String(seg.originIdx).padStart(2, "0")} visual</a>${seg.continuityReason ? ` · ${escapeHtml(seg.continuityReason)}` : ""}</div>`;
  } else if (needsSearch) {
    body = `<div class="clip-queue" id="clipqueue-${seg.idx}"><p class="no-clip-msg">Searching for clips…</p></div>`;
  } else if (needsFootage) {
    const isReference = seg.family === "reference";
    const label = isReference ? "Find reaction clip" : (DEBUG_IMAGES_ONLY ? "Find picture" : "Find footage");
    body = `
      <div class="evidence-block" id="evidence-${seg.idx}">
        <button class="btn btn-primary btn-find-footage" data-family="${seg.family}" onclick="findFootage(${seg.idx})">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/></svg>
          <span class="btn-label">${label}</span>
        </button>
      </div>`;
  } else {
    body = `<div class="clip-queue" id="clipqueue-${seg.idx}">${seg.clips.map((c, i) => clipCardHtml(seg.idx, i, c)).join("")}</div>`;
  }

  // The segmenter's own "reason" field, always shown (not gated behind a debug toggle — it's
  // cheap and this is exactly the missing visibility that made "why did this land here" only
  // answerable via a live wrangler tail before). depictionType is appended when present — it's
  // what decides whether findFootage() also runs an image search (see evidence-search.js).
  const reasonLine = seg.reason
    ? `<p class="seg-reason">${escapeHtml(seg.reason)}${seg.depictionType ? ` · depiction: ${seg.depictionType}` : ""}</p>`
    : "";

  const badgeLabel = isReuse ? (seg.coverageMode === "callback" ? "Callback" : "Continue")
    : isEmpty ? (seg.noneKind === "deliberate_pause" ? "Pause" : "Narration")
    : FAMILY_LABEL[seg.family];

  return `
    <div class="segment-row ${isEmpty ? "empty-beat" : ""} ${isReuse ? "continuity-beat" : ""}" id="scene-${seg.idx}">
      <div class="segment-meta">
        <div class="idx">SC.${String(seg.idx).padStart(2, "0")}</div>
        <div class="time">${seg.time}</div>
        <div class="dur">${seg.dur}</div>
        <span class="badge badge-${isReuse ? seg.coverageMode : seg.family}">${badgeLabel}</span>
      </div>
      <div class="segment-body">
        <p class="segment-text">${escapeHtml(seg.text || "")}</p>
        ${reasonLine}
        ${body}
      </div>
    </div>
  `;
}

// Fires real Pexels searches for feel segments after the initial render, then swaps each
// segment's "Searching…" placeholder for real results in place. Gifs (Giphy) were dropped
// entirely — low quality, too short to be useful cuts — so "feel" is Pexels-only now.
//
// One /api/stock-search-batch call for ALL feel segments at once, not one /api/stock-search call
// per segment — a script with many feel beats used to fire that many concurrent Groq rerank
// calls simultaneously (via the Promise.all this used to have), on every single workspace load,
// which was enough to burst past Groq's per-minute rate limit. See stock-search-batch.js's header
// comment for the full breakdown.
async function hydrateClips() {
  // Only "new" beats need their own search — "continue"/"callback" reuse an earlier visual, and
  // "none" has nothing to show (see segment.js's coverage pass / segmentHtml's isEmpty/isReuse).
  const targets = SEGMENTS.filter(s => s.coverageMode === "new" && s.clips === null && SEARCHABLE_FAMILIES.includes(s.family));
  if (!targets.length) return;

  try {
    const res = await fetch("/api/stock-search-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        segments: targets.map(seg => ({
          query: seg.query || seg.text,
          queries: seg.visualQueries,
          visualGoal: seg.visualGoal,
          segmentText: completeVisualSpan(seg),
        })),
      }),
    });
    const data = await res.json();
    const byIndex = new Map(res.ok && Array.isArray(data.results) ? data.results.map(r => [r.i, r.clips]) : []);
    targets.forEach((seg, i) => { seg.clips = byIndex.get(i) || []; });
  } catch {
    targets.forEach(seg => { seg.clips = []; });
  }

  // Cross-segment dedup: with a wider pool per segment, greedily assign non-duplicate
  // clips in segment order so the same clip doesn't get reused across scenes. If a segment
  // has nothing left after filtering, fall back to its own (duplicate) pool rather than
  // showing "no clips found".
  const usedIds = new Set();
  for (const seg of targets) {
    const unique = seg.clips.filter(c => !usedIds.has(c.id));
    const picked = (unique.length ? unique : seg.clips).slice(0, 4);
    picked.forEach(c => usedIds.add(c.id));
    seg.clips = picked;

    const container = document.getElementById(`clipqueue-${seg.idx}`);
    if (!container) continue;
    container.outerHTML = seg.clips.length
      ? `<div class="clip-queue" id="clipqueue-${seg.idx}">${seg.clips.map((c, i) => clipCardHtml(seg.idx, i, c)).join("")}</div>`
      : `<p class="no-clip-msg" id="clipqueue-${seg.idx}">No matching clips found.</p>`;
  }
}

// A "new" beat's search should cover every segment continuing/callback-referencing it too, not
// just its own text — otherwise a continuation beat's extra detail never reaches the search that's
// supposed to represent it. Reads SEGMENTS directly, not just the target list, since a referencing
// segment could be anywhere later in the script.
function completeVisualSpan(origin) {
  const shared = SEGMENTS.filter(s => s.idx === origin.idx ||
    ((s.coverageMode === "continue" || s.coverageMode === "callback") && s.visualRef === origin.visualId));
  return shared.map(s => s.text).join(" ");
}

function clipCardHtml(segIdx, clipIdx, clip) {
  const thumbStyle = clip.thumbUrl
    ? `background-image:url('${clip.thumbUrl}'); background-size:cover; background-position:center;`
    : "";
  const icon = clip.thumbUrl ? "" : PLAY_ICON;
  // Stock clips get a rerank score when it ran (see stock-search.js's rerankStockCandidates) —
  // same honesty-signal pattern as evidence/reference cards, shown only when it's actually there.
  const scoreLine = Number.isFinite(clip.score)
    ? `<div class="clip-sub ${clip.score >= 60 ? "ev-ok" : "ev-warn"}">${clip.score}%${clip.reason ? ` · ${escapeHtml(clip.reason)}` : ""}</div>`
    : "";
  return `
    <div class="clip-card" onclick="openPreview(${segIdx}, ${clipIdx})">
      <div class="clip-thumb" style="${thumbStyle}">
        <span class="src-chip src-${clip.source}">${SOURCE_LABEL[clip.source] || clip.source}</span>
        ${icon}
      </div>
      <div class="clip-label">${escapeHtml(clip.title || clip.label || "")}</div>
      ${scoreLine}
    </div>
  `;
}

const DL_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5M4 20h16"/></svg>`;
const EXTERNAL_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>`;

// ── Evidence footage (workspace.html) ───────────────────────────────────────
// User clicks "Find footage"/"Find reaction clip" on an evidence or reference beat: evidence-search
// (or reference-search for reaction clips) searches YouTube, quality-enriches, and LLM-reranks
// against the beat, returning plain youtube.com links — no downloading, no separate matching step.
// reference-search.js additionally ALWAYS searches Pexels stock footage in parallel (not a
// fallback — every click searches both, see renderReferenceFootage() below).
// Results are cached in memory on the segment so re-preview doesn't re-search.
async function findFootage(segIdx) {
  const seg = SEGMENTS[segIdx];
  // "continue"/"callback" beats have no search plan of their own (see segment.js's coverage
  // pass) — the button shouldn't even be rendered for them, but guard anyway.
  if (!seg || seg.coverageMode !== "new") return;
  const container = document.getElementById(`evidence-${segIdx}`);
  if (!container) return;
  const imagesOnly = DEBUG_IMAGES_ONLY && seg.family !== "reference";
  const searchingMsg = seg.family === "reference"
    ? "Searching for reaction clips and stock footage…"
    : (imagesOnly ? "Searching for photos…" : "Searching for real footage…");
  container.innerHTML = `<p class="no-clip-msg">${searchingMsg}</p>`;

  try {
    // Raw concatenation of preceding segment text — evidence-search.js/reference-search.js
    // resolve pronouns/context themselves from this, one click at a time. This used to be
    // precomputed once upfront for the whole script by a separate "narrate" pass, but that made a
    // single project-creation request's size scale with the whole script's length; resolving per
    // click instead keeps each individual request small, at the cost of re-deriving context
    // per click instead of reusing a precomputed answer.
    const context = (CURRENT_PROJECT.segments || []).slice(0, seg.idx).map(s => s.text).join(" ");
    const endpoint = seg.family === "reference" ? "/api/reference-search" : "/api/evidence-search";
    const searchRes = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // debugImagesOnly is ignored by reference-search.js (it has no such flag). For evidence
      // beats it now forces every claim to search photos and skip video (see evidence-search.js,
      // 2026-07-21) — the old segment-level depictionType gate is no longer read there, superseded
      // by the new per-claim mediaType judgment, so it's no longer sent. visualMode/visualQueries/
      // visualGoal/eraHint (segment.js's editorial plan) ride along as a prior for evidence-search
      // to verify against local claim context — ignored by reference-search.js. segmentText spans
      // every segment continuing/callback-referencing this one (see completeVisualSpan), not just
      // this segment's own text.
      body: JSON.stringify({
        segmentText: completeVisualSpan(seg),
        context,
        debugImagesOnly: imagesOnly,
        visualMode: seg.visualMode,
        visualQueries: seg.visualQueries,
        visualGoal: seg.visualGoal,
        eraHint: seg.eraHint,
      }),
    });
    const search = await searchRes.json();
    if (!searchRes.ok) throw new Error(search.error || "Search failed");

    if (seg.family === "reference") {
      // reference-search.js always searches BOTH YouTube (reaction/meme clips) and Pexels (stock
      // footage) in parallel, every click — not a fallback chain. Both result sets get populated
      // on the segment and rendered together, each through its own EXISTING, unmodified card
      // renderer/click-handler (evidenceCardHtml/openEvidencePreview for YouTube, clipCardHtml/
      // openPreview for Pexels) — they already work correctly off their own independent
      // per-segment array + index, so nothing about either renderer changes.
      seg.evidence = { candidates: search.candidates || [] };
      seg.clips = search.clips || [];
      renderReferenceFootage(segIdx);
      return;
    }

    // evidence-search.js now splits the moment into claims and judges video/photo/both PER CLAIM
    // (2026-07-21 — see its header comment) instead of extracting one intent per click. Logged
    // here so the split + per-claim mediaType decision is visible in the browser console without
    // a live wrangler tail.
    const claims = search.claims || [];
    console.log(
      `[cliphunt] seg #${segIdx} imagesOnly=${imagesOnly} ${claims.length} claim(s): ` +
      claims.map(c => `[${c.mediaType} video=${(c.videoCandidates || []).length} photo=${(c.photoCandidates || []).length}]`).join(" ")
    );

    seg.evidence = { claims };
    renderEvidenceClaims(segIdx);
  } catch (err) {
    container.innerHTML = `<p class="no-clip-msg">Couldn't find footage: ${escapeHtml(err.message)}</p>`;
  }
}

// Renders one labeled .claim-group per claim the moment was split into (see evidence-search.js's
// 2026-07-21 multi-claim decomposition) — each group has its own video cards (claimVideoCardHtml/
// openClaimVideoPreview) and photo cards (photoCardHtml/openPhotoPreview), only for whichever
// medium(s) that claim's mediaType actually called for. Replaces the old flat renderEvidence(),
// which pooled one intent's results into a single unlabeled queue.
function renderEvidenceClaims(segIdx) {
  const seg = SEGMENTS[segIdx];
  const container = document.getElementById(`evidence-${segIdx}`);
  if (!container || !seg.evidence) return;
  const claims = seg.evidence.claims || [];
  if (!claims.length) {
    container.innerHTML = `<p class="no-clip-msg">No footage candidates found.</p>`;
    return;
  }
  container.innerHTML = claims.map((c, ci) => {
    const cards =
      (c.videoCandidates || []).map((cand, vi) => claimVideoCardHtml(segIdx, ci, vi, cand)).join("") +
      (c.photoCandidates || []).map((img, pi) => photoCardHtml(segIdx, ci, pi, img)).join("");
    const body = cards
      ? `<div class="clip-queue">${cards}</div>`
      : `<p class="no-clip-msg">No candidates found for this claim.</p>`;
    return `<div class="claim-group"><p class="claim-label">${escapeHtml(c.claim || "")}</p>${body}</div>`;
  }).join("");
}

// Deliberately a small, acknowledged duplication of evidenceCardHtml/openEvidencePreview rather
// than changing that function's data shape — reference-search.js's reaction-clip feature also
// still relies on evidenceCardHtml/openEvidencePreview reading seg.evidence.candidates as a flat
// array, so evidence beats now need their own claim-indexed [claimIdx][candIdx] variant instead.
function claimVideoCardHtml(segIdx, claimIdx, candIdx, cand) {
  const thumbStyle = cand.thumb
    ? `background-image:url('${cand.thumb}'); background-size:cover; background-position:center;`
    : "";
  const label = evidenceLabel(cand);
  return `
    <div class="clip-card" onclick="openClaimVideoPreview(${segIdx}, ${claimIdx}, ${candIdx})">
      <div class="clip-thumb" style="${thumbStyle}">
        <span class="src-chip src-youtube">${SOURCE_LABEL.youtube}</span>
        ${cand.thumb ? "" : PLAY_ICON}
      </div>
      <div class="clip-label">${escapeHtml(cand.title || "")}</div>
      <div class="clip-sub ${label.cls}">${label.text}</div>
    </div>`;
}

function openClaimVideoPreview(segIdx, claimIdx, candIdx) {
  const cand = SEGMENTS[segIdx].evidence.claims[claimIdx].videoCandidates[candIdx];

  const thumbEl = document.getElementById("modal-thumb");
  thumbEl.style.backgroundImage = "";
  document.getElementById("modal-play").style.display = "none";
  const video = document.getElementById("modal-video");
  if (video) {
    video.pause();
    video.src = "";
    video.style.display = "none";
  }
  const iframe = document.getElementById("modal-iframe");
  iframe.src = `https://www.youtube.com/embed/${cand.videoId}?autoplay=1`;
  iframe.style.display = "block";

  document.getElementById("modal-title").textContent = cand.title || "";
  document.getElementById("modal-sub").textContent = `YouTube · ${cand.channel || ""} · ${evidenceLabel(cand).text}`;

  const actionBtn = document.getElementById("modal-download");
  actionBtn.href = cand.url;
  actionBtn.target = "_blank";
  actionBtn.rel = "noopener";
  actionBtn.removeAttribute("download");
  actionBtn.innerHTML = `${EXTERNAL_ICON} Watch on YouTube`;
  actionBtn.style.display = "";

  const trimRow = document.getElementById("trim-row");
  if (trimRow) trimRow.style.display = "none"; // trim is stock-only

  document.getElementById("modal-overlay").classList.add("open");
}

// A photo result card. The thumbnail shown is Google's own hosted thumb (via SerpAPI) — the
// full-res original is never fetched or hotlinked (same link-only rule as YouTube evidence: this
// app points at content it doesn't have rights to redistribute, it doesn't serve it). Clicking
// opens the same preview modal the video path uses, showing the thumbnail plus a "View source
// page" external link as the single action — mirroring the video path's "link out, don't
// download" posture instead of being a bare anchor tag.
function photoCardHtml(segIdx, claimIdx, photoIdx, img) {
  const thumbStyle = img.thumb
    ? `background-image:url('${escapeHtml(img.thumb)}'); background-size:cover; background-position:center;`
    : "";
  return `
    <div class="clip-card" onclick="openPhotoPreview(${segIdx}, ${claimIdx}, ${photoIdx})">
      <div class="clip-thumb" style="${thumbStyle}">
        <span class="src-chip src-photo">${SOURCE_LABEL.photo}</span>
      </div>
      <div class="clip-label">${escapeHtml(img.title || "")}</div>
      <div class="clip-sub">${escapeHtml(img.domain || "")}</div>
    </div>`;
}

function openPhotoPreview(segIdx, claimIdx, photoIdx) {
  const img = SEGMENTS[segIdx].evidence.claims[claimIdx].photoCandidates[photoIdx];

  const iframe = document.getElementById("modal-iframe");
  iframe.src = "";
  iframe.style.display = "none";
  const video = document.getElementById("modal-video");
  if (video) {
    video.pause();
    video.src = "";
    video.style.display = "none";
  }
  document.getElementById("modal-play").style.display = "none";
  const thumbEl = document.getElementById("modal-thumb");
  thumbEl.style.backgroundImage = img.thumb ? `url('${img.thumb}')` : "";
  thumbEl.style.backgroundSize = "cover";
  thumbEl.style.backgroundPosition = "center";

  document.getElementById("modal-title").textContent = img.title || "";
  document.getElementById("modal-sub").textContent = `Photo · ${img.domain || ""}`;

  const actionBtn = document.getElementById("modal-download");
  actionBtn.href = img.pageUrl;
  actionBtn.target = "_blank";
  actionBtn.rel = "noopener";
  actionBtn.removeAttribute("download");
  actionBtn.innerHTML = `${EXTERNAL_ICON} View source page`;
  actionBtn.style.display = "";

  const trimRow = document.getElementById("trim-row");
  if (trimRow) trimRow.style.display = "none";

  document.getElementById("modal-overlay").classList.add("open");
}

// Renders BOTH result sets for a "reference" beat together in one queue — YouTube reaction
// candidates (seg.evidence.candidates, via evidenceCardHtml/openEvidencePreview) and Pexels stock
// clips (seg.clips, via clipCardHtml/openPreview). Each keeps its own card renderer, click
// handler, and index namespace completely unmodified — this function only decides what HTML gets
// concatenated into the shared container. The "YT"/"STOCK" src-chip each renderer already stamps
// on its own cards is the only source distinction shown; no separate section headers, since that
// chip is already the established way every other clip-queue in this app distinguishes source.
function renderReferenceFootage(segIdx) {
  const seg = SEGMENTS[segIdx];
  const container = document.getElementById(`evidence-${segIdx}`);
  if (!container) return;
  const candidates = (seg.evidence && seg.evidence.candidates) || [];
  const clips = seg.clips || [];
  const cards =
    candidates.map((c, i) => evidenceCardHtml(segIdx, i, c)).join("") +
    clips.map((c, i) => clipCardHtml(segIdx, i, c)).join("");
  container.innerHTML = cards
    ? `<div class="clip-queue">${cards}</div>`
    : `<p class="no-clip-msg">No footage candidates found for this moment.</p>`;
}

// Honest one-liner driven by the LLM rerank's own score/reason (0-100 against the beat's actual
// claim/subject/quote) — that's already the verification signal, just surfaced here instead of
// feeding a separate caption-match step.
function evidenceLabel(cand) {
  if (!Number.isFinite(cand.score)) return { text: "unscored", cls: "ev-warn" };
  const cls = cand.score >= 70 ? "ev-ok" : "ev-warn";
  return { text: cand.reason ? `${cand.score}% · ${cand.reason}` : `${cand.score}% match`, cls };
}

function evidenceCardHtml(segIdx, candIdx, cand) {
  const thumbStyle = cand.thumb
    ? `background-image:url('${cand.thumb}'); background-size:cover; background-position:center;`
    : "";
  const label = evidenceLabel(cand);
  return `
    <div class="clip-card" onclick="openEvidencePreview(${segIdx}, ${candIdx})">
      <div class="clip-thumb" style="${thumbStyle}">
        <span class="src-chip src-youtube">${SOURCE_LABEL.youtube}</span>
        ${cand.thumb ? "" : PLAY_ICON}
      </div>
      <div class="clip-label">${escapeHtml(cand.title || "")}</div>
      <div class="clip-sub ${label.cls}">${label.text}</div>
    </div>`;
}

// Standard (non-trimmed) YouTube embed for preview — evidence/reference results are references
// for the user to watch and judge, not files this app hands out. The single action button is an
// external link, not a download.
function openEvidencePreview(segIdx, candIdx) {
  const cand = SEGMENTS[segIdx].evidence.candidates[candIdx];

  const thumbEl = document.getElementById("modal-thumb");
  thumbEl.style.backgroundImage = "";
  document.getElementById("modal-play").style.display = "none";
  const video = document.getElementById("modal-video");
  if (video) {
    video.pause();
    video.src = "";
    video.style.display = "none";
  }
  const iframe = document.getElementById("modal-iframe");
  iframe.src = `https://www.youtube.com/embed/${cand.videoId}?autoplay=1`;
  iframe.style.display = "block";

  document.getElementById("modal-title").textContent = cand.title || "";
  document.getElementById("modal-sub").textContent = `YouTube · ${cand.channel || ""} · ${evidenceLabel(cand).text}`;

  const actionBtn = document.getElementById("modal-download");
  actionBtn.href = cand.url;
  actionBtn.target = "_blank";
  actionBtn.rel = "noopener";
  actionBtn.removeAttribute("download");
  actionBtn.innerHTML = `${EXTERNAL_ICON} Watch on YouTube`;
  actionBtn.style.display = "";

  const trimRow = document.getElementById("trim-row");
  if (trimRow) trimRow.style.display = "none"; // trim is stock-only

  document.getElementById("modal-overlay").classList.add("open");
}

// "feel" clips are Pexels-only now (gifs dropped entirely), so this modal path only ever
// renders a real stock video — no more branching on clip source.
function openPreview(segIdx, clipIdx) {
  const seg = SEGMENTS[segIdx];
  const clip = seg.clips[clipIdx];

  const iframe = document.getElementById("modal-iframe");
  iframe.src = "";
  iframe.style.display = "none";

  const video = document.getElementById("modal-video");
  const thumbEl = document.getElementById("modal-thumb");
  const downloadBtn = document.getElementById("modal-download");
  downloadBtn.removeAttribute("target");
  downloadBtn.removeAttribute("rel");

  document.getElementById("modal-play").style.display = "none";
  thumbEl.style.backgroundImage = "";
  if (video) {
    video.src = clip.previewUrl || clip.downloadUrl || "";
    video.style.display = "";
  }
  document.getElementById("modal-title").textContent = clip.title || "Stock footage";
  document.getElementById("modal-sub").textContent = `Pexels · ${clip.author || ""}`;

  downloadBtn.href = `/api/stock-download?url=${encodeURIComponent(clip.downloadUrl)}&name=${encodeURIComponent(clip.id)}`;
  downloadBtn.setAttribute("download", "");
  downloadBtn.innerHTML = `${DL_ICON} Download clip`;
  downloadBtn.style.display = "";

  setupStockTrimRow(clip);

  document.getElementById("modal-overlay").classList.add("open");
}

// Trim-to-download for Pexels stock clips only — Pexels' license permits reuse, so this is a
// genuine convenience feature (hand over just the range that's wanted, not the whole clip to trim
// later), unlike the YouTube path which stays link-only. Entirely client-side: no server, no new
// library, so it stays free and doesn't bloat the app. "Preview range" just seeks/plays the
// visible <video> (a plain playback, no CORS concern). "Download range" records via
// captureStream()+MediaRecorder straight off Pexels' CDN (their video URLs send
// Access-Control-Allow-Origin: *, verified, so a crossOrigin="anonymous" element isn't
// data-tainted) — output is .webm, not .mp4, since that's MediaRecorder's native format; shipping
// an mp4 re-encoder client-side would mean bundling ffmpeg.wasm (~25MB) for this one feature,
// which isn't worth it — every modern editor, CapCut included, opens .webm fine.
function setupStockTrimRow(clip) {
  const row = document.getElementById("trim-row");
  if (!row) return;
  row.style.display = "flex";
  const startEl = document.getElementById("trim-start");
  const endEl = document.getElementById("trim-end");
  const errEl = document.getElementById("trim-err");
  const video = document.getElementById("modal-video");
  const dlBtn = document.getElementById("trim-download");
  errEl.textContent = "";
  dlBtn.disabled = false;
  const dur = clip.duration || 10;
  startEl.value = "0:00";
  endEl.value = formatTime(Math.min(dur, 10));

  const readRange = () => {
    const s = parseTimecode(startEl.value);
    const e = parseTimecode(endEl.value);
    if (Number.isNaN(s) || Number.isNaN(e)) { errEl.textContent = "Use m:ss or seconds."; return null; }
    if (!(e > s)) { errEl.textContent = "End must be after start."; return null; }
    if (e - s > 60) { errEl.textContent = "Range must be 60s or less."; return null; }
    if (dur && e > dur + 0.5) { errEl.textContent = `Clip is only ${formatTime(dur)} long.`; return null; }
    errEl.textContent = "";
    return { s, e };
  };

  document.getElementById("trim-preview").onclick = () => {
    const r = readRange();
    if (!r || !video) return;
    video.currentTime = r.s;
    video.play();
    const stopAt = () => {
      if (video.currentTime >= r.e) {
        video.pause();
        video.removeEventListener("timeupdate", stopAt);
      }
    };
    video.addEventListener("timeupdate", stopAt);
  };

  dlBtn.onclick = async () => {
    const r = readRange();
    if (!r) return;
    dlBtn.disabled = true;
    errEl.textContent = "Recording trimmed range…";
    try {
      const blob = await recordClipRange(clip, r.s, r.e);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cliphunt-${clip.id || "clip"}-trim.webm`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      errEl.textContent = "";
    } catch (err) {
      errEl.textContent = `Trim failed: ${err.message}`;
    } finally {
      dlBtn.disabled = false;
    }
  };
}

// Records [start,end] of a Pexels clip into a downloadable webm blob. Loads its own hidden video
// element (crossOrigin="anonymous" against Pexels' CDN — see setupStockTrimRow's comment) rather
// than reusing the visible preview, so a re-download for recording never disturbs playback.
function recordClipRange(clip, start, end) {
  return new Promise((resolve, reject) => {
    if (typeof HTMLVideoElement.prototype.captureStream !== "function") {
      reject(new Error("this browser can't record video"));
      return;
    }
    const video = document.createElement("video");
    // Pexels' CDN sends Access-Control-Allow-Origin: * (verified), so captureStream() can read
    // straight from their CDN URL, same as the visible preview does — no proxy hop needed.
    video.crossOrigin = "anonymous";
    video.muted = false;
    video.playsInline = true;
    video.style.display = "none";
    document.body.appendChild(video);
    const cleanup = () => { video.pause(); video.remove(); };

    const beginRecording = () => {
      let recorder;
      try {
        const stream = video.captureStream();
        const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
          .find((t) => MediaRecorder.isTypeSupported(t)) || "";
        recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      recorder.onerror = (e) => { cleanup(); reject(e.error || new Error("recording failed")); };
      recorder.onstop = () => { cleanup(); resolve(new Blob(chunks, { type: "video/webm" })); };

      recorder.start();
      video.play();
      const check = () => {
        if (video.currentTime >= end || video.ended) {
          video.removeEventListener("timeupdate", check);
          recorder.stop();
        }
      };
      video.addEventListener("timeupdate", check);
    };

    video.onerror = () => { cleanup(); reject(new Error("couldn't load clip")); };
    video.onloadedmetadata = () => {
      // Setting currentTime to the value it's already at (start=0 on a fresh load) never fires
      // "seeked" — skip the seek entirely in that case instead of waiting on an event that won't come.
      if (Math.abs(video.currentTime - start) < 0.05) beginRecording();
      else video.currentTime = start;
    };
    video.onseeked = beginRecording;

    video.src = clip.downloadUrl;
  });
}

function closePreview() {
  document.getElementById("modal-overlay").classList.remove("open");
  const thumbEl = document.getElementById("modal-thumb");
  thumbEl.style.backgroundImage = "";
  // Stop excerpt playback when closing (clearing src halts the YouTube embed / video element).
  const iframe = document.getElementById("modal-iframe");
  iframe.src = "";
  iframe.style.display = "none";
  const video = document.getElementById("modal-video");
  if (video) {
    video.pause();
    video.src = "";
    video.style.display = "none";
  }
  const trimRow = document.getElementById("trim-row");
  if (trimRow) trimRow.style.display = "none";
}

// One script serves all pages; dispatch by which page's root element is present.
document.addEventListener("DOMContentLoaded", () => {
  if (document.getElementById("segments")) renderWorkspace();
  else if (document.getElementById("project-grid")) renderDashboard();
});
