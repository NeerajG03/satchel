// The review's "said again" count, on two made-up runs small enough to count by hand.
// Nothing here touches the database: the pure parts are imported and fed fixtures.
// The following.json and folder tests use a temporary folder of their own.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseRun, byWeek, render, readMarks, applyMarks, mergeMarks, weekOf, windowStart, firstStarts, sessionsByWeek,
  followingWeeks, followingLine, upsertFollowing, readFollowing, writeFollowing, earlierFolder} from '../.claude/skills/daily-improvement/scripts/said-again.mjs';

const RULE = 'Keep a plan to one page with a picture before any code.';
const head = [
  'today is 2026-10-14. this conversation happened on 2026-10-14', '',
  'this conversation', '  topic  none linked', '',
  'memories that already exist. Use the number to change one',
  '  #1  [fact, ledger, last on 2026-10-01]  Invoices go out on the first of the month.',
  `  #2  [preference, personal, said 4 times, made on 2026-09-23, last on 2026-10-12]  ${RULE}`,
  '  #3  [intent, personal, last on 2026-10-10]  Try the new test runner next week.', '',
].join('\n');

// Run A: the model affirmed #2 twice and added one thing. The run row counted 2.
const runA = {id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', created_at: '2026-10-14T21:00:00Z', affirmed: 2,
  session_key: 'session-a', prompt: head, response: JSON.stringify({changes: [
    {action: 'affirm', target: 2, statement: '', source: 'keep the plan short, one picture', kind: 'preference', topic: null, expires: null, why: 'said again'},
    {action: 'add', target: null, statement: 'Deploys go out on Tuesday.', source: 'we deploy tuesdays', kind: 'fact', topic: 'ledger', expires: null, why: 'new'},
    {action: 'affirm', target: 2, statement: '', source: 'too long again, one page please', kind: 'preference', topic: null, expires: null, why: 'said again'},
  ]})};
// Run B: the twin check affirmed something, so the row counted 1 and the response names nothing.
const runB = {id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', created_at: '2026-10-07T21:00:00Z', affirmed: 1,
  session_key: 'session-b', prompt: head, response: JSON.stringify({changes: []})};

const MEMORY = '12345678-abcd-4abc-8abc-123456789abc';
const keyed = affirms => affirms.map(a => ({...a, id: a.statement === RULE ? MEMORY : null, key: a.statement === RULE ? MEMORY : a.statement}));

test('an affirm joins its #n to the statement, and a made on field in the bracket does not break the parse', () => {
  const a = parseRun(runA);
  assert.equal(a.affirms.length, 2);
  assert.equal(a.affirms[0].statement, RULE);
  assert.equal(a.affirms[0].kind, 'preference');
  assert.equal(a.affirms[0].scope, 'personal');
  assert.equal(a.affirms[0].mentionsThen, 4);
  assert.equal(a.affirms[0].source, 'keep the plan short, one picture');
  assert.equal(a.missing, 0);
  assert.equal(a.expired, false);
});

test('a run that counted an affirm the response does not name shows it as missing', () => {
  const b = parseRun(runB);
  assert.equal(b.affirms.length, 0);
  assert.equal(b.missing, 1);
  const blanked = parseRun({...runB, prompt: '(expired)', response: null});
  assert.equal(blanked.expired, true);
  assert.equal(blanked.affirms.length, 0);
});

test('affirms are counted per rule per week', () => {
  assert.equal(weekOf('2026-10-14T21:00:00Z'), '2026-10-12');
  const weeks = byWeek(keyed([...parseRun(runA).affirms, ...parseRun(runB).affirms]));
  assert.equal(weeks.length, 1, 'run B had nothing in its response, so only run A makes a week');
  assert.equal(weeks[0].week, '2026-10-12');
  assert.equal(weeks[0].rules.length, 1);
  assert.equal(weeks[0].rules[0].key, MEMORY);
  assert.equal(weeks[0].rules[0].count, 2);
});

