// One network read that cannot hang the review. Every call this skill makes
// is a read, so trying again is safe.
//
// A stuck read held collect.mjs for 47 minutes on 2 October, then died with
// ETIMEDOUT. Each try now has a deadline, covering the body as well as the
// headers, and a failed try is repeated a few times before it is reported.
//
// Plain node, no packages: this runs from a git archive with no node_modules.

const sleep = ms => new Promise(done => setTimeout(done, ms));

/** The host alone. A URL can carry a query, and the error is printed. */
const hostOf = url => { try { return new URL(url).host; } catch { return 'the server'; } };

/**
 * Fetch and read the whole body, retrying a timeout, a reset or a 5xx.
 * A 4xx answer is returned at once, it will not change on a second ask.
 * Resolves to {ok, status, text}.
 */
export async function fetchText(url, options = {}, {timeoutMs = 30_000, tries = 4, waitMs = 1000} = {}) {
  let last;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, {...options, signal: AbortSignal.timeout(timeoutMs)});
      const text = await res.text();
      if (res.status < 500) return {ok: res.ok, status: res.status, text};
      last = new Error(`answered ${res.status}`);
    } catch (error) {
      last = error;
    }
    if (attempt < tries) await sleep(waitMs * 2 ** (attempt - 1));
  }
  const why = last?.cause?.code ?? last?.name ?? 'error';
  throw new Error(`${hostOf(url)} did not answer after ${tries} tries (${why}: ${last?.message ?? last})`);
}
