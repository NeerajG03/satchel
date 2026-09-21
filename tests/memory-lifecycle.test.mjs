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
import {createEmbedder} from '../server/embedding.mjs';

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

// Shaped from the real embedder rather than by hand, because a fake that has
// drifted from the thing it stands in for is how three bugs reached production
// past a green suite. The assertion below is what keeps it honest.
const embedder = {model: 'test-model',
  embed: async texts => texts.map(() => Array(768).fill(0.1)),
  embedOne: async () => Array(768).fill(0.1),
  embedQuery: async () => Array(768).fill(0.1)};

// What every fake service must answer now that scope is resolved rather than
// guessed. The handler asks for the active project on both branches and falls
// back to a staged repository hint when there is none, which is what lets a
// launched session know its own project without a model tool call.
const scopeStubs = {
  activeProject: async () => null,
  repositoryHintExists: async () => false,
  activateRepositoryHint: async () => null,
  capturedThisSession: async () => [],
  markSessionClassified: async () => 1,
  repositoryCandidates: async () => [],
};

test('the fake embedder still has the shape the service calls', () => {
  const real = createEmbedder({apiKey: 'unused'});
  for (const method of ['embed', 'embedOne', 'embedQuery'])
    assert.equal(typeof real[method], 'function', `${method} must exist on the real embedder`);
  for (const key of Object.keys(embedder))
    assert.ok(key === 'model' || typeof real[key] === 'function',
      `the fake has ${key}, which the real embedder does not`);
  assert.equal(typeof real.model, 'string');
});

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

test('the turn is what has not been classified, and the scope is resolved not guessed', async () => {
  // Two bugs in one test, because they produced one symptom.
  //
  // The turn used to be the last capture_window user messages, and the default
  // is 5, so every Stop re-offered the last five and consecutive Stops
  // overlapped by four. One sentence about a paid key got five chances and was
  // saved twice, thirty-six seconds apart, in two wordings.
  //
  // And the router got a flat list of every project with nothing saying which
  // one the conversation was in, so it inferred the scope from the words. The
  // words said "vercel", not "satchel", so a memory about this project's own
  // deployment key was filed under personal.
  //
  // This also ran through a ReferenceError for its whole life: `context` was
  // read before a block-scoped `const context` declared four lines later, and
  // the catch turned it into a generic "memory unavailable" string.
  const captured = [];
  const marked = [];
  // sessionWindow returns newest first, and the code reverses it.
  const window = [
    {id: 5, role: 'assistant', content: 'Noted.', classified_at: null},
    {id: 4, role: 'user', content: 'and never bump the Go version until payouts ship', classified_at: null},
    {id: 3, role: 'assistant', content: 'Understood.', classified_at: '2026-09-21T06:00:00Z'},
    {id: 2, role: 'user', content: 'what is the release order again', classified_at: '2026-09-21T06:00:00Z'},
  ];
  const service = {
    ...scopeStubs,
    status: async () => ({label: 'Test', personal: true, can_write: true, project_ids: []}),
    settings: async () => ({per_prompt_matches: 5, gate: 0.67, scope_boost: 1.1,
      session_budget_tokens: 15000, capture: true, capture_window: 5}),
    recordSessionMessage: async () => {},
    sessionWindow: async () => window,
    // Nothing selected the project, which is the launched-session case: the
    // mcp_tool SessionStart hook is skipped at launch, so the bootstrap's
    // staged repository is the only thing that knows the scope.
    activeProject: async () => null,
    repositoryHintExists: async () => true,
    activateRepositoryHint: async () => 'p1',
    projects: async () => [
      {id: 'p1', slug: 'ledger', brief: 'The ledger',
        project_repositories: [{provider: 'github', repository: 'acme/ledger'}]},
      {id: 'p2', slug: 'sourdough', brief: 'Baking', project_repositories: []},
    ],
    openTasks: async () => [{slug: 'payouts', title: 'Ship payouts', project_id: 'p1'}],
    capturedThisSession: async () => ['Deploys go out on Tuesday mornings.'],
    markSessionClassified: async (key, through) => { marked.push({key, through}); return 1; },
    captureTurn: async (sessionKey, input) => { captured.push({sessionKey, input}); return {memories: [], failed: false}; },
  };
  const {client, close} = await connect(service);
  try {
    await client.callTool({name: 'load_memory_context', arguments: {session_key: 'stop-session', event: 'Stop'}});
    assert.equal(captured.length, 1, 'Stop must reach captureTurn');
    const {input} = captured[0];

    // Capture_window is 5 and there are two user messages in the window, so the
    // old code would have offered both. Only the unclassified one is the turn.
    assert.deepEqual(input.turn, ['and never bump the Go version until payouts ship']);
    assert.deepEqual(input.context.map(m => m.content),
      ['what is the release order again', 'Understood.'],
      'everything already classified is context, which may not supply a source');

    // Scope, resolved from the staged repository with no model involved.
    assert.deepEqual(input.project, {slug: 'ledger', brief: 'The ledger'});
    assert.equal(input.codebase, 'acme/ledger');
    assert.deepEqual(input.projects, [{slug: 'sourdough', brief: 'Baking'}],
      'the active project is named on its own and not repeated among the others');
    assert.deepEqual(input.tasks, [{slug: 'payouts', title: 'Ship payouts', project: 'ledger'}]);
    assert.deepEqual(input.saved, ['Deploys go out on Tuesday mornings.']);

    // And the boundary moves, through the newest row in the window, so the
    // assistant reply just recorded is never offered again either.
    assert.deepEqual(marked, [{key: 'stop-session', through: 5}]);
  } finally { await close(); }
});

