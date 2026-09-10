// Bound the entire request, including any wait for the auth client's lock.
// Abort alone is insufficient if a request has not reached fetch yet.
export async function requestWithTimeout(request, timeoutMs = 15000) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = Object.assign(new Error('Request timed out'), { code: 'SATCHEL_TIMEOUT' });
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([request(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
