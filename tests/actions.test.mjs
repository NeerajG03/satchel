// What the agent did in a turn: summarized on this machine by the PostToolUse
// hook, sent by Stop, validated and appended to the reply on the server.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {readActions, parseHookBody} from '../server/hook-handler.mjs';
import {withActions, capture} from '../server/lifecycle.mjs';

process.env.SATCHEL_HOME = mkdtempSync(join(tmpdir(), 'satchel-actions-'));
const {summarize, recordAction, pendingActions, clearActions, MAX_LINES, MAX_LINE} =
  await import('../integrations/shared/actions-buffer.mjs');

const scriptPath = name => new URL(`../integrations/shared/${name}`, import.meta.url).pathname;
const run = (name, input, env = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [scriptPath(name)], {env: {...process.env, ...env}});
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.on('error', reject);
  child.on('close', code => resolve({code, stdout: out}));
  child.stdin.end(input);
});

test('each kind of tool call becomes one short line', () => {
  const line = (tool_name, tool_input) => summarize({tool_name, tool_input});
  assert.equal(line('Bash', {command: 'npm test\n  --silent'}), 'ran: npm test --silent');
  assert.equal(line('Edit', {file_path: '/a/src/app.ts', old_string: 'x', new_string: 'y'}), 'edited: /a/src/app.ts');
  assert.equal(line('Write', {file_path: '/a/new.md', content: 'hello'}), 'edited: /a/new.md');
  assert.equal(line('MultiEdit', {file_path: '/a/b.ts', edits: []}), 'edited: /a/b.ts');
  assert.equal(line('NotebookEdit', {notebook_path: '/a/n.ipynb', new_source: 's'}), 'edited: /a/n.ipynb');
  assert.equal(line('Read', {file_path: '/a/r.ts'}), 'read: /a/r.ts');
  assert.equal(line('Grep', {pattern: 'TODO', path: 'src'}), 'searched: TODO in src');
  assert.equal(line('Glob', {pattern: '**/*.mjs'}), 'searched: **/*.mjs');
  assert.equal(line('mcp__github__create_issue', {title: 'private', body: 'private'}), 'used: mcp__github__create_issue');
  assert.equal(line('Bash', {}), null, 'nothing to say is no line');
  assert.equal(line('mcp__plugin_satchel_satchel__retrieve_memory', {query: 'x'}), null, 'Satchel’s own tools are not the work');
  assert.equal(line('mcp__claude_ai_Satchel__save_memory', {}), null);
});

test('no file contents, edit text or tool output ever reach a line', () => {
  const secretBody = 'PRIVATE-FILE-BODY';
  for (const event of [
    {tool_name: 'Write', tool_input: {file_path: '/a/b.ts', content: secretBody}, tool_response: secretBody},
    {tool_name: 'Edit', tool_input: {file_path: '/a/b.ts', old_string: secretBody, new_string: secretBody}},
    {tool_name: 'MultiEdit', tool_input: {file_path: '/a/b.ts', edits: [{old_string: secretBody, new_string: secretBody}]}},
    {tool_name: 'Bash', tool_input: {command: 'ls'}, tool_response: {stdout: secretBody}},
    {tool_name: 'mcp__x__send', tool_input: {text: secretBody}, tool_response: secretBody},
  ]) assert.doesNotMatch(summarize(event), /PRIVATE/);
});

test('a command is scrubbed of tokens, assignments and headers, and is clipped', () => {
  const dirty = [
    'curl -H "Authorization: Bearer abcdefghijklmnop12345" https://x.test',
    'API_KEY=hunter2hunter2 npm run deploy',
    'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123',
    'git push https://user:s3cretpass@github.com/a/b.git',
    'tool --token abc123def456 --name ok',
    'echo sk-abcdefghijklmnopqrstuvwx',
  ];
  for (const command of dirty) {
    const out = summarize({tool_name: 'Bash', tool_input: {command}});
    assert.doesNotMatch(out, /abcdefghijklmnop12345|hunter2|ghp_|s3cretpass|abc123def456|sk-abcdef/, out);
    assert.match(out, /\[hidden\]/);
  }
  assert.match(summarize({tool_name: 'Bash', tool_input: {command: 'git push origin main'}}), /^ran: git push origin main$/);
  const long = summarize({tool_name: 'Bash', tool_input: {command: 'x'.repeat(5000)}});
  assert.ok(long.length <= 'ran: '.length + MAX_LINE);
});

