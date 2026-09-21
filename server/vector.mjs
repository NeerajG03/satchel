// Two pure functions about how a memory is turned into a row.
//
// They lived at the bottom of embedding.mjs, which imports `ai`. memory-service
// needs only these two, so every endpoint that touches the service was loading
// the Vercel AI SDK to join two strings and format an array.
//
// That is the same trap identity.mjs was carved out to fix: /api/hook-index
// runs inside a hook timeout when a session opens, and it reached `ai` through
// exactly this chain. tests/endpoint-imports.test.mjs caught it.
//
// Nothing here may import anything.

/** What gets indexed. Measured: statement plus source beats statement alone,
 *  and prefixing the project name is worse than either. See
 *  docs/memory-v2-build.md section 4.10. */
export const indexedText = memory =>
  memory.source?.trim() ? `${memory.statement} ${memory.source}` : memory.statement;

/** Postgres accepts a vector literal as a bracketed list of numbers. */
export const toVectorLiteral = vector => `[${vector.join(',')}]`;
