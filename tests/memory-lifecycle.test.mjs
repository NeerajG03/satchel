// The three bugs this file pins all shipped green, because the MCP tests drive
// a hand-written fake service and the database tests never go through the
// service. Each one was invisible in production rather than loud: retrieval
// returned nothing, and capture simply never happened.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMemoryServer} from '../server/mcp-server.mjs';
import {memoryService} from '../server/memory-service.mjs';

/** Records what the service actually sends, the way supabase-js would take it. */
function recorder(responses = {}) {
  const calls = {rpc: [], select: []};
  const answer = data => ({abortSignal: () => Promise.resolve({data, error: null})});
  return {
    calls,
    rpc(name, args) { calls.rpc.push({name, args}); return answer(responses[name] ?? []); },
    from(table) {
      return {
        select(columns) {
          calls.select.push({table, columns});
          const rows = responses[table] ?? [];
          return {limit: () => answer(rows), ...answer(rows)};
        },
      };
    },
  };
}

const embedder = {model: 'test-model', embedOne: async () => Array(768).fill(0.1)};

test('a default is asked for by omission, never by sending null', async () => {
  // `p_gate real default 0.67` applies when the argument is absent. JSON null
  // is not absent: it reaches Postgres as NULL, `score >= NULL` is NULL, and
  // every row is dropped. Sending null silenced retrieval completely.
  const db = recorder();
  await memoryService(db, embedder).search({query: 'anything'});
  const {args} = db.calls.rpc.find(c => c.name === 'search_memories');
  for (const key of ['p_gate', 'p_boost', 'p_limit'])
    assert.ok(!(key in args), `${key} must be omitted when not supplied, not sent as null`);

  // And when they are supplied they must actually travel, or the user's
  // configured gate is read, traced, and then quietly ignored.
  const db2 = recorder();
  await memoryService(db2, embedder).search({query: 'anything', gate: 0.8, boost: 1.4, limit: 3});
  const supplied = db2.calls.rpc.find(c => c.name === 'search_memories').args;
  assert.equal(supplied.p_gate, 0.8);
  assert.equal(supplied.p_boost, 1.4);
  assert.equal(supplied.p_limit, 3);
});

test('settings carry every column the lifecycle path reads', async () => {
  // capture and capture_window arrived with the router migration and were never
  // added to this select, so settings.capture was undefined on every request:
  // capture short-circuited and the rolling window was never written.
  const db = recorder({memory_settings: []});
  const fallback = await memoryService(db, embedder).settings();
  const {columns} = db.calls.select.find(c => c.table === 'memory_settings');
  const needed = ['per_prompt_matches', 'gate', 'scope_boost', 'session_budget_tokens', 'capture', 'capture_window'];
  for (const column of needed) {
    assert.ok(columns.includes(column), `${column} is read by the lifecycle path and must be selected`);
    assert.ok(fallback[column] !== undefined, `${column} must also have a fallback when no row exists`);
  }
  // A fallback that disagrees with the column default makes behaviour depend on
  // whether a settings row happens to exist.
  assert.equal(fallback.gate, 0.67);
  assert.equal(fallback.capture, true);
  assert.equal(fallback.capture_window, 5);
});

test('Stop classifies the last turn against everything before it', async () => {
  // This ran through a ReferenceError for its whole life: `context` was read
  // before a block-scoped `const context` declared four lines later, and the
  // catch turned it into a generic "memory unavailable" string, so capture
  // never happened and nothing said so.
  const captured = [];
  const window = [
    // sessionWindow returns newest first, and the code reverses it.
    {role: 'user', content: 'and never bump the Go version until payouts ship'},
    {role: 'assistant', content: 'Understood.'},
    {role: 'user', content: 'what is the release order again'},
  ];
  const service = {
    status: async () => ({label: 'Test', personal: true, can_write: true, project_ids: []}),
    settings: async () => ({per_prompt_matches: 5, gate: 0.67, scope_boost: 1.1,
      session_budget_tokens: 15000, capture: true, capture_window: 1}),
    recordSessionMessage: async () => {},
    sessionWindow: async () => window,
    projects: async () => [{id: 'p1', slug: 'ledger', brief: 'The ledger'}],
    openTasks: async () => [{slug: 'payouts', title: 'Ship payouts', project_id: 'p1'}],
    captureTurn: async (sessionKey, input) => { captured.push({sessionKey, input}); },
  };
  const server = createMemoryServer(service);
  const client = new Client({name: 'test', version: '1'});
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right);
  await client.connect(left);
  try {
    await client.callTool({name: 'load_memory_context', arguments: {session_key: 'stop-session', event: 'Stop'}});
    assert.equal(captured.length, 1, 'Stop must reach captureTurn');
    const {input} = captured[0];
    // capture_window is 1, so the turn is the last user message only and
    // everything before it is context that may not supply a source.
    assert.deepEqual(input.turn, ['and never bump the Go version until payouts ship']);
    assert.deepEqual(input.context.map(m => m.content),
      ['what is the release order again', 'Understood.']);
    assert.deepEqual(input.projects, [{slug: 'ledger', brief: 'The ledger'}]);
    assert.deepEqual(input.tasks, [{slug: 'payouts', title: 'Ship payouts', project: 'ledger'}]);
  } finally { await client.close(); await server.close(); }
});