test('the buffer keeps the newest lines under its cap and clears only what was sent', () => {
  for (let i = 0; i < MAX_LINES + 10; i++) recordAction('cap-session', `ran: step ${i}`);
  const lines = pendingActions('cap-session');
  assert.equal(lines.length, MAX_LINES);
  assert.equal(lines.at(-1), `ran: step ${MAX_LINES + 9}`, 'the newest survive');
  clearActions('cap-session', MAX_LINES);
  assert.deepEqual(pendingActions('cap-session'), []);
  for (const step of ['a', 'b', 'late']) recordAction('late-session', `ran: ${step}`);
  clearActions('late-session', 2);
  assert.deepEqual(pendingActions('late-session'), ['ran: late'], 'a line added after the read is not lost');
  assert.deepEqual(pendingActions('never-seen'), []);
});

test('the hook script records from PostToolUse, quietly, and never fails the turn', async () => {
  const SATCHEL_HOME = mkdtempSync(join(tmpdir(), 'satchel-actions-hook-'));
  const post = (extra = {}) => JSON.stringify({session_id: 'hook-s', hook_event_name: 'PostToolUse',
    tool_name: 'Bash', tool_input: {command: 'git commit -m done'}, tool_response: {stdout: 'SECRET OUTPUT'}, ...extra});
  try {
    const {code, stdout} = await run('actions.mjs', post(), {SATCHEL_HOME});
    assert.equal(code, 0);
    assert.equal(stdout, '', 'a recording hook says nothing');
    const file = join(SATCHEL_HOME, 'actions', 'hook-s.log');
    assert.equal(readFileSync(file, 'utf8'), 'ran: git commit -m done\n');
    assert.equal(((await import('node:fs')).statSync(file).mode & 0o777), 0o600);
    assert.doesNotMatch(readFileSync(file, 'utf8'), /SECRET OUTPUT/);

    assert.equal((await run('actions.mjs', 'not json', {SATCHEL_HOME})).code, 0);
    assert.equal((await run('actions.mjs', post({hook_event_name: 'Stop'}), {SATCHEL_HOME})).code, 0);
    assert.equal(readFileSync(file, 'utf8'), 'ran: git commit -m done\n', 'only PostToolUse records');

    await run('actions.mjs', post({session_id: 'quiet-s'}), {SATCHEL_HOME, SATCHEL_DISABLE_REPOSITORY_STAGING: '1'});
    assert.equal(existsSync(join(SATCHEL_HOME, 'actions', 'quiet-s.log')), false, 'the opt-out is respected');
    assert.deepEqual(readdirSync(join(SATCHEL_HOME, 'actions')), ['hook-s.log']);
  } finally { rmSync(SATCHEL_HOME, {recursive: true, force: true}); }
});

