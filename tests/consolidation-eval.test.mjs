// The consolidation bench's arithmetic.
//
// eval/lib/metrics.mjs is tested for the same reason: the harness decides
// which wording ships, so a silently wrong score makes every conclusion drawn
// from it wrong. These are all pure, so none of them calls a model.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {score, damage, contains, summarise, isRestraint} from '../eval/lib/consolidation-scoring.mjs';

const suite = JSON.parse(readFileSync(new URL('../eval/consolidation-cases.json', import.meta.url), 'utf8'));
const change = over => ({action: 'add', target: null, statement: 'A claim.', project: null, ...over});

test('the case file is internally consistent', () => {
  // A case that names a target no memory has, or a scope no project has, is a
  // case that can never pass and would quietly drag the number down forever.
  const slugs = new Set(suite.projects.map(p => p.slug));
  const ids = new Set();
  for (const item of suite.cases) {
    assert.ok(!ids.has(item.id), `duplicate case id ${item.id}`);
    ids.add(item.id);
    assert.ok(item.why, `${item.id} has no rationale, and a case nobody can argue with is a case nobody will fix`);
    assert.ok(item.turns?.length, `${item.id} has no conversation`);
    assert.ok(item.turns.some(t => t.role === 'user'), `${item.id} has no user turn, so nothing can source a change`);
    if (item.working) assert.ok(slugs.has(item.working), `${item.id} works in unknown project ${item.working}`);
    if (item.expect === 'either') continue;
    if (item.expect.target != null)
      assert.ok(item.expect.target <= (item.memories ?? []).length,
        `${item.id} targets #${item.expect.target} and has ${(item.memories ?? []).length} memories`);
    if ('scope' in item.expect && item.expect.scope)
      assert.ok(slugs.has(item.expect.scope), `${item.id} wants unknown scope ${item.expect.scope}`);
  }
});

test('which half a case counts towards is read off the case, not a list', () => {
  // This was a hand-kept list of categories and it was wrong within the hour:
  // `churn` has a case that should change something and a case that should
  // not, because the marker is a reason to look rather than a verdict.
  assert.equal(isRestraint({action: 'nothing'}), true);
  assert.equal(isRestraint({action: 'retire', target: 1}), false);
  assert.equal(isRestraint('either'), false, 'an unscored case is on neither side');

  const sides = new Map();
  for (const item of suite.cases.filter(c => c.expect !== 'either'))
    sides.set(item.category, (sides.get(item.category) ?? new Set()).add(isRestraint(item.expect)));
  const straddling = [...sides].filter(([, s]) => s.size > 1).map(([c]) => c);
  // job-with-rule straddles on purpose: one message holds a job to drop and
  // sometimes a rule to keep, and a case of each keeps "keep every clause"
  // from scoring.
  assert.deepEqual(straddling, ['churn', 'job-with-rule'],
    'churn and job-with-rule are the honest ones that sit on both sides; a new straddling category is worth a second look');

  // And both halves have to exist, or the headline is one number wearing two.
  const cases = suite.cases.filter(c => c.expect !== 'either');
  assert.ok(cases.some(c => isRestraint(c.expect)) && cases.some(c => !isRestraint(c.expect)));
});

test('nothing expected means nothing at all', () => {
  const item = {expect: {action: 'nothing'}};
  assert.equal(score(item, []).ok, true);
  assert.equal(score(item, [change({})]).ok, false);
});

