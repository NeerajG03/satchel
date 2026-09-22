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
  // Counted, never printed. A heard memory was written without anyone asking,
  // and a personal one loads in every session forever, so one bad capture is
  // permanent context pollution rather than one bad row.
  assert.ok(!block.includes('Serif headings'), 'an unconfirmed memory must not reach the model');
  assert.match(block, /1 unconfirmed memory not loaded/);
  assert.match(block, /more exists, search satchel/);
});

test('a band header only appears when that band has rows', () => {
  const onlySaid = sessionStartBlock({personal: [memory('a1000000-0000-4000-8000-000000000001', 'One.')]});
  assert.ok(!onlySaid.includes('unconfirmed'), 'no unconfirmed line when nothing is unconfirmed');
  const onlyHeard = sessionStartBlock({personal: [memory('a2000000-0000-4000-8000-000000000002', 'Two.', 'heard')]});
  assert.ok(!onlyHeard.includes('use freely'), 'no confirmed header when nothing is confirmed');
  assert.ok(!onlyHeard.includes('Two.'), 'and still nothing unconfirmed in the text');
  assert.match(onlyHeard, /1 unconfirmed memory not loaded/);
});

test('the person is told how many memories are being held back', () => {
  // The one place it is said. Nothing unconfirmed reaches the agent now, so
  // without this line a bad capture is invisible to everyone and stays.
  assert.match(noticeFor('SessionStart', {projects: 1, personal: 2, unconfirmed: 3}),
    /Satchel loaded · 1 project, 2 personal memories · 3 unconfirmed not loaded/);
  assert.match(noticeFor('SessionStart', {projects: 1, personal: 2}),
    /Satchel loaded · 1 project, 2 personal memories$/);
  assert.match(noticeFor('SessionStart', {unconfirmed: 1}), /0 personal memories · 1 unconfirmed not loaded/);
});

test('nothing to say produces nothing, not an empty wrapper', () => {
  assert.equal(sessionStartBlock({}), '');
});

test('only the projects this codebase belongs to are listed, the rest are counted', () => {
  // A flat list of every project reads as though they all bear on the work in
  // front of you. Sitting in cbx1/backend and being shown `satchel` beside the
  // two projects actually linked there is three equal-looking options, two of
  // which are right.
  const projects = [
    {id: 'p1', slug: 'data-model-2-0', brief: 'DM2.0'},
    {id: 'p2', slug: 'email-self-serve', brief: 'CBX1 email'},
    {id: 'p3', slug: 'satchel', brief: 'Memory'},
  ];
  const here = sessionStartBlock({projects, linked: ['p1', 'p2']});
  assert.match(here, /^projects in this codebase$/m);
  assert.match(here, /data-model-2-0/);
  assert.match(here, /email-self-serve/);
  assert.doesNotMatch(here, /satchel {2,}Memory/, 'an unlinked project is not listed');
  // Counted, not hidden: it stays discoverable without implying relevance.
  assert.match(here, /1 other project not linked to this codebase, by name from list_projects/);

  assert.match(sessionStartBlock({projects, linked: ['p3']}),
    /2 other projects not linked to this codebase/, 'and it pluralises');

  // Every project linked here means there is no "other" line at all.
  assert.doesNotMatch(sessionStartBlock({projects, linked: ['p1', 'p2', 'p3']}), /other project/);
});

test('an unlinked workspace still sees every project, because there is nothing to filter by', () => {
  // Non-Git and unlinked workspaces are ordinary. Hiding projects there would
  // leave the agent knowing about none of them.
  const projects = [{id: 'p1', slug: 'a', brief: 'x'}, {id: 'p2', slug: 'b', brief: 'y'}];
  const block = sessionStartBlock({projects, linked: []});
  assert.match(block, /^projects$/m, 'not "in this codebase", because it is not');
  assert.match(block, /^ {2}a {2}x$/m);
  assert.match(block, /^ {2}b {2}y$/m);
  assert.doesNotMatch(block, /other project/);
});

