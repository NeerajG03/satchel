import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestWithTimeout } from '../src/request.mjs';

test('an auth wait that ignores abort still releases the editor with a timeout', async () => {
  let signal;
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const request = value => { signal = value; return pending; };
  await assert.rejects(requestWithTimeout(request, 10), { code: 'SATCHEL_TIMEOUT' });
  assert.equal(signal.aborted, true);
  // A late response cannot change the already-settled result.
  finish({ data: 'late write acknowledgement' });
});

test('successful and failed responses remain intact', async () => {
  const result = { data: { revision: 2 }, error: null };
  assert.equal(await requestWithTimeout(() => Promise.resolve(result)), result);
  const failure = new Error('network unavailable');
  await assert.rejects(requestWithTimeout(() => Promise.reject(failure)), error => error === failure);
});
