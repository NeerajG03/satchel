// The lifecycle, driven the way the hook scripts drive it.
//
// These used to go through the load_memory_context MCP tool, because that is
// how hooks reached the server until 0.3.0. The tool is gone: hooks are command
// scripts holding their own OAuth credential, and they POST to two endpoints.
// So these call the same functions those endpoints call, which is one fewer
// layer of pretending.
//
// The three bugs this file originally pinned all shipped green, because the MCP
// tests drive a hand-written fake service and the database tests never go
// through the service. Each one was invisible in production rather than loud:
// retrieval returned nothing, and capture simply never happened.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMemoryServer} from '../server/mcp-server.mjs';
import {memoryService} from '../server/memory-service.mjs';
import {createEmbedder} from '../server/embedding.mjs';
import {sessionStart, capture} from '../server/lifecycle.mjs';

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

const baseSettings = {gate: 0.67, scope_boost: 1.1,
  session_budget_tokens: 15000, capture: true, capture_window: 5};

const connected = {label: 'Test', personal: true, can_write: true, project_ids: []};

// What every fake service must answer now that scope is resolved rather than
// guessed. resolveRepository replaced the staged-hint pair: the script that
// knows the repository is authenticated, so it sends the name and gets the
// answer, with no row staged in between and nothing to poll for.
const scopeStubs = {
  activeProject: async () => null,
  resolveRepository: async () => [],
  capturedThisSession: async () => [],
  markSessionClassified: async () => 1,
  logInjection: async () => {},
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

test('settings carry every column the lifecycle path reads', async () => {
  // per_prompt_matches is deliberately not in this list any more. Per-prompt
  // retrieval is gone: a command hook on UserPromptSubmit is not handed the
  // prompt text, and the only documented way to reach it is to read the
  // transcript while the host is still writing it. The column still exists in
  // the table; nothing reads it.
  const db = recorder({memory_settings: [{...baseSettings}]});
  const service = memoryService(db, embedder, null);
  const settings = await service.settings();
  const needed = ['gate', 'scope_boost', 'session_budget_tokens', 'capture', 'capture_window'];
  const selected = db.calls.select.find(call => call.table === 'memory_settings').columns;
  for (const column of needed) {
    assert.ok(selected.includes(column), `settings must select ${column}`);
    assert.notEqual(settings[column], undefined, `settings must return ${column}`);
  }
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
  const captured = [];
  const marked = [];
  const recorded = [];
  // sessionWindow returns newest first, and the code reverses it.
  const window = [
    {id: 5, role: 'assistant', content: 'Noted.', classified_at: null},
    {id: 4, role: 'user', content: 'and never bump the Go version until payouts ship', classified_at: null},
    {id: 3, role: 'assistant', content: 'Understood.', classified_at: '2026-09-21T06:00:00Z'},
    {id: 2, role: 'user', content: 'what is the release order again', classified_at: '2026-09-21T06:00:00Z'},
  ];
  const service = {
    ...scopeStubs,
    status: async () => connected,
    settings: async () => ({...baseSettings}),
    recordSessionMessage: async (_key, role, content) => { recorded.push({role, content}); },
    sessionWindow: async () => window,
    // Nothing selected the project, so the workspace's repository is what
    // resolves it. One candidate, so it is chosen with no model involved.
    resolveRepository: async (_session, _provider, repository) =>
      repository === 'acme/ledger'
        ? [{project_id: 'p1', slug: 'ledger', name: 'Ledger', brief: 'The ledger', selected: true}] : [],
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

  await capture(service, {sessionKey: 'stop-session', repository: 'acme/ledger', messages: [
    {role: 'user', content: 'and never bump the Go version until payouts ship'},
    {role: 'assistant', content: 'Noted.'},
  ]});

  // What the script read is recorded first, in the order it happened, because
  // the window the router reads is built from exactly this.
  assert.deepEqual(recorded, [
    {role: 'user', content: 'and never bump the Go version until payouts ship'},
    {role: 'assistant', content: 'Noted.'},
  ]);

  assert.equal(captured.length, 1, 'Stop must reach captureTurn');
  const {input} = captured[0];

  // capture_window is 5 and there are two user messages in the window, so the
  // old code would have offered both. Only the unclassified one is the turn.
  assert.deepEqual(input.turn, ['and never bump the Go version until payouts ship']);
  assert.deepEqual(input.context.map(m => m.content),
    ['what is the release order again', 'Understood.'],
    'everything already classified is context, which may not supply a source');

  // Scope, resolved from the repository with no model involved.
  assert.deepEqual(input.project, {slug: 'ledger', brief: 'The ledger'});
  assert.equal(input.codebase, 'acme/ledger');
  assert.deepEqual(input.projects, [{slug: 'sourdough', brief: 'Baking'}],
    'the active project is named on its own and not repeated among the others');
  assert.deepEqual(input.tasks, [{slug: 'payouts', title: 'Ship payouts', project: 'ledger'}]);
  assert.deepEqual(input.saved, ['Deploys go out on Tuesday mornings.']);

  // And the boundary moves, through the newest row in the window, so the
  // assistant reply just recorded is never offered again either.
  assert.deepEqual(marked, [{key: 'stop-session', through: 5}]);
});

test('a run that never reached the model leaves the turn for next time', async () => {
  // Otherwise a rate-limited turn is classified as "nothing to keep" and the
  // thing the user said is lost for good, which is the opposite of the failure
  // this whole change is about.
  const marked = [];
  await capture({
    ...scopeStubs,
    status: async () => connected,
    settings: async () => ({...baseSettings}),
    recordSessionMessage: async () => {},
    sessionWindow: async () => [{id: 9, role: 'user', content: 'never bump Go', classified_at: null}],
    projects: async () => [],
    openTasks: async () => [],
    markSessionClassified: async (key, through) => { marked.push({key, through}); return 1; },
    captureTurn: async () => ({memories: [], dropped: 0, failed: true}),
  }, {sessionKey: 's', messages: [{role: 'user', content: 'never bump Go'}]});
  assert.deepEqual(marked, [], 'a failed run must not move the boundary');
});

test('a turn with nothing unclassified in it is not sent at all', async () => {
  let called = false;
  await capture({
    ...scopeStubs,
    status: async () => connected,
    settings: async () => ({...baseSettings}),
    recordSessionMessage: async () => {},
    sessionWindow: async () => [
      {id: 2, role: 'assistant', content: 'Noted.', classified_at: null},
      {id: 1, role: 'user', content: 'never bump Go', classified_at: '2026-09-21T06:00:00Z'},
    ],
    captureTurn: async () => { called = true; return {memories: [], failed: false}; },
  }, {sessionKey: 's', messages: [{role: 'assistant', content: 'Noted.'}]});
  assert.equal(called, false, 'a reply with no new user message is not a turn to classify');
});

test('capture switched off records nothing at all', async () => {
  // Not "captures nothing": records nothing. The setting is about whether the
  // conversation is kept, so a turn must not reach session_messages either.
  let called = false;
  await capture({
    ...scopeStubs,
    status: async () => connected,
    settings: async () => ({...baseSettings, capture: false}),
    recordSessionMessage: async () => { called = true; },
    sessionWindow: async () => { called = true; return []; },
    captureTurn: async () => { called = true; },
  }, {sessionKey: 's', messages: [{role: 'user', content: 'hello'}]});
  assert.equal(called, false, 'nothing about the conversation may be recorded when capture is off');
});

test('a dead grant says so to the person, not only to the agent', async () => {
  // This is the whole reason the notice exists. A revoked grant made every
  // hook inject "memory unavailable" to the model and show the person
  // nothing, so a broken Satchel and a quiet one looked identical.
  const dead = {...scopeStubs, status: async () => { throw {code: '42501'}; }, settings: async () => baseSettings};
  const start = await sessionStart(dead, {sessionKey: 's'});
  assert.match(start.notice, /Satchel memory unavailable/, 'session start must tell the person');
  assert.match(start.context, /Do not claim that memory loaded/, 'and must tell the agent not to pretend');
  const stopped = await capture(dead, {sessionKey: 's', messages: [{role: 'user', content: 'hi'}]});
  assert.match(stopped.notice, /Satchel memory unavailable/, 'the end of a turn must tell the person too');
});

test('a capture is announced and a quiet turn stays quiet, and neither injects', async () => {
  let captured = [];
  const service = {
    ...scopeStubs,
    status: async () => connected,
    settings: async () => ({...baseSettings, capture_window: 1}),
    recordSessionMessage: async () => {},
    sessionWindow: async () => [{id: 1, role: 'user', content: 'never bump Go until payouts ship', classified_at: null}],
    projects: async () => [],
    openTasks: async () => [],
    captureTurn: async () => ({memories: captured, dropped: 0, failed: false}),
  };
  const run = () => capture(service, {sessionKey: 's', messages: [{role: 'user', content: 'never bump Go until payouts ship'}]});

  captured = [{id: 'a', statement: 'Do not bump Go until payouts ship.'}];
  const spoke = await run();
  assert.match(spoke.notice, /noted 1 thing you said · unconfirmed/,
    'a memory written without being asked for has to be announced');
  assert.equal(spoke.captured, 1);

  captured = [];
  const quiet = await run();
  assert.equal(quiet.notice, '', 'capturing nothing is the normal turn and stays silent');
});

test('an ambiguous repository names the choice rather than picking one', async () => {
  // A codebase can belong to several projects, so the repository stops being an
  // identifier. Picking one would put a memory in a real project that is the
  // wrong project, which is worse than personal: personal is at least visibly
  // unscoped and loads everywhere.
  const result = await sessionStart({
    ...scopeStubs,
    status: async () => connected,
    settings: async () => baseSettings,
    // Two candidates, so resolve_agent_repository selects none of them.
    resolveRepository: async () => [
      {project_id: 'p1', slug: 'email-self-serve', name: 'Email self serve', brief: '', selected: false},
      {project_id: 'p2', slug: 'data-model-2-0', name: 'Data model 2.0', brief: '', selected: false},
    ],
    projects: async () => [],
    personal: async () => [],
  }, {sessionKey: 's', repository: 'cbx1/backend'});

  assert.equal(result.active_project, null);
  assert.match(result.context, /belongs to 2 projects/);
  // By id, because that is what select_project takes. A slug it would have to
  // look up is a second place to go wrong.
  assert.match(result.context, /email-self-serve \(p1\)/);
  assert.match(result.context, /data-model-2-0 \(p2\)/);
  assert.doesNotMatch(result.context, /active project:/, 'nothing is scoped until it is chosen');
});

test('a rate limit tells the person what actually happened', async () => {
  // Capture failing on a spent embedding quota showed "Satchel memory
  // unavailable · Satchel request failed. Reload before retrying a write: it
  // may have completed." Every part of that after the first four words is
  // wrong: there was no write, reloading does nothing, and the one fact that
  // would have ended the debugging (the day's free quota is gone) was thrown
  // away with the response body.
  const spent = Object.assign(new Error('gemini-embedding-001 is rate limited'),
    {code: 'EMB_LIMIT', reason: "embedding is rate limited, the day's free quota is used up (1000 requests)"});
  const result = await capture({
    ...scopeStubs,
    status: async () => connected,
    settings: async () => baseSettings,
    recordSessionMessage: async () => {},
    sessionWindow: async () => [{id: 1, role: 'user', content: 'what did we decide', classified_at: null}],
    projects: async () => [],
    openTasks: async () => [],
    captureTurn: async () => { throw spent; },
  }, {sessionKey: 's', messages: [{role: 'user', content: 'what did we decide'}]});

  assert.match(result.notice, /day's free quota is used up \(1000 requests\)/);
  assert.doesNotMatch(result.notice, /Reload before retrying a write/,
    'nothing was written, so do not tell the person a write may have completed');
});

test('retrieve_memory with no embedder configured says so, not that a write may have completed', async () => {
  // memory-service.mjs threw {code:'PT503'} with no reason, which is exactly
  // the shape errorText's fallback exists for: it fell through the code table
  // to "Satchel request failed. Reload before retrying a write: it may have
  // completed." retrieve_memory is read-only, and no request was even sent to
  // an embedder, so every word of that fallback was wrong.
  const db = recorder({agent_connection_status: {label: 'Test', personal: true, project_ids: []}});
  const server = createMemoryServer(memoryService(db, null));
  const client = new Client({name: 'test', version: '1'});
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right);
  await client.connect(left);
  try {
    const result = await client.callTool({name: 'retrieve_memory', arguments: {query: 'anything'}});
    assert.equal(result.isError, true);
    const {error} = JSON.parse(result.content[0].text);
    assert.doesNotMatch(error, /Reload before retrying a write/,
      'nothing was written, and nothing was even sent to an embedder');
    assert.match(error, /no embedding model is configured/i);
  } finally { await client.close(); await server.close(); }
});