test('the file carries the count, the in-block column, the missing table and an empty mark per affirm', () => {
  const parsed = [runA, runB].map(parseRun);
  const affirms = keyed(parsed.flatMap(p => p.affirms));
  const live = new Map([[MEMORY, {id: MEMORY, statement: RULE, mentions: 6}]]);
  const inBlock = new Set([`session-a ${MEMORY}`]);
  const {headline, text} = render({since: '2026-09-16T00:00:00Z', until: '2026-10-16T00:00:00Z', weeks: 4, min: 2,
    runs: {total: 2, expired: 0}, parsed, affirms, live, inBlock});
  assert.match(headline, /2 affirms parsed · 1 missing/);
  assert.match(headline, /1 rules at 2\+ · in block 2 of 2/);
  assert.match(headline, /top 123456 x2/);
  assert.match(headline, /report line: Said again: 2 affirms on 1 rules at 2\+ · complaint 0 · up-front 0 · top 123456 x2, in block 2 of 2/);
  assert.doesNotMatch(headline, /one page please/, 'the person\'s words stay out of what is printed');
  assert.match(text, /\| 123456 \| Keep a plan to one page with a picture before any code\. \| 2 \| 6 \| 2 of 2 \|/);
  assert.equal((text.match(/^ {2}mark:$/gm) ?? []).length, 2, 'one empty mark per affirm');
  assert.match(text, /source: "too long again, one page please"/);
  assert.match(text, /\| bbbbbb \| 2026-10-07 \| session- \| 1 \| 0 \| 1 \|/);
});

test('a rule under the minimum is folded out of the table but every affirm still gets a mark line', () => {
  const parsed = [parseRun(runA)];
  const affirms = keyed(parsed.flatMap(p => p.affirms));
  const {text} = render({since: '2026-09-16T00:00:00Z', until: '2026-10-16T00:00:00Z', weeks: 4, min: 3,
    runs: {total: 1, expired: 0}, parsed, affirms, live: new Map(), inBlock: new Set()});
  assert.match(text, /1 more under 3 in this span: 123456 x2/);
  assert.equal((text.match(/^ {2}mark:$/gm) ?? []).length, 2, 'a mark line for every affirm, not only rules at the minimum');
});