test('Stop sends the actions with the reply, and clears them only after a successful send', async () => {
  const SATCHEL_HOME = mkdtempSync(join(tmpdir(), 'satchel-actions-stop-'));
  const sent = [];
  let status = 503;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      sent.push(JSON.parse(body));
      res.writeHead(status, {'content-type': 'application/json'});
      res.end(JSON.stringify({captured: 0, notice: ''}));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  writeFileSync(join(SATCHEL_HOME, 'credentials.json'), JSON.stringify({
    client_id: 'c', refresh_token: 'r', access_token: 't', expires_at: Date.now() + 3600_000}));
  const env = {SATCHEL_HOME, SATCHEL_URL: `http://127.0.0.1:${server.address().port}`, SATCHEL_DISABLE_REPOSITORY_STAGING: '0'};
  const file = join(SATCHEL_HOME, 'actions', 'stop-s.log');
  const stop = JSON.stringify({session_id: 'stop-s', hook_event_name: 'Stop', cwd: tmpdir(), last_assistant_message: 'Done.'});
  try {
    await run('actions.mjs', JSON.stringify({session_id: 'stop-s', hook_event_name: 'PostToolUse',
      tool_name: 'Bash', tool_input: {command: 'npm test'}}), env);
    await run('actions.mjs', JSON.stringify({session_id: 'stop-s', hook_event_name: 'PostToolUse',
      tool_name: 'Edit', tool_input: {file_path: 'src/app.ts', new_string: 'secret'}}), env);

    assert.equal((await run('capture.mjs', stop, env)).code, 0);
    assert.deepEqual(sent[0].actions, ['ran: npm test', 'edited: src/app.ts']);
    assert.equal(sent[0].assistant, 'Done.');
    assert.equal(sent.length, 1, 'one call carries both the reply and the actions');
    assert.equal(existsSync(file), true, 'a failed send keeps the buffer, so the next Stop offers it again');

    status = 200;
    assert.equal((await run('capture.mjs', stop, env)).code, 0);
    assert.deepEqual(sent[1].actions, ['ran: npm test', 'edited: src/app.ts']);
    assert.equal(existsSync(file), false, 'a successful send empties it');

    await run('capture.mjs', stop, env);
    assert.equal('actions' in sent[2], false, 'a turn with no actions sends no field');
  } finally {
    rmSync(SATCHEL_HOME, {recursive: true, force: true});
    await new Promise(done => server.close(done));
  }
});

test('the server takes actions as short scrubbed strings and drops the rest', () => {
  assert.deepEqual(parseHookBody({session_key: 's', actions: ['ran: ls']},
    new Set(['session_key', 'actions'])).actions, ['ran: ls']);
  assert.deepEqual(readActions(undefined), []);
  assert.deepEqual(readActions('ran: ls'), [], 'not an array');
  assert.deepEqual(readActions(['ran: ls', 5, null, {a: 1}, '   ', ['x']]), ['ran: ls']);
  assert.equal(readActions(Array.from({length: 500}, () => 'ran: ls')).length, 60);
  assert.equal(readActions(['x'.repeat(5000)])[0].length, 240);
  const [line] = readActions(['ran: curl -H "Authorization: Bearer abcdefghijklmnop12345"',]);
  assert.doesNotMatch(line, /abcdefghijklmnop12345/);
});

test('actions are appended to the reply, which is kept whole, and trimmed first', () => {
  assert.equal(withActions('Done.', ['ran: npm test', 'edited: src/app.ts']),
    'Done.\n\nActions this turn:\n- ran: npm test\n- edited: src/app.ts');
  assert.equal(withActions('Done.', []), 'Done.');
  assert.equal(withActions('Done.'), 'Done.');
  assert.equal(withActions('', ['ran: ls']), 'Actions this turn:\n- ran: ls');
  const reply = 'r'.repeat(7900);
  const out = withActions(reply, Array.from({length: 40}, (_, i) => `ran: command number ${i}`));
  assert.ok(out.length <= 8000);
  assert.ok(out.startsWith(reply), 'the reply is never cut for the actions');
  assert.match(out, /command number 39$/, 'the newest actions are the ones kept');
  assert.equal(withActions('r'.repeat(8000), ['ran: ls']), 'r'.repeat(8000), 'no room, no block');
});

test('capture records the reply with the actions under it, with no new column', async () => {
  const recorded = [];
  const service = {
    status: async () => ({label: 'Test', personal: true, can_write: true, topic_ids: []}),
    settings: async () => ({capture: true, capture_window: 5, capture_mode: 'session'}),
    activeTopic: async () => null,
    resolveRepository: async () => [],
    recordTurn: async (_key, role, content) => { recorded.push({role, content}); },
  };
  await capture(service, {sessionKey: 's', assistant: 'Pushed.', actions: ['ran: git push', 'edited: a.ts']});
  assert.deepEqual(recorded, [{role: 'assistant', content: 'Pushed.\n\nActions this turn:\n- ran: git push\n- edited: a.ts'}]);
  recorded.length = 0;
  await capture(service, {sessionKey: 's', assistant: 'Hi.'});
  assert.deepEqual(recorded, [{role: 'assistant', content: 'Hi.'}]);
});
