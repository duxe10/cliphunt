// Cloudflare Pages Function — POST /api/subject-filler-batch
// Batched retrieval for "visualSource":"subject" segments (see segment.js's
// enforceVisualSourceRule) — generic YouTube presence footage of an already-established real
// subject, used instead of anonymous stock for feel/nothing-shaped moments centered on a specific
// person, so the video isn't leaning on stock b-roll as heavily.
//
// Pooled BY DISTINCT SUBJECT, not by segment — deliberate, not an optimization afterthought. A
// script can have many segments about the same one real person; searching each segment's own
// narrow query independently would frequently exhaust that person's real available footage and
// start repeating the same clip across segments — an explicit product requirement this exists to
// avoid: different clips per segment, not the same one over and over. Pooling multiple distinct
// query angles per subject together (each segment's own subjectFillerQuery, naturally varied
// since each comes from that segment's own local context), then distributing unique picks across
// that subject's own segments in script order, gives a genuinely wider real candidate pool to
// draw from before any repeat becomes necessary. It's also cheaper: cost scales with (distinct
// subjects x distinct query angles, capped), not with how many segments reference one subject —
// YouTube's search.list is billed per distinct query, not per segment.
//
// Results are meant to be PERSISTED by the caller once computed (see app.js), not re-fetched on
// every reload the way stock/Pexels is — search.list alone is 100 of the app's 10,000 daily quota
// units (see HANDOFF.md), so re-fetching per reload doesn't scale the way live-refetching stock
// does.
import { searchYouTubeVideos, enrichCandidates, MIN_RERANK_SCORE } from "./evidence-search.js";
import { groqChat } from "./_groq.js";

const MAX_QUERIES_PER_SUBJECT = 5; // bounds search.list cost per distinct SUBJECT, not per segment
const MAX_CLIPS_PER_SEGMENT = 3; // narrower real pool per person than Pexels' broad stock categories

const RERANK_BATCH_PROMPT = `You score how well each YouTube video plausibly shows a real, named
person, PRESENT in a believable context — NOT whether it depicts any one segment's specific claim
literally, since this footage is deliberately generic presence filler, not evidence of a specific
event. You get a list of subjects, each with candidate videos (title, channel, duration, views,
description). Score each subject's candidates independently: does this genuinely look like real,
credible footage of THAT specific person (training, playing, speaking, appearing) — not a
reaction/compilation/lookalike/unrelated video that just happened to match the search text?
Off-subject or clearly unrelated = near 0.

Return strict JSON only, no prose: {"subjects":[{"subject":"...","ranking":[{"videoId":"...","score":0-100,"reason":"<=8 words"}]}]}
Include every candidate exactly once per subject, best first. 0 = unusable, 100 = clearly the subject, plausible context.`;

