// ClipHunt frontend. Data layer is REAL projects in localStorage — no mock/demo data.
// A "project" is what new-project.html creates from a script:
//   { id, title, segments, createdAt, updatedAt }
// `segments` are the raw {text, family, query} objects straight from the Groq segment
// function. Display fields (timestamps, durations) and clips are derived fresh on load —
// clips are hydrated live from Giphy each time rather than persisted, so results stay
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
const SOURCE_LABEL = { youtube: "YT", giphy: "GIF", tenor: "TNR" };
const READING_WORDS_PER_SEC = 2.5; // ~150wpm, dumb estimate — no real audio/pause detection yet

const PLAY_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;

let CURRENT_PROJECT = null;
let SEGMENTS = [];

// The evidence backend worker's base URL (yt-dlp/ffmpeg service — see worker/). Not a secret;
// fetched once from the /config function so it isn't hardcoded here. Guarded by HMAC, not URL.
let WORKER_URL = null;
let WORKER_URL_LOADED = false;
async function ensureWorkerUrl() {
  if (WORKER_URL_LOADED) return WORKER_URL;
  try {
    const res = await fetch("/api/config");
    const data = await res.json();
    WORKER_URL = (data.workerUrl || "").replace(/\/$/, "") || null;
  } catch {
    WORKER_URL = null;
  }
  WORKER_URL_LOADED = true;
  return WORKER_URL;
}

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

// Families with a real search wired up. "evidence" (real footage of a real person/thing)
// needs YouTube + transcript matching, which isn't built yet — stays a placeholder.
const SEARCHABLE_FAMILIES = ["feel", "reference"];

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
  // Evidence is user-triggered (real footage costs a YouTube search + a caption fetch), so it
  // gets a "Find footage" button rather than auto-hydrating like feel/reference on load.
  const isEvidence = !isEmpty && seg.family === "evidence";

  let body;
  if (isEmpty) {
    body = `<p class="no-clip-msg">Pacing beat — no clip needed here.</p>`;
  } else if (needsSearch) {
    body = `<div class="clip-queue" id="clipqueue-${seg.idx}"><p class="no-clip-msg">Searching for clips…</p></div>`;
  } else if (isEvidence) {
    body = `
      <div class="evidence-block" id="evidence-${seg.idx}">
        <button class="btn btn-primary btn-find-footage" onclick="findFootage(${seg.idx})">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/></svg>
          Find footage
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

// Fires real Giphy searches for feel/reference segments after the initial render,
// then swaps each segment's "Searching…" placeholder for real results in place.
async function hydrateClips() {
  const targets = SEGMENTS.filter(s => s.clips === null && SEARCHABLE_FAMILIES.includes(s.family));

  await Promise.all(targets.map(async (seg) => {
    try {
      const res = await fetch("/api/find-clips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: seg.query || seg.text }),
      });
      const data = await res.json();
      seg.clips = res.ok ? data.clips : [];
    } catch {
      seg.clips = [];
    }
  }));

  // Cross-segment dedup: with a wider pool per segment, greedily assign non-duplicate
  // gifs in segment order so the same clip doesn't get reused across scenes. If a segment
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
  return `
    <div class="clip-card" onclick="openPreview(${segIdx}, ${clipIdx})">
      <div class="clip-thumb" style="${thumbStyle}">
        <span class="src-chip src-${clip.source}">${SOURCE_LABEL[clip.source] || clip.source}</span>
        ${icon}
      </div>
      <div class="clip-label">${escapeHtml(clip.title || clip.label || "")}</div>
    </div>
  `;
}

const DL_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5M4 20h16"/></svg>`;

// ── Evidence footage (workspace.html) ───────────────────────────────────────
// User clicks "Find footage" on an evidence beat: evidence-search returns YouTube candidates
// plus a signed authorization, then the worker caption-matches the quote → timestamps + signed
// download URLs. Results are cached in memory on the segment so re-preview doesn't re-search.
async function findFootage(segIdx) {
  const seg = SEGMENTS[segIdx];
  const container = document.getElementById(`evidence-${segIdx}`);
  if (!container) return;
  container.innerHTML = `<p class="no-clip-msg">Searching YouTube for real footage…</p>`;

  const workerUrl = await ensureWorkerUrl();
  if (!workerUrl) {
    container.innerHTML = `<p class="no-clip-msg">Footage backend isn't configured (WORKER_URL missing).</p>`;
    return;
  }

  try {
    const context = (CURRENT_PROJECT.segments || []).map(s => s.text).join(" ");
    const searchRes = await fetch("/api/evidence-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ segmentText: seg.text, context }),
    });
    const search = await searchRes.json();
    if (!searchRes.ok) throw new Error(search.error || "Search failed");
    if (!search.candidates || !search.candidates.length) {
      container.innerHTML = `<p class="no-clip-msg">No footage candidates found for this moment.</p>`;
      return;
    }

    container.innerHTML = `<p class="no-clip-msg">Waking the clip server &amp; matching the quote… (first run can take ~30s)</p>`;

    const matchRes = await fetch(`${workerUrl}/match`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoIds: search.candidates.map(c => c.videoId),
        quote: search.quote,
        exp: search.exp,
        sig: search.matchSig,
      }),
    });
    const match = await matchRes.json();
    if (!matchRes.ok) throw new Error(match.error || "Matching failed");

    // Merge search metadata (title/thumb/channel) with worker results (timestamps/urls) by id,
    // preserving the worker's score order.
    const byId = {};
    search.candidates.forEach(c => { byId[c.videoId] = c; });
    const results = (match.results || []).map(r => ({ ...(byId[r.videoId] || {}), ...r }));

    seg.evidence = { quote: search.quote, footageType: search.footageType, results };
    renderEvidence(segIdx);
  } catch (err) {
    container.innerHTML = `<p class="no-clip-msg">Couldn't find footage: ${escapeHtml(err.message)}</p>`;
  }
}

