// The review's "said again" count, on two made-up runs small enough to count by hand.
// Nothing here touches the database: the pure parts are imported and fed fixtures.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseRun, byWeek, render, readMarks, applyMarks, weekOf} from '../.claude/skills/daily-improvement/scripts/said-again.mjs';

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

test('a rule under the minimum is folded into one line, not dropped', () => {
  const parsed = [parseRun(runA)];
  const affirms = keyed(parsed.flatMap(p => p.affirms));
  const {text} = render({since: '2026-09-16T00:00:00Z', until: '2026-10-16T00:00:00Z', weeks: 4, min: 3,
    runs: {total: 1, expired: 0}, parsed, affirms, live: new Map(), inBlock: new Set()});
  assert.match(text, /1 more under 3 in this span: 123456 x2/);
  assert.doesNotMatch(text, /^ {2}mark:/m);
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
