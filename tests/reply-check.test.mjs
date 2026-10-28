// The reply check, as a pure function and through the end of a turn.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {checkReply, countWords} from '../server/reply-check.mjs';
import {capture} from '../server/lifecycle.mjs';

const words = n => Array.from({length: n}, () => 'word').join(' ');

test('a short plain reply passes', () => {
  const result = checkReply('Done. The page now shows your name at the top.');
  assert.equal(result.ok, true);
  assert.equal(result.reason, undefined);
});

test('a reply over the limit fails, and the limit is the person’s own', () => {
  const reply = words(120);
  assert.equal(checkReply(reply, {wordLimit: 200}).ok, true);
  const result = checkReply(reply, {wordLimit: 100});
  assert.equal(result.ok, false);
  assert.match(result.reason, /under 100 words/);
  assert.match(result.reason, /^Satchel: rewrite your last reply for a non-engineer/);
});

test('code-looking names fail', () => {
  const cases = {
    'I changed `retrieve` today.': 'backticks',
    'I edited capture.mjs to fix it.': 'file names',
    'The page is Settings.tsx.': 'file names',
    'It lives in src/features/settings/Settings now.': 'paths',
    'See ./notes for more.': 'paths',
    'Run it with --force if it sticks.': 'command flags',
    'It was fixed in commit 7921c44 last week.': 'commit hashes',
  };
  for (const [reply, kind] of Object.entries(cases)) {
    const result = checkReply(reply);
    assert.equal(result.ok, false, reply);
    assert.ok(result.found.includes(kind), `${reply} should be flagged as ${kind}`);
    assert.match(result.reason, /no file or code names/);
  }
});

test('ordinary prose is not mistaken for code', () => {
  for (const reply of [
    'You can do this and/or that, on the client/server side.',
    'It was a defaced wall — and a long one.',
    'Visit https://example.com/docs/page.html for more.',
    'It took 3.5 hours, about 10/12 of the plan.',
    'Wait -- then try again.',
    'It shipped on 28/10/2026.',
  ]) assert.equal(checkReply(reply).ok, true, reply);
});

test('a table counts its words, not its borders', () => {
  assert.equal(countWords('| a | b |\n|---|---|\n| x | y |'), 4);
});

test('a fenced block the person asked for is left alone', () => {
  const block = '```js\nimport foo from "./foo.mjs";\n' + words(400) + '\n```';
  assert.equal(checkReply(block).ok, true, 'a reply that is only a code block passes');
  assert.equal(countWords(block), 0, 'code does not count toward words');
  assert.equal(checkReply(`Here you go.\n\n${block}`).ok, true);
  assert.equal(checkReply(`Here is bar.mjs.\n\n${block}`).ok, false, 'prose around the block is still checked');
  assert.equal(checkReply('Here you go.\n```\nunclosed.mjs').ok, true, 'an unclosed fence runs to the end');
});

test('a reply that is not text passes', () => {
  assert.equal(checkReply('').ok, true);
  assert.equal(checkReply(null).ok, true);
});

// Through capture().

const connected = {label: 'Test', personal: true, can_write: true, topic_ids: []};
const base = {per_prompt_matches: 5, gate: 0.67, scope_boost: 1.1, session_budget_tokens: 15000,
  capture: true, capture_window: 5, capture_mode: 'session', reply_check: true, reply_word_limit: 200};
const service = (settings, recorded) => ({
  status: async () => connected,
  settings: async () => settings,
  activeTopic: async () => null,
  resolveRepository: async () => ({topics: []}),
  recordTurn: async (_key, role, content) => { recorded.push({role, content}); },
});
const bad = 'I edited `capture.mjs` for you.';

test('with the check on, a failing reply comes back as a rewrite and is not recorded', async () => {
  const recorded = [];
  const result = await capture(service(base, recorded), {sessionKey: 's', assistant: bad});
  assert.match(result.rewrite, /^Satchel: rewrite/);
  assert.equal(result.captured, 0);
  assert.deepEqual(recorded, [], 'the reply that was sent back is not the one the person reads');
});

test('a passing reply is recorded as usual and asks for nothing', async () => {
  const recorded = [];
  const result = await capture(service(base, recorded), {sessionKey: 's', assistant: 'All done.'});
  assert.equal(result.rewrite, undefined);
  assert.equal(recorded.length, 1);
});

test('with the check off the same reply is recorded as usual', async () => {
  const recorded = [];
  const result = await capture(service({...base, reply_check: false}, recorded), {sessionKey: 's', assistant: bad});
  assert.equal(result.rewrite, undefined);
  assert.equal(recorded[0].content, bad);
});

test('a rewrite is never asked for twice', async () => {
  const recorded = [];
  const result = await capture(service(base, recorded), {sessionKey: 's', assistant: bad, rewriting: true});
  assert.equal(result.rewrite, undefined);
  assert.equal(recorded[0].content, bad, 'the rewrite is taken as it comes and recorded');
});

test('the check runs even when capture is off, and records nothing either way', async () => {
  const recorded = [];
  const off = {...base, capture: false};
  assert.ok((await capture(service(off, recorded), {sessionKey: 's', assistant: bad})).rewrite);
  assert.equal((await capture(service(off, recorded), {sessionKey: 's', assistant: bad, rewriting: true})).rewrite, undefined);
  assert.deepEqual(recorded, []);
});

test('the capture endpoint accepts and forwards the rewriting flag', () => {
  // The endpoint needs a real token to run, so this reads the one place the
  // allowlist and the hand-off live.
  const source = readFileSync(new URL('../server/hook-handler.mjs', import.meta.url), 'utf8');
  assert.match(source, /'commits'[^\]]*'rewriting'\]/);
  assert.match(source, /rewriting: input\.rewriting === true/);
  assert.match(source, /rewrite: result\.rewrite/);
});