test('an unsubstituted assistant placeholder is never recorded as speech', async () => {
  // Codex has no last_assistant_message, so the placeholder arrives as its own
  // literal text. Recording it would put "${last_assistant_message}" into the
  // window the router reads, on every turn, on that whole host.
  const recorded = [];
  const service = {
    status: async () => ({label: 'Test', personal: true, can_write: true, project_ids: []}),
    settings: async () => ({per_prompt_matches: 5, gate: 0.67, scope_boost: 1.1,
      session_budget_tokens: 15000, capture: true, capture_window: 5}),
    recordSessionMessage: async (_key, role, content) => { recorded.push({role, content}); },
    sessionWindow: async () => [],
    captureTurn: async () => {},
  };
  const server = createMemoryServer(service);
  const client = new Client({name: 'test', version: '1'});
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right);
  await client.connect(left);
  try {
    await client.callTool({name: 'load_memory_context', arguments: {
      session_key: 's', event: 'Stop', last_assistant_message: '${last_assistant_message}'}});
    assert.deepEqual(recorded, [], 'a bare placeholder is not something the assistant said');
    await client.callTool({name: 'load_memory_context', arguments: {
      session_key: 's', event: 'Stop', last_assistant_message: 'Real reply.'}});
    assert.deepEqual(recorded, [{role: 'assistant', content: 'Real reply.'}]);
  } finally { await client.close(); await server.close(); }
});

test('Stop stays silent when capture is switched off', async () => {
  let called = false;
  const service = {
    status: async () => ({label: 'Test', personal: true, can_write: true, project_ids: []}),
    settings: async () => ({per_prompt_matches: 5, gate: 0.67, scope_boost: 1.1,
      session_budget_tokens: 15000, capture: false, capture_window: 5}),
    recordSessionMessage: async () => { called = true; },
    sessionWindow: async () => { called = true; return []; },
    captureTurn: async () => { called = true; },
  };
  const server = createMemoryServer(service);
  const client = new Client({name: 'test', version: '1'});
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right);
  await client.connect(left);
  try {
    await client.callTool({name: 'load_memory_context',
      arguments: {session_key: 's', event: 'UserPromptSubmit', prompt: 'hello'}});
    await client.callTool({name: 'load_memory_context', arguments: {session_key: 's', event: 'Stop'}});
    assert.equal(called, false, 'nothing about the conversation may be recorded when capture is off');
  } finally { await client.close(); await server.close(); }
});

const hookOf = result => JSON.parse(result.content[0].text);

async function connect(service) {
  const server = createMemoryServer(service);
  const client = new Client({name: 'test', version: '1'});
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right);
  await client.connect(left);
  return {client, close: async () => { await client.close(); await server.close(); }};
}

const baseSettings = {per_prompt_matches: 5, gate: 0.67, scope_boost: 1.1,
  session_budget_tokens: 15000, capture: true, capture_window: 5};

test('a dead grant says so to the person, not only to the model', async () => {
  // This is the whole reason the notice exists. A revoked grant made every
  // hook inject "memory unavailable" to the model and show the person
  // nothing, so a broken Satchel and a quiet one looked identical.
  const {client, close} = await connect({
    status: async () => { throw {code: '42501'}; },
    settings: async () => baseSettings,
  });
  try {
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
      const hook = hookOf(await client.callTool({name: 'load_memory_context',
        arguments: {session_key: 's', event, ...(event === 'UserPromptSubmit' ? {prompt: 'hi'} : {})}}));
      assert.match(hook.systemMessage, /Satchel memory unavailable/, `${event} must tell the person`);
    }
  } finally { await close(); }
});