function renderEvidence(segIdx) {
  const seg = SEGMENTS[segIdx];
  const container = document.getElementById(`evidence-${segIdx}`);
  if (!container || !seg.evidence) return;
  const { results } = seg.evidence;
  container.innerHTML = results.length
    ? `<div class="clip-queue">${results.map((r, i) => evidenceCardHtml(segIdx, i, r)).join("")}</div>`
    : `<p class="no-clip-msg">No footage candidates found.</p>`;
}

// Honest one-liner for a candidate, driven by the worker's `reason`, so a beat with no spoken
// line reads as "general footage" rather than a scary "couldn't verify."
function evidenceLabel(cand) {
  if (cand.matched) {
    return { text: `matched ${formatTime(cand.start)} · ${Math.round((cand.score || 0) * 100)}%`, cls: "ev-ok" };
  }
  switch (cand.reason) {
    case "no_captions": return { text: "no captions to verify", cls: "ev-warn" };
    case "low_score": return { text: "exact line not found", cls: "ev-warn" };
    case "no_quote":
    default: return { text: "general footage", cls: "ev-warn" };
  }
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

// Preview plays ONLY the matched excerpt via a YouTube embed (from the start when unverified),
// so the user hears the moment, not a 30-minute source. Download buttons are contextual: the
// trimmed excerpt (when matched) plus the full video; full-only when no confident match.
function openEvidencePreview(segIdx, candIdx) {
  const cand = SEGMENTS[segIdx].evidence.results[candIdx];

  const startParam = cand.matched ? Math.max(0, Math.floor(cand.start)) : 0;
  const endParam = cand.matched ? Math.ceil(cand.end) : 0;
  const embed = `https://www.youtube.com/embed/${cand.videoId}?autoplay=1&start=${startParam}${endParam ? `&end=${endParam}` : ""}`;

  const thumbEl = document.getElementById("modal-thumb");
  thumbEl.style.backgroundImage = "";
  document.getElementById("modal-play").style.display = "none";
  const iframe = document.getElementById("modal-iframe");
  iframe.src = embed;
  iframe.style.display = "block";

  document.getElementById("modal-title").textContent = cand.title || "";
  document.getElementById("modal-sub").textContent = cand.matched
    ? `YouTube · ${cand.channel || ""} · matched “${cand.snippet}”`
    : `YouTube · ${cand.channel || ""} · ${evidenceLabel(cand).text}`;

  const dlExcerpt = document.getElementById("modal-download");
  const dlFull = document.getElementById("modal-download-full");
  if (cand.excerptUrl) {
    dlExcerpt.href = cand.excerptUrl;
    dlExcerpt.innerHTML = `${DL_ICON} Download clip (${cand.excerptSec}s)`;
    dlExcerpt.style.display = "";
    dlFull.href = cand.fullUrl;
    dlFull.innerHTML = `${DL_ICON} Download full video`;
    dlFull.style.display = "";
  } else {
    // No confident trim → a single "Download full video" as the primary action.
    dlExcerpt.href = cand.fullUrl;
    dlExcerpt.innerHTML = `${DL_ICON} Download full video`;
    dlExcerpt.style.display = "";
    dlFull.style.display = "none";
  }

  document.getElementById("modal-overlay").classList.add("open");
}

function openPreview(segIdx, clipIdx) {
  const seg = SEGMENTS[segIdx];
  const clip = seg.clips[clipIdx];

  // Reset any evidence-preview state (iframe) so the gif path renders cleanly.
  const iframe = document.getElementById("modal-iframe");
  iframe.src = "";
  iframe.style.display = "none";
  document.getElementById("modal-play").style.display = "";
  document.getElementById("modal-download-full").style.display = "none";

  const thumbEl = document.getElementById("modal-thumb");
  thumbEl.style.backgroundImage = clip.url ? `url('${clip.url}')` : "";
  thumbEl.style.backgroundSize = "contain";
  thumbEl.style.backgroundRepeat = "no-repeat";
  thumbEl.style.backgroundPosition = "center";
  document.getElementById("modal-title").textContent = clip.title || clip.label || "";
  document.getElementById("modal-sub").textContent = `${clip.source} · matched to scene ${String(segIdx).padStart(2, "0")}`;

  const downloadBtn = document.getElementById("modal-download");
  if (clip.url) {
    downloadBtn.href = clip.url;
    downloadBtn.innerHTML = `${DL_ICON} Download`;
    downloadBtn.style.display = "";
  } else {
    downloadBtn.style.display = "none";
  }

  document.getElementById("modal-overlay").classList.add("open");
}

function closePreview() {
  document.getElementById("modal-overlay").classList.remove("open");
  const thumbEl = document.getElementById("modal-thumb");
  thumbEl.style.backgroundImage = "";
  // Stop excerpt playback when closing (clearing src halts the YouTube embed).
  const iframe = document.getElementById("modal-iframe");
  iframe.src = "";
  iframe.style.display = "none";
}

// One script serves all pages; dispatch by which page's root element is present.
document.addEventListener("DOMContentLoaded", () => {
  if (document.getElementById("segments")) renderWorkspace();
  else if (document.getElementById("project-grid")) renderDashboard();
});