test('the right action on the wrong memory is wrong', () => {
  const item = {expect: {action: 'retire', target: 1}};
  assert.equal(score(item, [change({action: 'retire', target: 1})]).ok, true);
  const missed = score(item, [change({action: 'retire', target: 2})]);
  assert.equal(missed.ok, false);
  assert.match(missed.note, /targeted #2/);
});

test('doing the right thing and three other things is not doing the right thing', () => {
  // Every extra row is one a person has to read and decide about, which is the
  // cost this whole rebuild exists to remove.
  const item = {expect: {action: 'retire', target: 1}};
  const out = score(item, [change({action: 'retire', target: 1}), change({statement: 'Something else.'})]);
  assert.equal(out.ok, false);
  assert.match(out.note, /plus 1 more/);
});

test('a case may allow a split, and only into the action it wants', () => {
  const item = {expect: {action: 'add', want: 'ticket numbers', most: 2}};
  const two = [change({statement: 'No comments in the code unless needed.'}),
    change({statement: 'No ticket numbers in code comments.'})];
  assert.equal(score(item, two).ok, true);
  assert.equal(score(item, [...two, change({statement: 'A third thing.'})]).ok, false);
  assert.equal(score(item, [two[1], change({action: 'retire', target: 1})]).ok, false);
});

test('ending a memory the case did not sanction is damage, counted on its own', () => {
  // The distinction the whole bench turns on. An add that should not exist is
  // one row to delete. A memory that was retired stops loading until somebody
  // goes and finds it, and averaging that into an accuracy number is how it
  // stops being visible.
  assert.deepEqual(damage([change({action: 'add'})], {action: 'nothing'}), []);
  assert.deepEqual(damage([change({action: 'retire', target: 2})], {action: 'retire', target: 2}), []);
  assert.deepEqual(damage([change({action: 'retire', target: 3})], {action: 'retire', target: 2}),
    [{action: 'retire', target: 3}]);
  assert.deepEqual(damage([change({action: 'replace', target: 1})], {action: 'nothing'}),
    [{action: 'replace', target: 1}]);
  // An `either` case takes no side on what should happen, and still counts
  // damage: "both answers are defensible" never includes ending a third memory.
  assert.equal(damage([change({action: 'retire', target: 1})], 'either').length, 1);
});

test('a scored case still reports damage done alongside it', () => {
  const out = score({expect: {action: 'add', want: 'claim'}},
    [change({statement: 'A claim.'}), change({action: 'retire', target: 1})]);
  assert.equal(out.ok, false, 'two changes when one was asked for');
  assert.equal(out.harm.length, 1);
});

test('a rejected premise kept is called out as such', () => {
  const item = {expect: {action: 'add', want: 'reversing entry'}, forbid: ['entries are immutable']};
  const out = score(item, [change({statement: 'Entries are immutable.'})]);
  assert.equal(out.ok, false);
  assert.match(out.note, /rejected premise/);
});

test('scope and expiry are part of being right', () => {
  assert.equal(score({expect: {action: 'add', want: 'claim', scope: 'ledger'}},
    [change({statement: 'A claim.', project: 'ledger'})]).ok, true);
  const wrongScope = score({expect: {action: 'add', want: 'claim', scope: null}},
    [change({statement: 'A claim.', project: 'ledger'})]);
  assert.equal(wrongScope.ok, false);
  assert.match(wrongScope.note, /scope ledger, wanted personal/);
  assert.equal(score({expect: {action: 'add', want: 'freeze', expires: true}},
    [change({statement: 'The freeze runs to the 30th.'})]).ok, false);
});

test('a relative reference frozen into a claim fails', () => {
  // How "do not include names of people who are not in the review list this
  // time around" became a permanent personal memory.
  const item = {expect: {action: 'add', want: 'review', resolved: true}};
  assert.equal(score(item, [change({statement: 'The review is due next Friday.'})]).ok, false);
  assert.equal(score(item, [change({statement: 'The review is due on 2 October 2026.'})]).ok, true);
});

test('an either case is printed rather than scored, and cannot be gamed', () => {
  const out = score({expect: 'either'}, [change({})]);
  assert.equal(out.scored, false);
  assert.equal('ok' in out, false, 'no verdict at all, rather than a passing one');
});

test('containment asks whether the claim is there, not whether it is the same length', () => {
  assert.ok(contains('Do not use em dashes anywhere.', 'No em dashes') > 0.3);
  assert.equal(contains('Deploys are on Tuesdays.', 'nothing in common at all'), 0);
  assert.equal(contains('', 'anything'), 0);
});

test('the summary keeps the two halves apart and totals the damage', () => {
  const sum = summarise([
    {scored: true, ok: true, category: 'work-order', restraint: true, harm: []},
    {scored: true, ok: false, category: 'work-order', restraint: true, harm: [{action: 'retire', target: 1}]},
    {scored: true, ok: true, category: 'retire', restraint: false, harm: []},
    {scored: false, category: 'add', harm: [{action: 'replace', target: 2}]},
  ]);
  assert.deepEqual(sum.restraint, {right: 1, total: 2});
  assert.deepEqual(sum.action, {right: 1, total: 1});
  assert.deepEqual(sum.both, {right: 2, total: 3});
  assert.equal(sum.harm, 2, 'including the damage done by a case nobody scored');
});