test('a run that never reached the model leaves the turn for next time', async () => {
  // Otherwise a rate-limited turn is classified as "nothing to keep" and the
  // thing the user said is lost for good, which is the opposite of the failure
  // this whole change is about.
  const marked = [];
  const service = {
    ...scopeStubs,
    status: async () => ({label: 'Test', personal: true, can_write: true, project_ids: []}),
    settings: async () => ({...baseSettings}),
    recordSessionMessage: async () => {},
    sessionWindow: async () => [{id: 9, role: 'user', content: 'never bump Go', classified_at: null}],
    projects: async () => [],
    openTasks: async () => [],
    markSessionClassified: async (key, through) => { marked.push({key, through}); return 1; },
    captureTurn: async () => ({memories: [], dropped: 0, failed: true}),
  };
  const {client, close} = await connect(service);
  try {
    await client.callTool({name: 'load_memory_context', arguments: {session_key: 's', event: 'Stop'}});
    assert.deepEqual(marked, [], 'a failed run must not move the boundary');
  } finally { await close(); }
});

test('a turn with nothing unclassified in it is not sent at all', async () => {
  let called = false;
  const service = {
    ...scopeStubs,
    status: async () => ({label: 'Test', personal: true, can_write: true, project_ids: []}),
    settings: async () => ({...baseSettings}),
    recordSessionMessage: async () => {},
    sessionWindow: async () => [
      {id: 2, role: 'assistant', content: 'Noted.', classified_at: null},
      {id: 1, role: 'user', content: 'never bump Go', classified_at: '2026-09-21T06:00:00Z'},
    ],
    captureTurn: async () => { called = true; return {memories: [], failed: false}; },
  };
  const {client, close} = await connect(service);
  try {
    await client.callTool({name: 'load_memory_context', arguments: {session_key: 's', event: 'Stop'}});
    assert.equal(called, false, 'a reply with no new user message is not a turn to classify');
  } finally { await close(); }
});

test('an unsubstituted assistant placeholder is never recorded as speech', async () => {
  // Codex has no last_assistant_message, so the placeholder arrives as its own
  // literal text. Recording it would put "${last_assistant_message}" into the
  // window the router reads, on every turn, on that whole host.
  const recorded = [];
  const service = {
    ...scopeStubs,
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
    ...scopeStubs,
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
    ...scopeStubs,
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
    ...scopeStubs,
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
    ...scopeStubs,
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

test('an ambiguous repository names the choice rather than picking one', async () => {
  // A codebase can belong to several projects, so the repository stops being an
  // identifier. Picking one would put a memory in a real project that is the
  // wrong project, which is worse than personal: personal is at least visibly
  // unscoped and loads everywhere.
  const {client, close} = await connect({
    ...scopeStubs,
    status: async () => ({label: 'Test', personal: true, can_write: true, project_ids: []}),
    settings: async () => baseSettings,
    recordSessionMessage: async () => {},
    activeProject: async () => null,
    // Staged, but activation declined to resolve it, which is the only way
    // those two answers happen together.
    repositoryHintExists: async () => true,
    activateRepositoryHint: async () => null,
    repositoryCandidates: async () => [
      {project_id: 'p1', slug: 'email-self-serve', name: 'Email self serve', brief: ''},
      {project_id: 'p2', slug: 'data-model-2-0', name: 'Data model 2.0', brief: ''},
    ],
    projects: async () => [],
    personal: async () => [],
  });
  try {
    const hook = hookOf(await client.callTool({name: 'load_memory_context',
      arguments: {session_key: 's', event: 'SessionStart'}}));
    const context = hook.hookSpecificOutput.additionalContext;
    assert.match(context, /belongs to 2 projects/);
    // By id, because that is what select_project takes. A slug it would have to
    // look up is a second place to go wrong.
    assert.match(context, /email-self-serve \(p1\)/);
    assert.match(context, /data-model-2-0 \(p2\)/);
    assert.doesNotMatch(context, /active project:/, 'nothing is scoped until it is chosen');
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
    ...scopeStubs,
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
