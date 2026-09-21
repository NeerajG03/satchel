// The two endpoints the hook scripts call.
//
// They are on the open internet behind a bearer token, and the script that
// calls them is ours, so the temptation is to trust what arrives. That is not a
// validation. Everything below is about what happens when the body is not what
// our own script would have sent.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseHookBody} from '../server/hook-handler.mjs';

test('the body is bounded twice, because a parsed object is not a content length', () => {
  // Vercel hands over already-parsed JSON, so Content-Length is not a
  // sufficient size control on its own. parseRepositoryHint learned this the
  // hard way and this is the same lesson.
  const allowed = new Set(['session_key', 'messages']);
  assert.deepEqual(parseHookBody({session_key: 's'}, allowed), {session_key: 's'});
  assert.deepEqual(parseHookBody('{"session_key":"s"}', allowed), {session_key: 's'});

  assert.throws(() => parseHookBody({session_key: 's', evil: 1}, allowed), /Invalid/,
    'a field nobody asked for is a field nobody has to handle');
  assert.throws(() => parseHookBody([1, 2, 3], allowed), /Invalid/);
  assert.throws(() => parseHookBody(null, allowed), /Invalid/);
  assert.throws(() => parseHookBody({session_key: 'x'.repeat(300000)}, allowed), /Too large/);
  assert.throws(() => parseHookBody('{"session_key":"' + 'x'.repeat(300000) + '"}', allowed), /Too large/);
});
