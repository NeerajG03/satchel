// The review's counting script, on a folder small enough to count by hand.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';

const script = new URL('../.claude/skills/daily-improvement/scripts/compare.mjs', import.meta.url).pathname;

function folder({shown, repository}) {
  const dir = mkdtempSync(join(tmpdir(), 'compare-'));
  mkdirSync(join(dir, 'blind')); mkdirSync(join(dir, 'pipeline'));
  const sessions = [{name: 'aaaa1111', scope: 'personal', turns: 3, chars: 100, ...(repository !== undefined && {repository})}, {name: 'bbbb2222', scope: 'ledger', turns: 2, chars: 50, ...(repository !== undefined && {repository: 'owner/other'})}];
  writeFileSync(join(dir, 'blind/INDEX.json'), JSON.stringify({sessions, batches: []}));
  writeFileSync(join(dir, 'pipeline/aaaa1111.md'), ['# aaaa1111', '', 'model m · 10 ms · error none',
    'counts: added 1 extended 0 replaced 0 retired 0 affirmed 1 rejected 1', '', '## What landed', '',
    '- added [fact · ledger · said] A ledger fact.', '- confirmed [preference · personal · said] Old rule.',
    '- affirmed abc (from the job report: an affirm on a confirmed memory leaves no history row)'].join('\n'));
  writeFileSync(join(dir, 'pipeline/bbbb2222.md'), ['# bbbb2222', '', 'model m · 10 ms · error none',
    'counts: added 0 extended 0 replaced 0 retired 0 affirmed 0 rejected 0', '', '## What landed', ''].join('\n'));
  const list = n => Array.from({length: n}, (_, i) => `${i + 1}. [fact · personal] memory ${i}`).join('\n');
  for (const name of ['aaaa1111', 'bbbb2222'])
    writeFileSync(join(dir, `blind/${name}.md`), `# ${name}\n\n## Memories that already existed before this pass (x)\n\n${list(shown)}\n\n## The new turns (1)\n`);
  writeFileSync(join(dir, 'blind/out-1.json'), JSON.stringify([
    {session: 'aaaa1111', scope: 'personal', about: 'ledger', changes: [
      {action: 'add', kind: 'fact', memory_scope: 'ledger', statement: 's', source: 's'},
      {action: 'affirm', target: 1, kind: 'preference', memory_scope: 'personal', statement: '', source: 's'}]},
    {session: 'bbbb2222', scope: 'ledger', about: 'ledger', changes: []}]));
  const trace = doc => ({metadata: {document: doc, knownMemories: 2, characters: 100, modelUsed: 'm', thinking: 'medium', promptSource: 'local', promptVersion: 'file', waited: false},
    generations: [{cost: 0.01}], latency_s: 1, level: 'DEFAULT'});
  writeFileSync(join(dir, 'langfuse.json'), JSON.stringify({traces: {t1: trace('aaaa1111-x'), t2: trace('bbbb2222-x')}}));
  return dir;
}

const run = dir => execFileSync('node', [script, dir], {encoding: 'utf8'});

test('the numbers are counted, and an affirm shown twice counts once', () => {
  const out = run(folder({shown: 2}));
  assert.match(out, /\| changes \| 2 \| 2 \|/);
  assert.match(out, /\| sessions with any \| 1 \| 1 \|/);
  assert.match(out, /\| empty answers \| 1 \| 1 \|/);
  assert.match(out, /\| project-scoped from sessions with no project \| 1 \| 1 \|/);
  assert.match(out, /\| add \/ extend \/ replace \/ retire \/ affirm \| 1 \/ 0 \/ 0 \/ 0 \/ 1 \| 1 \/ 0 \/ 0 \/ 0 \/ 1 \|/);
  assert.match(out, /\| rejected by the checks \| 1 \| {2}\|/);
  assert.match(out, /same on all 2 sessions/);
});

test('a blind file with more memories than the pass saw is a warning', () => {
  const dir = folder({shown: 3});
  const out = run(dir);
  assert.match(out, /WARNING: 2 of 2 sessions differ/);
  assert.match(readFileSync(join(dir, 'numbers.md'), 'utf8'), /"both" is unproven/);
});

test('a session with no project says whether it had a repository to show the pass', () => {
  assert.match(run(folder({shown: 2, repository: null})), /\| sessions with no project that have a repository \| 0 of 1 \(none for aaaa1111\) \|/);
  assert.match(run(folder({shown: 2, repository: 'owner/name'})), /\| sessions with no project that have a repository \| 1 of 1 \|/);
});

test('a folder from before the field existed does not claim anything about it', () => {
  assert.doesNotMatch(run(folder({shown: 2})), /that have a repository/);
});