test('marks a reviewer wrote survive a re-run', () => {
  const parsed = [parseRun(runA)];
  const affirms = keyed(parsed.flatMap(p => p.affirms));
  const first = render({since: '2026-09-16T00:00:00Z', until: '2026-10-16T00:00:00Z', weeks: 4, min: 2,
    runs: {total: 1, expired: 0}, parsed, affirms, live: new Map(), inBlock: new Set()}).text;
  const edited = first.replace(/^( {2}source: "too long again[^\n]*\n {2}mark:)$/m, '$1 complaint');
  const kept = readMarks(edited);
  assert.deepEqual(kept.get('aaaaaa #2'), [null, 'complaint'], 'a blank mark holds its place');
  const again = [parseRun(runA)];
  applyMarks(again, kept);
  assert.equal(again[0].affirms[0].mark, undefined);
  assert.equal(again[0].affirms[1].mark, 'complaint');
  const second = render({since: '2026-09-16T00:00:00Z', until: '2026-10-16T00:00:00Z', weeks: 4, min: 2,
    runs: {total: 1, expired: 0}, parsed: again, affirms: keyed(again.flatMap(p => p.affirms)), live: new Map(), inBlock: new Set()});
  assert.match(second.headline, /complaint 1 · up-front 0 · unmarked 1/);
  assert.match(second.text, /mark: complaint$/m);
});

test('the window starts on a Monday so every week but the last is whole', () => {
  assert.equal(windowStart('2026-10-17T07:35:00Z', 4), '2026-09-21T00:00:00.000Z');
  assert.equal(windowStart('2026-10-13T00:00:00Z', 1), '2026-10-12T00:00:00.000Z');
  assert.equal(windowStart('2026-10-19T00:00:00Z', 4), '2026-09-21T00:00:00.000Z',
    'an until of exactly Monday 00:00 ends the week before, not an empty fifth week');
});

test('a session counts once, in the week of its first start, however many resumes and clears it had', () => {
  const first = firstStarts([
    {session_key: 's1', created_at: '2026-10-13T09:00:00Z'},
    {session_key: 's1', created_at: '2026-10-13T11:00:00Z'},
    {session_key: 's1', created_at: '2026-10-20T09:00:00Z'},
    {session_key: 's2', created_at: '2026-10-14T09:00:00Z'},
    {session_key: 's3', created_at: '2026-10-21T09:00:00Z'},
    {session_key: 's3', created_at: '2026-10-19T08:00:00Z'},
    {session_key: null, created_at: '2026-10-19T08:00:00Z'},
  ]);
  const weeks = sessionsByWeek(first, '2026-10-12T00:00:00Z', '2026-10-25T00:00:00Z');
  assert.deepEqual([...weeks.entries()].sort(), [['2026-10-12', 2], ['2026-10-19', 1]]);
});

test('a session that began before the window and resumed inside it is not counted twice across two overlapping windows', () => {
  const first = firstStarts([
    {session_key: 'old', created_at: '2026-09-18T09:00:00Z'},
    {session_key: 'old', created_at: '2026-09-23T09:00:00Z'},
    {session_key: 'new', created_at: '2026-09-23T10:00:00Z'},
  ]);
  const early = sessionsByWeek(first, '2026-09-14T00:00:00Z', '2026-10-10T00:00:00Z');
  const later = sessionsByWeek(first, '2026-09-21T00:00:00Z', '2026-10-17T00:00:00Z');
  assert.deepEqual([...early.entries()].sort(), [['2026-09-14', 1], ['2026-09-21', 1]]);
  assert.deepEqual([...later.entries()].sort(), [['2026-09-21', 1]], 'the resumed session belongs to the week it began, outside this window');
  const doc = upsertFollowing(upsertFollowing(undefined,
    [{week: '2026-09-14', sessions: early.get('2026-09-14')}, {week: '2026-09-21', sessions: early.get('2026-09-21')}], '2026-10-10T00:00:00Z'),
  [{week: '2026-09-21', sessions: later.get('2026-09-21')}], '2026-10-17T00:00:00Z');
  assert.equal(doc.weeks.reduce((n, e) => n + e.sessions, 0), 2, 'two sessions, two counts');
});

const marked = () => {
  const [one, two] = keyed(parseRun(runA).affirms);
  return [{...one, mark: 'up-front'}, {...two, mark: 'complaint'},
    {...two, session_key: 'session-c', when: '2026-10-08T10:00:00Z', mark: 'complaint'},
    {...two, when: '2026-10-08T11:00:00Z', mark: undefined}];
};

test('each week gets sessions, complaints in block, up-front and unlabelled, and the headline adds them up', () => {
  const entries = followingWeeks({since: '2026-09-21T00:00:00Z', until: '2026-10-17T07:35:00Z', affirms: marked(),
    inBlock: new Set([`session-a ${MEMORY}`]), sessions: new Map([['2026-10-05', 40], ['2026-10-12', 60]])});
  assert.deepEqual(entries.map(e => e.week), ['2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12']);
  assert.deepEqual(entries[2], {week: '2026-10-05', sessions: 40, affirms: 2, complaints_in_block: 0, complaints: 1, up_front: 0, unlabelled: 1},
    'a complaint in a session whose start block did not hold the rule is not a following miss');
  assert.deepEqual(entries[3], {week: '2026-10-12', sessions: 60, affirms: 2, complaints_in_block: 1, complaints: 1, up_front: 1, unlabelled: 0,
    partial: true, through: '2026-10-17'});
  assert.equal(followingLine({weeks: 4, entries, before: []}),
    'following: 1 complaints in 4 weeks · per 100 sessions: 1.0 · 4 weeks before: none kept yet · up-front 1 · unlabelled 1 · last week through 2026-10-17');
  const before = [{week: '2026-09-07', sessions: 50, complaints_in_block: 2}, {week: '2026-09-14', sessions: 50, complaints_in_block: 1}];
  assert.match(followingLine({weeks: 4, entries, before}), /4 weeks before: 3\.0 \(2 of 4 weeks kept\)/);
  assert.match(followingLine({weeks: 4, entries: entries.map(e => ({...e, sessions: 0})), before: []}), /per 100 sessions: n\/a/);
});

test('an affirm is dated by its session\'s first start, the same week the session is counted under', () => {
  const [, two] = keyed(parseRun(runA).affirms);
  const late = {...two, mark: 'complaint', when: '2026-10-13T02:00:00Z', started: '2026-10-11T22:00:00Z'};
  const before = {...two, mark: 'complaint', when: '2026-09-22T02:00:00Z', started: '2026-09-19T22:00:00Z'};
  const entries = followingWeeks({since: '2026-09-21T00:00:00Z', until: '2026-10-17T07:35:00Z', affirms: [late, before],
    inBlock: new Set([`session-a ${MEMORY}`]), sessions: new Map()});
  assert.equal(entries.find(e => e.week === '2026-10-05').complaints, 1, 'read on Tuesday, started on Sunday: counted in the Sunday week');
  assert.equal(entries.find(e => e.week === '2026-10-12').complaints, 0);
  assert.equal(entries.reduce((n, e) => n + e.complaints, 0), 1, 'a session that began before the window is not in it');
});

test('the headline opens the file, and the person\'s words stay out of it', () => {
  const parsed = [parseRun(runA)];
  const line = 'following: 1 complaints in 4 weeks · per 100 sessions: 1.0 · 4 weeks before: none kept yet · up-front 1 · unlabelled 1';
  const {headline, text} = render({since: '2026-09-21T00:00:00Z', until: '2026-10-17T00:00:00Z', weeks: 4, min: 2,
    runs: {total: 1, expired: 0}, parsed, affirms: keyed(parsed.flatMap(p => p.affirms)), live: new Map(), inBlock: new Set(), following: line});
  assert.equal(headline.split('\n')[0], line);
  assert.equal(text.split('\n')[0], line);
});

test('following.json keeps one entry per week and a re-run replaces that week', () => {
  const first = upsertFollowing(undefined, [{week: '2026-10-05', sessions: 40, complaints_in_block: 0}, {week: '2026-10-12', sessions: 20, complaints_in_block: 0}], '2026-10-14T00:00:00Z');
  const second = upsertFollowing(first, [{week: '2026-10-12', sessions: 60, complaints_in_block: 1}, {week: '2026-10-19', sessions: 5, complaints_in_block: 0}], '2026-10-20T00:00:00Z');
  assert.deepEqual(second.weeks.map(e => [e.week, e.sessions, e.as_of]), [
    ['2026-10-05', 40, '2026-10-14T00:00:00Z'], ['2026-10-12', 60, '2026-10-20T00:00:00Z'], ['2026-10-19', 5, '2026-10-20T00:00:00Z']]);
  const words = JSON.stringify(upsertFollowing(second, followingWeeks({since: '2026-10-12T00:00:00Z', until: '2026-10-17T00:00:00Z',
    affirms: marked(), inBlock: new Set(), sessions: new Map()}), '2026-10-21T00:00:00Z'));
  assert.doesNotMatch(words, /one page|plan short|Keep a plan/, 'numbers only, never the person\'s words or the rule');
});

test('an older run never overwrites a week a newer run wrote, and the same moment does', () => {
  const newer = upsertFollowing(undefined, [{week: '2026-10-12', sessions: 60}], '2026-10-20T00:00:00Z');
  const older = upsertFollowing(newer, [{week: '2026-10-12', sessions: 14}, {week: '2026-10-05', sessions: 50}], '2026-10-17T00:00:00Z');
  assert.deepEqual(older.weeks.map(e => [e.week, e.sessions, e.as_of]), [
    ['2026-10-05', 50, '2026-10-17T00:00:00Z'], ['2026-10-12', 60, '2026-10-20T00:00:00Z']]);
  const same = upsertFollowing(older, [{week: '2026-10-12', sessions: 61}], '2026-10-20T00:00:00Z');
  assert.equal(same.weeks[1].sessions, 61, 'a re-run of the same folder replaces its own week');
});

test('following.json: missing is empty, a corrupt file throws and is left as it was, a write is whole', () => {
  const dir = mkdtempSync(join(tmpdir(), 'following-'));
  try {
    const file = join(dir, 'nested', 'following.json');
    assert.deepEqual(readFollowing(file), {weeks: []});
    writeFollowing(file, {weeks: [{week: '2026-10-12', sessions: 3}]});
    assert.deepEqual(readFollowing(file), {weeks: [{week: '2026-10-12', sessions: 3}]});
    assert.deepEqual(readdirSync(join(dir, 'nested')), ['following.json'], 'no temp file left behind');
    writeFileSync(file, '{"weeks": [{"week": "2026-10-12"');
    assert.throws(() => readFollowing(file), /not valid JSON/);
    assert.equal(readFileSync(file, 'utf8'), '{"weeks": [{"week": "2026-10-12"', 'the history is not touched');
    writeFileSync(file, '[1, 2]');
    assert.throws(() => readFollowing(file), /is not \{"weeks"/);
    writeFileSync(file, '{"weeks": 3}');
    assert.throws(() => readFollowing(file), /is not \{"weeks"/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('the earlier folder is the newest dated sibling before this one that has a said-again.md', () => {
  const dir = mkdtempSync(join(tmpdir(), 'daily-'));
  try {
    for (const name of ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', 'real-eval']) mkdirSync(join(dir, name));
    for (const name of ['2026-10-14', '2026-10-15', '2026-10-18']) writeFileSync(join(dir, name, 'said-again.md'), '');
    writeFileSync(join(dir, 'real-eval', 'said-again.md'), '');
    assert.equal(earlierFolder(join(dir, '2026-10-17')), join(dir, '2026-10-15'), 'skips a day with no file and anything after');
    assert.equal(earlierFolder(join(dir, '2026-10-14')), null);
    assert.equal(earlierFolder(join(dir, 'missing', '2026-10-17')), null, 'no parent folder is no earlier folder');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a new day starts from the marks the last day left, and its own marks win', () => {
  const earlier = new Map([['aaaaaa #2', ['up-front', 'complaint']], ['cccccc #1', ['complaint']]]);
  const current = new Map([['aaaaaa #2', [null, 'up-front']]]);
  const merged = mergeMarks(current, earlier);
  assert.deepEqual(merged.get('aaaaaa #2'), ['up-front', 'up-front']);
  assert.deepEqual(merged.get('cccccc #1'), ['complaint']);
});
