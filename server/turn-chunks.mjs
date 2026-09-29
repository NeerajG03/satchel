/** The most characters one call is sent. Nothing inside a turn is ever cut:
 *  a longer session is read in several calls instead, split between turns. */
export const CHUNK_CHARACTERS = 240_000;

/** The turns that go in one call: as many from the front as fit, and always at
 *  least one, so a single turn longer than the budget still goes in whole. */
export function firstChunk(turns, budget = CHUNK_CHARACTERS) {
  let used = 0;
  let count = 0;
  for (const turn of turns) {
    const size = String(turn.content ?? '').length;
    if (count && used + size > budget) break;
    used += size;
    count += 1;
  }
  return turns.slice(0, count);
}
