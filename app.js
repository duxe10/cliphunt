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
const SOURCE_LABEL = { youtube: "YT", pexels: "STOCK", photo: "PHOTO" };
const READING_WORDS_PER_SEC = 2.5; // ~150wpm, dumb estimate — no real audio/pause detection yet

const PLAY_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;

let CURRENT_PROJECT = null;
let SEGMENTS = [];

// Turns raw {text, family, query} objects from the Groq function into full display
// segments with estimated timestamps. Clips start null (not yet hydrated).
function buildLiveSegments(raw) {
  let cursor = 0;
  return raw.map((s, i) => {
    const words = (s.text || "").trim().split(/\s+/).filter(Boolean).length;
    const durSec = Math.max(0.5, words / READING_WORDS_PER_SEC);
    const start = cursor;
    cursor += durSec;
    return {
      idx: i,
      time: formatTime(start),
      dur: `${durSec.toFixed(1)}s`,
      family: ["feel", "evidence", "reference", "nothing"].includes(s.family) ? s.family : "feel",
      text: s.text,
      query: s.query || null,
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
}

function segmentHtml(seg) {
  const isEmpty = seg.family === "nothing";
  const needsSearch = !isEmpty && seg.clips === null && SEARCHABLE_FAMILIES.includes(seg.family);
  // Evidence AND reference are both user-triggered (each costs a YouTube search, and re-hydrates
  // on every workspace load), so both get a "Find footage" button rather than auto-hydrating.
  const needsFootage = !isEmpty && (seg.family === "evidence" || seg.family === "reference");

  let body;
  if (isEmpty) {
    body = `<p class="no-clip-msg">Pacing beat — no clip needed here.</p>`;
  } else if (needsSearch) {
    body = `<div class="clip-queue" id="clipqueue-${seg.idx}"><p class="no-clip-msg">Searching for clips…</p></div>`;
  } else if (needsFootage) {
    const label = seg.family === "reference" ? "Find reaction clip" : "Find footage";
    body = `
      <div class="evidence-block" id="evidence-${seg.idx}">
        <button class="btn btn-primary btn-find-footage" onclick="findFootage(${seg.idx})">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/></svg>
          ${label}
        </button>
      </div>`;
  } else {
    body = `<div class="clip-queue" id="clipqueue-${seg.idx}">${seg.clips.map((c, i) => clipCardHtml(seg.idx, i, c)).join("")}</div>`;
  }

  return `
    <div class="segment-row ${isEmpty ? "empty-beat" : ""}">
      <div class="segment-meta">
        <div class="idx">SC.${String(seg.idx).padStart(2, "0")}</div>
        <div class="time">${seg.time}</div>
        <div class="dur">${seg.dur}</div>
        <span class="badge badge-${seg.family}">${FAMILY_LABEL[seg.family]}</span>
      </div>
      <div class="segment-body">
        <p class="segment-text">${escapeHtml(seg.text || "")}</p>
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
  const targets = SEGMENTS.filter(s => s.clips === null && SEARCHABLE_FAMILIES.includes(s.family));
  if (!targets.length) return;

  try {
    const res = await fetch("/api/stock-search-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        segments: targets.map(seg => ({ query: seg.query || seg.text, segmentText: seg.text })),
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
  const container = document.getElementById(`evidence-${segIdx}`);
  if (!container) return;
  const searchingMsg = seg.family === "reference" ? "Searching for reaction clips and stock footage…" : "Searching for real footage…";
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
      body: JSON.stringify({ segmentText: seg.text, context }),
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

    seg.evidence = { claims: search.claims || [] };
    renderEvidenceClaims(segIdx);
  } catch (err) {
    container.innerHTML = `<p class="no-clip-msg">Couldn't find footage: ${escapeHtml(err.message)}</p>`;
  }
}

// Multi-claim evidence result: evidence-search.js splits the moment into its independently
// real, independently evidence-worthy claims (a moment naming several separate achievements no
// longer collapses into one query) and judges per claim which medium(s) fit — so each claim gets
// its own labeled group with its own video and/or photo candidates, rather than one flat pooled
// list.
function renderEvidenceClaims(segIdx) {
  const seg = SEGMENTS[segIdx];
  const container = document.getElementById(`evidence-${segIdx}`);
  if (!container || !seg.evidence) return;
  const claims = seg.evidence.claims || [];
  if (!claims.length) {
    container.innerHTML = `<p class="no-clip-msg">No footage candidates found.</p>`;
    return;
  }
  container.innerHTML = claims.map((claim, claimIdx) => {
    const videoCards = (claim.videoCandidates || []).map((c, i) => claimVideoCardHtml(segIdx, claimIdx, i, c)).join("");
    const photoCards = (claim.photoCandidates || []).map((c, i) => photoCardHtml(segIdx, claimIdx, i, c)).join("");
    const cards = videoCards + photoCards;
    return `
      <div class="claim-group">
        <div class="claim-label">${escapeHtml(claim.claim || "")}</div>
        ${cards ? `<div class="clip-queue">${cards}</div>` : `<p class="no-clip-msg">No candidates found for this claim.</p>`}
      </div>`;
  }).join("");
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

// Same markup/shape as evidenceCardHtml, but a claim-grouped card needs a 3rd coordinate
// (claimIdx) to find its candidate — evidenceCardHtml's onclick is hardcoded to 2 args, so it
// can't be reused directly here. evidenceLabel() (score/reason formatting) still is.
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

// Real photo evidence (Google Custom Search, image mode) for a cumulative/status claim with no
// single filmable instant. Same card shell as the video/stock cards; the "PHOTO" chip is the only
// source distinction shown, same established pattern every other clip-queue in this app uses.
function photoCardHtml(segIdx, claimIdx, photoIdx, photo) {
  const thumbStyle = photo.thumb
    ? `background-image:url('${photo.thumb}'); background-size:cover; background-position:center;`
    : "";
  const label = evidenceLabel(photo);
  return `
    <div class="clip-card" onclick="openPhotoPreview(${segIdx}, ${claimIdx}, ${photoIdx})">
      <div class="clip-thumb" style="${thumbStyle}">
        <span class="src-chip src-photo">${SOURCE_LABEL.photo}</span>
        ${photo.thumb ? "" : PLAY_ICON}
      </div>
      <div class="clip-label">${escapeHtml(photo.title || "")}</div>
      <div class="clip-sub ${label.cls}">${label.text}</div>
    </div>`;
}

// Shared DOM-wiring body for both video preview entry points below — takes an already-resolved
// candidate object, so it doesn't care whether the caller looked it up from a flat candidates
// array (reference beats) or from claims[claimIdx].videoCandidates (evidence beats). Standard
// (non-trimmed) YouTube embed — evidence/reference results are references for the user to watch
// and judge, not files this app hands out. The single action button is an external link, not a
// download.
function renderVideoPreviewModal(cand) {
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
}

function openEvidencePreview(segIdx, candIdx) {
  renderVideoPreviewModal(SEGMENTS[segIdx].evidence.candidates[candIdx]);
  document.getElementById("modal-overlay").classList.add("open");
}

function openClaimVideoPreview(segIdx, claimIdx, candIdx) {
  renderVideoPreviewModal(SEGMENTS[segIdx].evidence.claims[claimIdx].videoCandidates[candIdx]);
  document.getElementById("modal-overlay").classList.add("open");
}

// Real photo evidence preview: never hotlinks the raw third-party image URL into the DOM — only
// Google's own thumbnail CDN (same trust tier the YouTube thumbnail CDN already gets) is ever
// rendered. The primary action is a "View source page" external link, mirroring the video path's
// "link out, don't download" posture. #modal-thumb is otherwise only ever cleared by every other
// preview path (openEvidencePreview/openPreview both hide it in favor of the iframe/video) — this
// is the first path that actually populates it, so it must also fully tear down whatever the
// modal was showing last: a still-playing stock video, and — confirmed live in setupStockTrimRow()
// — a #trim-row left visible from a prior stock preview, since nothing but openEvidencePreview/
// closePreview otherwise hides it again.
function openPhotoPreview(segIdx, claimIdx, photoIdx) {
  const photo = SEGMENTS[segIdx].evidence.claims[claimIdx].photoCandidates[photoIdx];

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
  thumbEl.style.backgroundImage = `url('${photo.thumb}')`;
  thumbEl.style.backgroundSize = "cover";
  thumbEl.style.backgroundPosition = "center";

  document.getElementById("modal-title").textContent = photo.title || "";
  document.getElementById("modal-sub").textContent = `Photo · ${photo.displayLink || ""} · ${evidenceLabel(photo).text}`;

  const actionBtn = document.getElementById("modal-download");
  actionBtn.removeAttribute("download");
  actionBtn.href = photo.sourceLink;
  actionBtn.target = "_blank";
  actionBtn.rel = "noopener";
  actionBtn.innerHTML = `${EXTERNAL_ICON} View source page`;
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
