// A stand-in for the memory service, so the real injection code in
// server/lifecycle.mjs can run on a frozen copy of the data.
//
// Everything that decides what reaches the agent runs as it ships: the prompt
// classifier, scope resolution, both block formats, the skip list. Only the
// database is replaced, and only search_memories needed rewriting, because it
// is the one place the ranking lives in SQL. `search` below is that function
// line for line, and parity.mjs in the injection-review skill replays the last
// week of production rows through it before a run is trusted. A copy of a
// ranking that has drifted measures nothing, and nothing else would notice.
//
// Pure apart from the vectors it is handed. No network, no model.

/** Cosine similarity, what `1 - (a <=> b)` is in pgvector. `search` rounds it
 *  to float4, which is what `real` holds: two scores that tie in Postgres must
 *  tie here, or the `id` tiebreak picks differently. */
export function similarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// Compared as instants. The database writes `2026-10-05 08:00:00+00` and a
// transcript `2026-10-05T06:00:00Z`; as strings a space sorts before `T`, so
// every same-day comparison came out wrong.
const time = value => value == null ? null : Date.parse(String(value).replace(' ', 'T').replace(/(:\d\d(?:\.\d+)?)([+-]\d\d)$/, '$1$2:00'));
const live = (m, at) => {
  const now = time(at);
  return (!m.ended_at || time(m.ended_at) > now) && (!m.expires_at || time(m.expires_at) > now)
    && (!m.created_at || time(m.created_at) <= now);
};
export {time};
// Postgres puts NULLs first in a descending sort.
const desc = (a, b) => a == null ? (b == null ? 0 : -1) : b == null ? 1 : time(b) - time(a);

/** search_memories, from supabase/migrations/20261009090000_topics_everywhere.sql. */
export function search(memories, vectors, query, {in_scope = null, limit = 5, gate = 0.67, boost = 1.1,
  exclude = [], at = new Date().toISOString()} = {}) {
  const excluded = new Set(exclude);
  const visible = [];
  for (const m of memories) {
    const vector = vectors[m.id];
    if (!vector || !live(m, at) || excluded.has(m.id)) continue;
    const score = Math.fround(Math.fround(similarity(vector, query))
      * (in_scope && m.topic_id === in_scope ? Math.fround(boost) : 1));
    visible.push({...m, score});
  }
  const floor = Math.fround(gate);
  const matched = visible.filter(v => v.score >= floor).length;
  return visible.filter(v => v.score >= floor)
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, Math.max(limit ?? 5, 0))
    .map(v => ({id: v.id, topic_id: v.topic_id, statement: v.statement, band: v.band, kind: v.kind,
      anchor_repository: v.anchor_repository ?? null, commits_since: v.commits_since ?? null,
      score: v.score, matched, in_scope: visible.length}));
}

/** personal_memories(): unscoped, live, most said first. */
export function personal(memories, at) {
  return memories.filter(m => m.topic_id == null && live(m, at))
    .sort((a, b) => (b.mentions ?? 1) - (a.mentions ?? 1)
      || desc(a.affirmed_at, b.affirmed_at)
      || desc(a.updated_at, b.updated_at)
      || (a.id < b.id ? -1 : 1));
}

/** The service one session sees. `queryVector` turns prompt text into the
 *  cached vector production would have made for it; a prompt with no cached
 *  vector throws, because searching for nothing is the silent failure the
 *  real service once had. */
export function replayService({snapshot, vectors, queryVector, at = snapshot.taken_at}) {
  const state = {active: null};
  const log = [];
  const topics = [...snapshot.topics].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const byId = new Map(topics.map(t => [t.id, t]));
  return {
    state, log,
    status: async () => ({personal: true, all_topics: true}),
    settings: async () => ({...snapshot.settings}),
    activeTopic: async () => state.active,
    // resolve_agent_repository: one candidate is selected when asked to, two or
    // more never are.
    resolveRepository: async (_session, provider, repository, select = true) => {
      const ids = snapshot.links.filter(l => l.provider === provider && l.repository === String(repository).toLowerCase().trim())
        .map(l => l.topic_id).filter(id => byId.has(id));
      if (!ids.length) return [];
      const chosen = select && ids.length === 1 ? ids[0] : null;
      if (chosen) state.active = chosen;
      return topics.filter(t => ids.includes(t.id))
        .map(t => ({topic_id: t.id, slug: t.slug, name: t.name, brief: t.brief, selected: t.id === chosen}));
    },
    topics: async () => topics,
    personal: async () => personal(snapshot.memories, at),
    index: async topicId => ({memories: snapshot.memories.filter(m => m.topic_id === topicId && live(m, at))}),
    search: async args => search(snapshot.memories, vectors, await queryVector(args.query), {...args, at}),
    recordTurn: async () => {},
    logInjection: entry => { log.push(entry); },
  };
}
