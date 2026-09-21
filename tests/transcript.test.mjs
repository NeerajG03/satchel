// What capture is allowed to take out of the host's transcript.
//
// This is the file that decides what leaves the machine, so it gets tested
// against the shapes a real transcript actually contains rather than against
// the ones the reader was written for. Everything below was taken from a live
// Claude Code JSONL: the flags, the wrappers and the two different meanings of
// `type: "user"` are all real.
//
// The rule being pinned: the person's own typed messages and the assistant's
// plain text. Not tool calls, not tool results, not thinking, not subagents,
// not hook output, not shell commands, not slash commands, not compaction
// summaries, not system reminders.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {messageFrom, readTranscriptDelta} from '../integrations/shared/transcript.mjs';

const user = (uuid, content, extra = {}) => ({type: 'user', uuid, message: {content}, ...extra});
const assistant = (uuid, blocks, extra = {}) => ({type: 'assistant', uuid, message: {content: blocks}, ...extra});

test('a typed message is taken and a tool result is not, though both say user', () => {
  assert.deepEqual(messageFrom(user('u1', 'never bump Go until payouts ship')),
    {uuid: 'u1', role: 'user', content: 'never bump Go until payouts ship'});

  // The same type, and the thing that separates them is the shape of content
  // plus toolUseResult. Missing this sends file contents and command output to
  // a server, so both are checked rather than either.
  assert.equal(messageFrom(user('u2', [{type: 'tool_result', content: 'secret file body'}],
    {toolUseResult: {stdout: 'secret'}})), null);
  assert.equal(messageFrom(user('u3', [{type: 'tool_result', content: 'x'}])), null);
  assert.equal(messageFrom({...user('u4', 'ran a tool'), toolUseResult: {stdout: 'x'}}), null);
});

test('the host talking through a user entry is not the person talking', () => {
  // All of these arrive as type:"user" with string content and no flag that
  // separates them. The opening tag is the only signal there is.
  for (const text of [
    '<command-name>/compact</command-name>\n<command-message>compact</command-message>',
    '<local-command-stdout>Compacted </local-command-stdout>',
    '<bash-input>git push</bash-input>',
    '<task-notification>\n<task-id>blxdo09y0</task-id>\n</task-notification>',
    '<system-reminder>Do the thing</system-reminder>',
    '<local-command-caveat>Caveat: the messages below were generated</local-command-caveat>',
  ]) assert.equal(messageFrom(user('h', text)), null, `must drop: ${text.slice(0, 30)}`);
});

test('flags the host sets are honoured, because each one means someone else spoke', () => {
  // A subagent's conversation, which the person never saw.
  assert.equal(messageFrom(user('s', 'do the search', {isSidechain: true})), null);
  // Host-generated framing.
  assert.equal(messageFrom(user('m', 'Caveat: generated while running local commands', {isMeta: true})), null);
  // Our own earlier output coming back around. Treating a summary of a memory
  // as something the user said is how one memory becomes two.
  assert.equal(messageFrom(user('c', 'The user asked for X and Y', {isCompactSummary: true})), null);
});

test('an injected block is stripped out of an otherwise real message', () => {
  const entry = user('u', 'fix the gemini 429s\n<system-reminder>secret policy text</system-reminder>');
  assert.deepEqual(messageFrom(entry), {uuid: 'u', role: 'user', content: 'fix the gemini 429s'});
});

test('an assistant turn contributes its text and nothing else it did', () => {
  assert.deepEqual(messageFrom(assistant('a1', [
    {type: 'thinking', thinking: 'the user probably means the free tier'},
    {type: 'text', text: 'The daily quota is spent.'},
    {type: 'tool_use', name: 'Bash', input: {command: 'cat ~/.config/env'}},
    {type: 'text', text: 'It resets at midnight Pacific.'},
  ])), {uuid: 'a1', role: 'assistant', content: 'The daily quota is spent.\nIt resets at midnight Pacific.'});

  // Thinking is not addressed to anyone, and a tool_use block is a path or a
  // command, which is exactly the kind of thing that must not leave.
  assert.equal(messageFrom(assistant('a2', [{type: 'thinking', thinking: 'hmm'}])), null);
  assert.equal(messageFrom(assistant('a3', [{type: 'tool_use', name: 'Read', input: {file_path: '/etc/passwd'}}])), null);
});

test('the delta is everything after the mark, and the mark is where it stops', () => {
  const dir = mkdtempSync(join(tmpdir(), 'satchel-transcript-'));
  const path = join(dir, 'session.jsonl');
  try {
    writeFileSync(path, [
      user('u1', 'first question'),
      assistant('a1', [{type: 'text', text: 'first answer'}]),
      user('u2', 'second question'),
      {type: 'file-history-snapshot', messageId: 'x', snapshot: {}},
      assistant('a2', [{type: 'text', text: 'second answer'}]),
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n');

    const whole = readTranscriptDelta(path);
    assert.deepEqual(whole.messages.map(m => m.content),
      ['first question', 'first answer', 'second question', 'second answer']);
    assert.equal(whole.last, 'a2', 'the mark is the newest entry, not the newest message');

    const since = readTranscriptDelta(path, {after: 'a1'});
    assert.deepEqual(since.messages.map(m => m.content), ['second question', 'second answer']);
    assert.equal(since.found, true);

    // Nothing new is the common case at the end of a turn that captured
    // already, and it has to cost nothing.
    assert.deepEqual(readTranscriptDelta(path, {after: 'a2'}).messages, []);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('losing the mark falls back to the tail, never to the whole conversation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'satchel-transcript-lost-'));
  const path = join(dir, 'session.jsonl');
  try {
    writeFileSync(path, Array.from({length: 50}, (_, i) => JSON.stringify(user(`u${i}`, `line ${i}`))).join('\n') + '\n');
    const result = readTranscriptDelta(path, {after: 'gone', max: 5});
    assert.equal(result.found, false);
    assert.equal(result.lost, true);
    assert.deepEqual(result.messages.map(m => m.content), ['line 45', 'line 46', 'line 47', 'line 48', 'line 49']);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a partial line at the edge of the window is dropped, not guessed at', () => {
  const dir = mkdtempSync(join(tmpdir(), 'satchel-transcript-tail-'));
  const path = join(dir, 'session.jsonl');
  try {
    const lines = Array.from({length: 40}, (_, i) => JSON.stringify(user(`u${i}`, 'x'.repeat(200) + i)));
    writeFileSync(path, lines.join('\n') + '\n');
    // A window that lands mid-line. Half a JSON object is worse than one
    // missing message, so it is discarded rather than repaired.
    const result = readTranscriptDelta(path, {bytes: 1000});
    assert.ok(result.messages.length > 0 && result.messages.length < 40);
    assert.ok(result.messages.every(m => typeof m.content === 'string' && m.content.length > 0));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a long message is truncated rather than sent whole', () => {
  const taken = messageFrom(user('u', 'x'.repeat(50000)));
  assert.ok(taken.content.length < 9000, 'a pasted file must not push the turn out of the router budget');
  assert.match(taken.content, /\[truncated\]$/);
});

test('a missing file is an empty answer, not a thrown hook', () => {
  const result = readTranscriptDelta('/no/such/transcript.jsonl');
  assert.deepEqual(result.messages, []);
  assert.equal(result.last, null);
});
