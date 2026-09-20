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
