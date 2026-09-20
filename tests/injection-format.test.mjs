import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sessionStartBlock, promptBlock, handleOf, estimateTokens, noticeFor} from '../server/injection-format.mjs';

const memory = (id, statement, band = 'said', task_id = null) => ({id, statement, band, task_id});

test('a handle is six stable characters of the id, with no dashes', () => {
  assert.equal(handleOf('0c28d1a4-0000-4000-8000-000000000001'), '0c28d1');
  assert.equal(handleOf('0c28d1a4-0000-4000-8000-000000000001').length, 6);
});

test('session start carries projects and personal memories, split by band', () => {
  const block = sessionStartBlock({
    projects: [{slug: 'satchel', brief: 'Context that follows you'}],
    personal: [memory('aaaaaa11-0000-4000-8000-000000000001', 'No em dashes.'),
               memory('bbbbbb22-0000-4000-8000-000000000002', 'Serif headings.', 'heard')],
  });
  assert.match(block, /^<satchel>\n/);
  assert.match(block, /\n<\/satchel>$/);
  assert.match(block, /personal, confirmed, use freely\n {2}aaaaaa {2}No em dashes\./);
  assert.match(block, /not confirmed, say these out loud[^\n]*\n {2}bbbbbb {2}Serif headings\./);
  assert.match(block, /more exists, search satchel/);
});

test('a band header only appears when that band has rows', () => {
  const onlySaid = sessionStartBlock({personal: [memory('a1000000-0000-4000-8000-000000000001', 'One.')]});
  assert.ok(!onlySaid.includes('not confirmed'), 'no unconfirmed header when nothing is unconfirmed');
  const onlyHeard = sessionStartBlock({personal: [memory('a2000000-0000-4000-8000-000000000002', 'Two.', 'heard')]});
  assert.ok(!onlyHeard.includes('use freely'), 'no confirmed header when nothing is confirmed');
});

test('nothing to say produces nothing, not an empty wrapper', () => {
  assert.equal(sessionStartBlock({}), '');
  assert.equal(promptBlock({rows: []}), '');
});

test('session start never mentions a task, because nothing task-scoped loads there', () => {
  const block = sessionStartBlock({
    projects: [{slug: 'satchel', brief: 'x'}],
    personal: [memory('a3000000-0000-4000-8000-000000000003', 'A rule.', 'said', 'ffffffff-0000-4000-8000-000000000001')],
  });
  assert.ok(!block.includes('closed'), 'no staleness annotation at session start');
  assert.ok(!block.includes('['), 'no task annotation at all');
});

test('the per-prompt block reports shown, matched and in scope', () => {
  const block = promptBlock({
    rows: [memory('0c28d100-0000-4000-8000-000000000001', 'No personas in v1.')],
    matched: 5, inScope: 130,
  });
  assert.match(block, /^◪ retrieved · 1 shown · 5 matched · 130 in scope$/m);
  assert.match(block, /^ {2}0c28d1 {2}No personas in v1\.$/m);
});

test('a closed task is flagged as doubt, an open one is left alone', () => {
  const taskId = 'ffffffff-0000-4000-8000-000000000001';
  const rows = [memory('4d1b7700-0000-4000-8000-000000000002', 'Corner leak on .paper.', 'said', taskId)];
  const closed = promptBlock({rows, matched: 1, inScope: 9,
    tasks: new Map([[taskId, {slug: 'fix-consent-layout', status: 'done', closed_at: '2026-09-20T00:00:00Z'}]])});
  assert.match(closed, /\[fix-consent-layout · closed 2026-09-20, may be fixed\]/);
  const open = promptBlock({rows, matched: 1, inScope: 9,
    tasks: new Map([[taskId, {slug: 'fix-consent-layout', status: 'in_progress', closed_at: null}]])});
  assert.ok(!open.includes('closed'), 'an open task adds nothing');
});

test('statements are flattened and clipped so one long row cannot reshape the block', () => {
  const block = promptBlock({rows: [memory('a4000000-0000-4000-8000-000000000004', 'a\n\nb   c')], matched: 1, inScope: 1});
  assert.match(block, /a b c/);
  const long = promptBlock({rows: [memory('a5000000-0000-4000-8000-000000000005', 'x'.repeat(400))], matched: 1, inScope: 1});
  assert.ok(long.split('\n')[1].length < 320, 'a long statement is clipped');
  assert.match(long, /…/);
});

test('the same input always produces the same bytes, so a preview can be trusted', () => {
  const input = {projects: [{slug: 'a', brief: 'b'}], personal: [memory('a6000000-0000-4000-8000-000000000006', 'c')]};
  assert.equal(sessionStartBlock(input), sessionStartBlock(input));
});

test('the token estimate scales with length and is never zero for real text', () => {
  assert.ok(estimateTokens('hello world') > 0);
  assert.ok(estimateTokens('x'.repeat(380)) > estimateTokens('x'.repeat(38)));
});

test('the notice is plain, singular where it should be, and quiet by default', () => {
  assert.equal(noticeFor('SessionStart', {projects: 1, personal: 1}),
    'Satchel loaded · 1 project, 1 personal memory');
  assert.equal(noticeFor('SessionStart', {projects: 3, personal: 12}),
    'Satchel loaded · 3 projects, 12 personal memories');
  assert.equal(noticeFor('SessionStart', {}), 'Satchel connected · nothing saved yet');

  // A failure always speaks, on every event, because that is the case that was
  // invisible before this existed.
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop'])
    assert.match(noticeFor(event, {error: 'Connection revoked'}), /^Satchel memory unavailable · Connection revoked$/);

  assert.equal(noticeFor('UserPromptSubmit', {shown: 2, matched: 9}), 'Satchel recalled 2 of 9 matching');
  assert.equal(noticeFor('UserPromptSubmit', {shown: 0, matched: 0}), '', 'nothing relevant stays quiet');
  assert.equal(noticeFor('Stop', {captured: 1}), 'Satchel noted 1 thing you said · unconfirmed');
  assert.equal(noticeFor('Stop', {captured: 0}), '', 'most turns capture nothing');

  // Withholding an oversized block is not a failure, but the person still has
  // to know memory did not load.
  assert.equal(noticeFor('SessionStart', {withheld: '18000 tokens over the 15000 budget'}),
    'Satchel memory not loaded · 18000 tokens over the 15000 budget');
});