export async function onRequestPost(context) {
  const { request, env } = context;

  let segments;
  try {
    ({ segments } = await request.json());
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(segments) || !segments.length) {
    return Response.json({ error: "No segments provided" }, { status: 400 });
  }
  if (!env.YOUTUBE_API_KEY) {
    return Response.json({ error: "YOUTUBE_API_KEY is not set on this Cloudflare project" }, { status: 500 });
  }

  // Group by subject — each incoming item is {i, subject, query}: subject =
  // seg.inheritedSubjectForFiller, query = seg.subjectFillerQuery (see app.js).
  const bySubject = new Map();
  segments.forEach((seg, idx) => {
    const subject = (seg.subject || "").trim();
    const query = (seg.query || "").trim();
    if (!subject || !query) return;
    if (!bySubject.has(subject)) bySubject.set(subject, { queries: new Set(), segmentIndices: [] });
    const entry = bySubject.get(subject);
    entry.queries.add(query);
    entry.segmentIndices.push(idx);
  });

  // 1. Fetch: one YouTube search per distinct query, per subject, capped and pooled per subject.
  const poolBySubject = new Map();
  await Promise.all(
    Array.from(bySubject.entries()).map(async ([subject, { queries }]) => {
      const queryList = Array.from(queries).slice(0, MAX_QUERIES_PER_SUBJECT);
      const results = await Promise.all(
        queryList.map(async (q) => {
          try {
            const candidates = await searchYouTubeVideos(q, env.YOUTUBE_API_KEY);
            await enrichCandidates(candidates, env.YOUTUBE_API_KEY);
            return candidates;
          } catch {
            return [];
          }
        })
      );
      // Dedup across this subject's own multiple query angles before pooling.
      const seen = new Set();
      const pooled = [];
      for (const list of results) {
        for (const c of list) {
          if (seen.has(c.videoId)) continue;
          seen.add(c.videoId);
          pooled.push(c);
        }
      }
      poolBySubject.set(subject, pooled);
    })
  );

  // 2. Rerank: ONE combined Groq call for every subject's pooled candidates — never one call per
  //    segment or per subject, same burst-avoidance reasoning as stock-search.js's
  //    rerankStockCandidatesBatch (see its header comment for the crash this pattern avoids).
  const subjectsWithCandidates = Array.from(poolBySubject.entries()).filter(([, c]) => c.length > 1);
  let rankingBySubject = new Map();
  if (subjectsWithCandidates.length && env.GROQ_API_KEY) {
    try {
      const user = subjectsWithCandidates.map(([subject, candidates]) => ({
        subject,
        candidates: candidates.map((c) => ({
          videoId: c.videoId,
          title: c.title,
          channel: c.channel,
          durationSec: c.durationSec ?? null,
          views: c.views ?? null,
          desc: (c.description || "").slice(0, 120),
        })),
      }));
      const res = await groqChat(env, {
        model: "openai/gpt-oss-20b",
        messages: [
          { role: "system", content: RERANK_BATCH_PROMPT },
          { role: "user", content: JSON.stringify(user) },
        ],
        temperature: 0,
      });
      if (res.ok) {
        const data = await res.json();
        const parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}");
        const subs = Array.isArray(parsed.subjects) ? parsed.subjects : [];
        rankingBySubject = new Map(
          subs.map((s) => [s.subject, new Map((Array.isArray(s.ranking) ? s.ranking : []).map((r) => [r.videoId, r]))])
        );
      }
    } catch {
      // best-effort — subjects below fall through to unscored pass-through
    }
  }

  // Apply scores + MIN_RERANK_SCORE filter, sort best-first, per subject.
  for (const [subject, candidates] of poolBySubject.entries()) {
    const ranking = rankingBySubject.get(subject);
    let scored = candidates;
    if (ranking) {
      scored = candidates.map((c) => {
        const r = ranking.get(c.videoId);
        return {
          ...c,
          score: r ? Math.max(0, Math.min(100, Number(r.score) || 0)) : 0,
          reason: r ? String(r.reason || "").slice(0, 60) : "",
        };
      });
      scored = scored.filter((c) => c.score >= MIN_RERANK_SCORE);
    }
    scored.sort((a, b) => (b.score || 0) - (a.score || 0));
    poolBySubject.set(subject, scored);
  }

  // 3. Distribute: walk each subject's own segments in script order, assigning the
  //    LEAST-RECENTLY-USED candidates first (not a plain "unique, else give up and reuse the same
  //    top N" fallback — that would hand every segment past the first exhaustion the identical
  //    fixed slice, exactly the repetition this whole feature exists to avoid). Every segment
  //    always prefers whatever's been used fewest times so far, tie-broken by rerank score — under
  //    a genuinely narrow pool this rotates evenly across segments instead of collapsing onto one
  //    fixed set once uniques run out.
  const resultsByIndex = new Array(segments.length).fill(null);
  for (const [subject, { segmentIndices }] of bySubject.entries()) {
    const pool = poolBySubject.get(subject) || [];
    const usageCount = new Map(pool.map((c) => [c.videoId, 0]));
    for (const idx of segmentIndices) {
      const ranked = [...pool].sort((a, b) => {
        const usageDiff = (usageCount.get(a.videoId) || 0) - (usageCount.get(b.videoId) || 0);
        return usageDiff !== 0 ? usageDiff : (b.score || 0) - (a.score || 0);
      });
      const picked = ranked.slice(0, MAX_CLIPS_PER_SEGMENT);
      picked.forEach((c) => usageCount.set(c.videoId, (usageCount.get(c.videoId) || 0) + 1));
      // source:"youtube" lets app.js's renderHydratedClips() render this through the YouTube-
      // shaped card/preview path (fillerCardHtml/openFillerPreview), not the Pexels-only one.
      resultsByIndex[idx] = picked.map((c) => ({
        ...c,
        source: "youtube",
        url: `https://www.youtube.com/watch?v=${c.videoId}`,
      }));
    }
  }

  return Response.json({ results: resultsByIndex.map((clips, i) => ({ i, clips: clips || [] })) });
}