test('session start never mentions a task, because nothing task-scoped loads there', () => {
  const block = sessionStartBlock({
    projects: [{slug: 'satchel', brief: 'x'}],
    personal: [memory('a3000000-0000-4000-8000-000000000003', 'A rule.', 'said', 'ffffffff-0000-4000-8000-000000000001')],
  });
  assert.ok(!block.includes('closed'), 'no staleness annotation at session start');
  assert.ok(!block.includes('['), 'no task annotation at all');
});

test('statements are flattened and clipped so one long row cannot reshape the block', () => {
  const block = sessionStartBlock({personal: [memory('a4000000-0000-4000-8000-000000000004', 'a\n\nb   c')]});
  assert.match(block, /a b c/);
  const long = sessionStartBlock({personal: [memory('a5000000-0000-4000-8000-000000000005', 'x'.repeat(400))]});
  assert.ok(long.split('\n').find(line => line.includes('x')).length < 320, 'a long statement is clipped');
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
  for (const event of ['SessionStart', 'PostCompact', 'Stop'])
    assert.match(noticeFor(event, {error: 'Connection revoked'}), /^Satchel memory unavailable · Connection revoked$/);

  assert.equal(noticeFor('Stop', {captured: 1}), 'Satchel noted 1 thing you said · unconfirmed');
  assert.equal(noticeFor('Stop', {captured: 0}), '', 'most turns capture nothing');

  // Withholding an oversized block is not a failure, but the person still has
  // to know memory did not load.
  assert.equal(noticeFor('SessionStart', {withheld: '18000 tokens over the 15000 budget'}),
    'Satchel memory not loaded · 18000 tokens over the 15000 budget');
});

test('the block is bounded, and what falls past it is findable rather than gone', () => {
  // A set that loads whole has to be small. Nothing past the cap is ended or
  // hidden: it stays live and stays searchable, and a rule is not wrong for
  // being old.
  const many = Array.from({length: 8}, (_, i) =>
    memory(`aaaaaa${i}0-0000-4000-8000-00000000000${i}`, `Claim ${i}.`));
  const block = sessionStartBlock({personal: many, cap: 3});
  assert.equal((block.match(/Claim \d\./g) ?? []).length, 3, 'only the top of the ranking loads');
  assert.match(block, /Claim 0\./, 'and it is the top, in the order the database ranked them');
  assert.doesNotMatch(block, /Claim 7\./);
  assert.match(block, /5 older memories past the block, search satchel for them/);
  assert.doesNotMatch(sessionStartBlock({personal: many.slice(0, 2), cap: 3}), /past the block/);
});

test('a memory whose repository moved is flagged, and nothing more than flagged', () => {
  // The doubt the task link was supposed to raise, raised by the thing that
  // actually falsifies a memory. A merge is a reason to check a claim, never
  // a reason to know it is wrong, so this is a marker and not a removal.
  const rows = [
    {id: 'aaaaaa11-0000-4000-8000-000000000001', statement: 'The hook reads the transcript.',
     anchor_repository: 'acme/ledger', commits_since: 140, matched: 2, in_scope: 9},
    {id: 'bbbbbb22-0000-4000-8000-000000000002', statement: 'Deploys are on Tuesdays.',
     anchor_repository: 'acme/ledger', commits_since: 3, matched: 2, in_scope: 9},
  ];
  const block = promptBlock({rows, matched: 2, inScope: 9, churn: 25});
  assert.match(block, /The hook reads the transcript\.\n {10}\[acme\/ledger has moved 140 commits since this was confirmed/);
  assert.doesNotMatch(block, /Deploys are on Tuesdays\.\n {10}\[/, 'three commits is not a reason to doubt anything');
  assert.match(block, /Deploys are on Tuesdays\./, 'and it is still injected');
  assert.doesNotMatch(promptBlock({rows, matched: 2, inScope: 9, churn: 500}), /has moved/,
    'the threshold is a setting, not a constant');
});
