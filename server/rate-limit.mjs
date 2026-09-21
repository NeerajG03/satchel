// What a 429 actually says, which is the difference between waiting one second
// and waiting until tomorrow.
//
// Both callers used to read a single header, `x-ratelimit-reset`, which Google
// does not send. So every Gemini rate limit fell through to the 500ms floor,
// retried once into the same wall, and surfaced as "gemini-embedding-001
// returned 429". That message is wrong in the expensive direction: it names
// the model, which was never the problem, and hides the quota, which is the
// entire answer.
//
// Measured against the live endpoint on 21 Sep 2026. Google sends no rate
// limit headers at all and puts everything in the body:
//
//   message   "Quota exceeded for metric:
//              generativelanguage.googleapis.com/embed_content_free_tier_requests,
//              limit: 1000, model: gemini-embedding-1.0.
//              Please retry in 9.878146082s."
//   details[] RetryInfo.retryDelay = "9s"
//   details[] QuotaFailure.violations[0].quotaId =
//               "EmbedContentRequestsPerDayPerProjectPerModel-FreeTier"
//             violations[0].quotaValue = "1000"
//
// OpenAI and OpenRouter answer with Retry-After or X-RateLimit-Reset and an
// empty body instead, so all three are read and the longest wait wins.

// An advised wait longer than this is not a wait, it is an outage. Waiting is
// pointless and reporting it as a delay would be a lie about when it recovers.
const TOO_LONG_MS = 60 * 60 * 1000;

function fromHeaders(response) {
  const get = name => response?.headers?.get?.(name);
  const after = get('retry-after');
  if (after) {
    // Retry-After is either a count of seconds or an HTTP date. Both are in
    // live use, and Number() on a date string is NaN rather than an error, so
    // taking the first without checking silently means no wait at all.
    const seconds = Number(after);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    const when = Date.parse(after);
    if (Number.isFinite(when)) return when - Date.now();
  }
  const reset = Number(get('x-ratelimit-reset'));
  // Epoch milliseconds if it is large enough to be one, otherwise a duration
  // in seconds. OpenRouter sends the first, several gateways send the second,
  // and reading one as the other is a 50 year wait or a 50ms one.
  if (Number.isFinite(reset) && reset > 0) return reset > 1e11 ? reset - Date.now() : reset * 1000;
  return 0;
}

function fromBody(body) {
  const detail = body?.error?.details?.find(d => String(d?.['@type'] ?? '').endsWith('RetryInfo'));
  const stated = Number(String(detail?.retryDelay ?? '').replace(/s$/, ''));
  // RetryInfo is rounded down to a whole second and the sentence is not, so
  // trusting the structured field alone retries up to a second early and earns
  // a second 429. Both are read and the longer one is used.
  const said = Number(String(body?.error?.message ?? '').match(/retry in ([\d.]+)\s*s/i)?.[1]);
  return Math.max(Number.isFinite(stated) ? stated * 1000 : 0, Number.isFinite(said) ? said * 1000 : 0);
}

/** Reads a 429 into the two things a caller has to decide with: how long to
 *  wait, and whether waiting can work at all. */
export function readRateLimit(response, body) {
  const advised = Math.max(fromHeaders(response), fromBody(body));
  const violation = body?.error?.details
    ?.find(d => String(d?.['@type'] ?? '').endsWith('QuotaFailure'))?.violations?.[0];
  const quota = String(violation?.quotaId ?? violation?.quotaMetric ?? '');
  const limit = violation?.quotaValue ? ` (${violation.quotaValue} requests)` : '';
  // A per-day quota is the one worth saying out loud, because every "wait a
  // moment and retry" answer is wrong for it. Google keeps answering a spent
  // daily quota with a ten second retryDelay, which reads exactly like a burst
  // limit and is not one: it is the bucket refilling at 1000 a day, so the
  // retry succeeds, the next call fails again, and retrieval looks flaky
  // rather than out of quota.
  const spent = /per[_-]?day|requests[_-]?per[_-]?day/i.test(quota);
  return {
    retryAfterMs: advised > 0 && advised < TOO_LONG_MS ? Math.ceil(advised) : 0,
    quota,
    spent,
    reason: spent ? `the day's free quota is used up${limit}`
      : quota ? `a rate limit was hit${limit}`
      : 'the service is rate limiting us',
  };
}

/** Reads a failed response once, without assuming it is JSON. A 429 body is
 *  the only place Google puts the reason, and `response.json()` on an HTML
 *  error page throws away the status along with the page. */
export async function readFailure(response) {
  if (typeof response?.text !== 'function') return null;
  const text = await response.text().catch(() => '');
  try { return JSON.parse(text); } catch { return null; }
}