test('Stop reports a capture and stays silent otherwise, and never injects', async () => {
  let captured = [];
  const service = {
    status: async () => ({label: 'Test', personal: true, can_write: true, project_ids: []}),
    settings: async () => ({...baseSettings, capture_window: 1}),
    recordSessionMessage: async () => {},
    sessionWindow: async () => [{role: 'user', content: 'never bump Go until payouts ship'}],
    projects: async () => [],
    openTasks: async () => [],
    captureTurn: async () => ({memories: captured, dropped: 0}),
  };
  const {client, close} = await connect(service);
  try {
    captured = [{id: 'a'}];
    const spoke = hookOf(await client.callTool({name: 'load_memory_context',
      arguments: {session_key: 's', event: 'Stop'}}));
    assert.match(spoke.systemMessage, /noted 1 thing you said · unconfirmed/,
      'a memory written without being asked for has to be announced');
    assert.equal(spoke.hookSpecificOutput.additionalContext, '',
      'Stop never injects: Codex cannot, so a design that used it would work on one host only');

    captured = [];
    const quiet = await client.callTool({name: 'load_memory_context',
      arguments: {session_key: 's', event: 'Stop'}});
    assert.equal(hookOf(quiet).systemMessage, undefined, 'capturing nothing is the normal turn and stays silent');
  } finally { await close(); }
});

test('retrieval speaks only when it found something', async () => {
  let rows = [];
  const service = {
    status: async () => ({label: 'Test', personal: true, can_write: true, project_ids: []}),
    settings: async () => baseSettings,
    recordSessionMessage: async () => {},
    activeProject: async () => null,
    search: async () => rows,
    logInjection: async () => {},
  };
  const {client, close} = await connect(service);
  const ask = () => client.callTool({name: 'load_memory_context',
    arguments: {session_key: 's', event: 'UserPromptSubmit', prompt: 'what did we decide'}});
  try {
    rows = [{id: crypto.randomUUID(), statement: 'A thing.', band: 'said', score: 0.9, matched: 4, in_scope: 30}];
    assert.match(hookOf(await ask()).systemMessage, /recalled 1 of 4 matching/,
      'the counts are the point: 1 of 4 and 1 of 1 mean different things');

    rows = [];
    const quiet = await ask();
    assert.equal(hookOf(quiet).systemMessage, undefined,
      'finding nothing is the common case; a line on every prompt is noise people learn to ignore');
  } finally { await close(); }
});

test('a rate limit tells the person what actually happened', async () => {
  // Retrieval failing on a spent embedding quota showed "Satchel memory
  // unavailable · Satchel request failed. Reload before retrying a write: it
  // may have completed." Every part of that after the first four words is
  // wrong: there was no write, reloading does nothing, and the one fact that
  // would have ended the debugging (the day's free quota is gone) was thrown
  // away with the response body.
  const spent = Object.assign(new Error('gemini-embedding-001 is rate limited'),
    {code: 'EMB_LIMIT', reason: "embedding is rate limited, the day's free quota is used up (1000 requests)"});
  const {client, close} = await connect({
    status: async () => ({label: 'Test', personal: true, can_write: true, project_ids: []}),
    settings: async () => baseSettings,
    recordSessionMessage: async () => {},
    activeProject: async () => null,
    search: async () => { throw spent; },
  });
  try {
    const hook = hookOf(await client.callTool({name: 'load_memory_context',
      arguments: {session_key: 's', event: 'UserPromptSubmit', prompt: 'what did we decide'}}));
    assert.match(hook.systemMessage, /day's free quota is used up \(1000 requests\)/);
    assert.doesNotMatch(hook.systemMessage, /Reload before retrying a write/,
      'nothing was written, so do not tell the person a write may have completed');
    // The model is told the same thing, and told not to pretend otherwise.
    assert.match(hook.hookSpecificOutput.additionalContext, /day's free quota is used up/);
    assert.match(hook.hookSpecificOutput.additionalContext, /Do not claim that memory loaded/);
  } finally { await close(); }
});
