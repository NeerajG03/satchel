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
import {sessionStart, retrieve, capture} from '../server/lifecycle.mjs';

/** Records what the service actually sends, the way supabase-js would take it. */
function recorder(responses = {}) {
  const calls = {rpc: [], select: [], update: []};
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
        // Writing the vector is an update, and it was the one call this
        // recorder could not see. That blind spot is why capture shipped
        // without it.
        update(values) {
          calls.update.push({table, values});
          return {eq: () => answer(null)};
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

const baseSettings = {per_prompt_matches: 5, gate: 0.67, scope_boost: 1.1,
  session_budget_tokens: 15000, capture: true, capture_window: 5, capture_mode: 'turn'};

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
  const db = recorder({memory_settings: [{...baseSettings}]});
  const service = memoryService(db, embedder, null);
  const settings = await service.settings();
  const needed = ['per_prompt_matches', 'gate', 'scope_boost', 'session_budget_tokens', 'capture', 'capture_window'];
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
    recordTurn: async (_key, role, content) => { recorded.push({role, content}); },
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
    capturedThisSession: async () => ['Deploys go out on Tuesday mornings.'],
    markSessionClassified: async (key, through) => { marked.push({key, through}); return 1; },
    captureTurn: async (sessionKey, input) => { captured.push({sessionKey, input}); return {memories: [], failed: false}; },
  };

  await capture(service, {sessionKey: 'stop-session', repository: 'acme/ledger', assistant: 'Noted.'});

  // The user's half was recorded by retrieve() when the prompt arrived; Stop
  // adds only the reply the host handed it. Nothing is read from disk.
  assert.deepEqual(recorded, [{role: 'assistant', content: 'Noted.'}]);

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
  assert.equal('tasks' in input, false,
    'a memory has one scope, so a list of open work is not the router\u2019s business');
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
    recordTurn: async () => {},
    sessionWindow: async () => [{id: 9, role: 'user', content: 'never bump Go', classified_at: null}],
    projects: async () => [],
    markSessionClassified: async (key, through) => { marked.push({key, through}); return 1; },
    captureTurn: async () => ({memories: [], dropped: 0, failed: true}),
  }, {sessionKey: 's', assistant: 'Understood.'});
  assert.deepEqual(marked, [], 'a failed run must not move the boundary');
});

test('a turn with nothing unclassified in it is not sent at all', async () => {
  let called = false;
  await capture({
    ...scopeStubs,
    status: async () => connected,
    settings: async () => ({...baseSettings}),
    recordTurn: async () => {},
    sessionWindow: async () => [
      {id: 2, role: 'assistant', content: 'Noted.', classified_at: null},
      {id: 1, role: 'user', content: 'never bump Go', classified_at: '2026-09-21T06:00:00Z'},
    ],
    captureTurn: async () => { called = true; return {memories: [], failed: false}; },
  }, {sessionKey: 's', assistant: 'Noted.'});
  assert.equal(called, false, 'a reply with no new user message is not a turn to classify');
});

test('retrieval records the prompt whether or not it finds anything', async () => {
  // The coupling that made deleting this feature expensive: the rolling window
  // the router reads at the end of the turn is built from exactly this call,
  // so removing retrieval silently removed capture too.
  const recorded = [];
  const service = {
    ...scopeStubs,
    status: async () => connected,
    settings: async () => baseSettings,
    recordTurn: async (_k, role, content) => { recorded.push({role, content}); },
    search: async () => [],
    projects: async () => [],
  };
  const quiet = await retrieve(service, {sessionKey: 's', prompt: 'what did we decide about Go'});
  assert.deepEqual(recorded, [{role: 'user', content: 'what did we decide about Go'}]);
  assert.equal(quiet.context, '', 'nothing relevant costs nothing');
  assert.equal(quiet.notice, '', 'and says nothing');

  service.search = async () => [{id: crypto.randomUUID(), statement: 'Do not bump Go until payouts ship.',
    band: 'said', task_id: null, score: 0.9, matched: 4, in_scope: 30}];
  const found = await retrieve(service, {sessionKey: 's', prompt: 'can we bump Go'});
  assert.match(found.context, /1 shown · 4 matched · 30 in scope/,
    'the counts separate "no rule about this" from "nothing scored high enough"');
  assert.match(found.context, /Do not bump Go until payouts ship\./);
  assert.match(found.notice, /recalled 1 of 4 matching/);
  assert.equal(recorded.length, 2);
});

test('retrieval passes the prompt as the query and nothing else', async () => {
  const searched = [];
  await retrieve({
    ...scopeStubs,
    status: async () => connected,
    settings: async () => baseSettings,
    recordTurn: async () => {},
    search: async args => { searched.push(args); return []; },
    resolveRepository: async () => [{project_id: 'p1', slug: 'a', name: 'A', brief: '', selected: true}],
  }, {sessionKey: 's', prompt: 'the release order', repository: 'acme/ledger'});
  assert.equal(searched.length, 1);
  assert.equal(searched[0].query, 'the release order');
  // Scope is a nudge, not a filter, and it comes from the repository rather
  // than from anything the model decided.
  assert.equal(searched[0].in_scope, 'p1');
});

test('a failed search tells the person and injects nothing', async () => {
  const spent = Object.assign(new Error('rate limited'),
    {code: 'EMB_LIMIT', reason: "embedding is rate limited, the day's free quota is used up (1000 requests)"});
  const result = await retrieve({
    ...scopeStubs,
    status: async () => connected,
    settings: async () => baseSettings,
    recordTurn: async () => {},
    search: async () => { throw spent; },
  }, {sessionKey: 's', prompt: 'anything'});
  assert.equal(result.context, '', 'a broken search must not inject an error into the prompt');
  assert.match(result.notice, /day's free quota is used up/);
});

test('capture switched off records nothing at all', async () => {
  // Not "captures nothing": records nothing. The setting is about whether the
  // conversation is kept, so a turn must not reach session_messages either.
  let called = false;
  await capture({
    ...scopeStubs,
    status: async () => connected,
    settings: async () => ({...baseSettings, capture: false}),
    recordTurn: async () => { called = true; },
    sessionWindow: async () => { called = true; return []; },
    captureTurn: async () => { called = true; },
  }, {sessionKey: 's', assistant: 'Hello back.'});
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
  const stopped = await capture(dead, {sessionKey: 's', assistant: 'hi'});
  assert.match(stopped.notice, /Satchel memory unavailable/, 'the end of a turn must tell the person too');
});

test('a capture is announced and a quiet turn stays quiet, and neither injects', async () => {
  let captured = [];
  const service = {
    ...scopeStubs,
    status: async () => connected,
    settings: async () => ({...baseSettings, capture_window: 1}),
    recordTurn: async () => {},
    sessionWindow: async () => [{id: 1, role: 'user', content: 'never bump Go until payouts ship', classified_at: null}],
    projects: async () => [],
    captureTurn: async () => ({memories: captured, dropped: 0, failed: false}),
  };
  const run = () => capture(service, {sessionKey: 's', assistant: 'Noted.'});

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

test('the linked set is read without changing a scope the person already chose', async () => {
  // The session key survives a /clear, so an explicit select_project made
  // earlier is still active when the session-start hook runs again. The block
  // still needs to know which projects belong to this codebase, so it asks,
  // but read-only: re-resolving with selection on would quietly overwrite the
  // scope the person picked.
  const asked = [];
  const service = {
    ...scopeStubs,
    status: async () => connected,
    settings: async () => baseSettings,
    activeProject: async () => 'chosen-by-hand',
    resolveRepository: async (_s, _p, repository, select) => {
      asked.push({repository, select});
      return [{project_id: 'p1', slug: 'a', name: 'A', brief: '', selected: false},
        {project_id: 'p2', slug: 'b', name: 'B', brief: '', selected: false}];
    },
    projects: async () => [
      {id: 'p1', slug: 'a', brief: ''}, {id: 'p2', slug: 'b', brief: ''}, {id: 'p3', slug: 'c', brief: ''}],
    personal: async () => [],
  };
  const result = await sessionStart(service, {sessionKey: 's', repository: 'acme/mono'});
  assert.deepEqual(asked, [{repository: 'acme/mono', select: false}],
    'asked, but told not to select');
  assert.equal(result.active_project, 'chosen-by-hand', 'the chosen scope survives');
  assert.match(result.context, /projects in this codebase/);
  assert.match(result.context, /1 other project not linked/, 'and the block still filters');
});

test('with no scope chosen yet, resolving the repository is allowed to select', async () => {
  const asked = [];
  const result = await sessionStart({
    ...scopeStubs,
    status: async () => connected,
    settings: async () => baseSettings,
    activeProject: async () => null,
    resolveRepository: async (_s, _p, repository, select) => {
      asked.push({repository, select});
      return [{project_id: 'p1', slug: 'a', name: 'A', brief: '', selected: true}];
    },
    projects: async () => [{id: 'p1', slug: 'a', brief: ''}, {id: 'p2', slug: 'b', brief: ''}],
    personal: async () => [],
  }, {sessionKey: 's', repository: 'acme/one'});
  assert.deepEqual(asked, [{repository: 'acme/one', select: true}]);
  assert.equal(result.active_project, 'p1');
  assert.match(result.context, /1 other project not linked/);
});

test('picked-up memories load, and the log and the notice say so', async () => {
  // The block, the injection log and the terminal line all have to agree on
  // what reached the model, or "why did it not know that" is unanswerable.
  const logged = [];
  const result = await sessionStart({
    ...scopeStubs,
    status: async () => connected,
    settings: async () => ({...baseSettings, block_size: 30}),
    projects: async () => [],
    personal: async () => [
      {id: 'aaaaaa11-0000-4000-8000-000000000001', statement: 'No em dashes.', band: 'said', kind: 'preference', mentions: 1},
      {id: 'cccccc33-0000-4000-8000-000000000003', statement: 'Comments only when needed.', band: 'heard', kind: 'preference', mentions: 3},
      {id: 'dddddd44-0000-4000-8000-000000000004', statement: 'Pros and cons.', band: 'heard', kind: 'preference', mentions: 1},
    ],
    logInjection: async entry => { logged.push(entry); },
  }, {sessionKey: 's', project: null});
  assert.match(result.context, /cccccc {2}Comments only when needed\./);
  assert.match(result.context, /dddddd {2}Pros and cons\./);
  assert.deepEqual(logged[0].memory_ids, ['aaaaaa11-0000-4000-8000-000000000001',
    'cccccc33-0000-4000-8000-000000000003', 'dddddd44-0000-4000-8000-000000000004']);
  assert.equal(result.notice, 'Satchel loaded · 0 projects, 3 personal memories');
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
    recordTurn: async () => {},
    sessionWindow: async () => [{id: 1, role: 'user', content: 'what did we decide', classified_at: null}],
    projects: async () => [],
    captureTurn: async () => { throw spent; },
  }, {sessionKey: 's', assistant: 'Here is what we decided.'});

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

// Every writer that produces a searchable row has to embed it. save() and
// correct() did; captureMemory did not, and capture is the only writer nobody
// checks afterwards, so nothing noticed. In production every automatically
// captured memory was saved and invisible to retrieval, 5 of 5, while every
// explicitly saved one was fine. That asymmetry read as a capture-quality
// problem for weeks and it was a missing line.
//
// Stubbing captureTurn, which is what the tests above do, cannot see this: the
// bug lives underneath that stub.
const writerRow = {id: 'm1', project_id: null, band: 'heard',
  statement: 'Customer cap lives in GrowthBook', source: 'customer cap can be stored in growthbook'};

test('an automatically captured memory is embedded, exactly like a saved one', async () => {
  const db = recorder({capture_memory: writerRow, save_memory: writerRow, agent_can_access: true});
  const service = memoryService(db, embedder, null);

  await service.captureMemory({id: 'm1', statement: writerRow.statement,
    source: writerRow.source, project: 'ledger'});
  const captured = db.calls.update.find(call => call.table === 'memories');
  assert.ok(captured, 'capture must write the vector, not only the row');
  assert.ok(String(captured.values.embedding).startsWith('['), 'and it must be a vector literal');
  assert.equal(captured.values.embedding_model, 'test-model',
    'the model is stamped, so two vector spaces stay distinguishable');

  db.calls.update.length = 0;
  await service.save({id: 'm2', project_id: null, statement: writerRow.statement, source: writerRow.source});
  assert.equal(db.calls.update.length, 1, 'save embeds too, and this is the parity that was broken');
});

test('a capture whose embedding fails is still written and still counted', async () => {
  // Retrieval degrades to silence, never to noise: the memory is saved and the
  // backfill picks the vector up later. Losing the write over an index entry
  // would be the worse trade.
  const db = recorder({capture_memory: writerRow});
  const failing = {...embedder, embedOne: async () => { throw new Error('quota spent'); }};
  const service = memoryService(db, failing, null);
  const row = await service.captureMemory({id: 'm1', statement: writerRow.statement,
    source: writerRow.source, project: 'ledger'});
  assert.equal(row.id, 'm1', 'the caller still gets the row, so the turn counts it as kept');
});

test('the user’s half is waited for, and its loss is reported without taking the prompt down', async () => {
  // It used to be `void service.recordSessionMessage(...)`. A serverless
  // function can freeze the moment it responds, so the write could be killed
  // mid flight. Against a 24 hour window that was a fair trade for the five
  // second budget. Against a document it is not: the user's half is the only
  // half that may supply a memory's source, so losing it voids the record
  // rather than thinning it.
  let settled = false;
  const service = {
    ...scopeStubs,
    status: async () => connected,
    settings: async () => baseSettings,
    recordTurn: async () => { await new Promise(r => setTimeout(r, 5)); settled = true; },
    search: async () => [],
    projects: async () => [],
  };
  await retrieve(service, {sessionKey: 's', prompt: 'never bump Go until payouts ship'});
  assert.equal(settled, true, 'retrieve must not return before the turn is on disk');

  service.recordTurn = async () => { throw {code: 'PT503', reason: 'the document store is unavailable'}; };
  service.search = async () => [{id: crypto.randomUUID(), statement: 'Do not bump Go until payouts ship.',
    band: 'said', task_id: null, score: 0.9, matched: 1, in_scope: 1}];
  const result = await retrieve(service, {sessionKey: 's', prompt: 'can we bump Go'});
  assert.match(result.context, /Do not bump Go until payouts ship\./,
    'a lost record must not cost the person the memory they already had');
  assert.match(result.notice, /did not record this turn/,
    'and they have to be told, because nothing later can reconstruct it');
});

test('the end of a turn tells the document which project it was', async () => {
  // A consolidation pass runs hours later from a cron with no workspace and no
  // git remote. If the end of the turn does not record the scope, nothing ever
  // can, and every document would consolidate into personal memory.
  const recorded = [];
  const service = {
    ...scopeStubs,
    status: async () => connected,
    settings: async () => ({...baseSettings, capture_window: 1}),
    recordTurn: async (_key, role, content, _keep, projectId) => { recorded.push({role, content, projectId}); },
    sessionWindow: async () => [{id: 1, role: 'user', content: 'keep the client on 4.1', classified_at: null}],
    resolveRepository: async (_session, _provider, repository) =>
      repository === 'acme/ledger' ? [{project_id: 'p1', slug: 'ledger', selected: true}] : [],
    projects: async () => [{id: 'p1', slug: 'ledger', brief: '', project_repositories: []}],
    captureTurn: async () => ({memories: [], dropped: 0, failed: false}),
  };
  await capture(service, {sessionKey: 's', repository: 'acme/ledger', assistant: 'Understood.'});
  assert.deepEqual(recorded, [{role: 'assistant', content: 'Understood.', projectId: 'p1'}]);

  // Codex hands over no last_assistant_message. There is no turn to append, so
  // the call exists only to say which project this was.
  recorded.length = 0;
  await capture(service, {sessionKey: 's', repository: 'acme/ledger', assistant: ''});
  assert.deepEqual(recorded, [{role: 'assistant', content: '', projectId: 'p1'}]);
});

test('with no router the conversation is still kept', async () => {
  // Capture used to return before recording anything when no router was
  // configured. Documents are raw material and the pass that reads them does
  // not have to be the one running in this process, so the record is worth
  // keeping whether or not anything classifies it today.
  const recorded = [];
  const result = await capture({
    ...scopeStubs,
    status: async () => connected,
    settings: async () => baseSettings,
    recordTurn: async (_key, role, content) => { recorded.push({role, content}); },
    projects: async () => [],
  }, {sessionKey: 's', assistant: 'Understood.'});
  assert.deepEqual(recorded, [{role: 'assistant', content: 'Understood.'}]);
  assert.equal(result.captured, 0);
  assert.equal(result.notice, '', 'nothing was classified, so there is nothing to announce');
});

test('a memory the router captured names the run that decided it', () => {
  // The one row in the system nobody asked for, and until now the one row
  // whose event could not say what produced it. Consolidation carried its
  // trace from the start; the Stop router did not, so a captured memory in
  // the activity page was a dead end.
  const captured = [];
  const db = recorder({capture_memory: {id: 'm1', statement: 'A claim.'}});
  const service = memoryService(db, null, {
    model: 'test-model',
    route: async () => ({memories: [{statement: 'A claim.', source: 'a claim', project: null}],
      dropped: [], prompt: 'p', raw: '{}'}),
  });
  void captured;
  return service.captureTurn('s', {context: [], turn: ['a claim'], saved: [], trace: 'trace-xyz'})
    .then(() => {
      const call = db.calls.rpc.find(c => c.name === 'capture_memory');
      assert.equal(call.args.p_trace, 'trace-xyz');
    });
});

test('the default is that nothing writes a memory without reading the conversation', async () => {
  // capture_mode used to default to `turn`, which is the five-row blind
  // insert this rebuild exists to replace. It was the default only because
  // nothing called the pass; there is a button now. The service fallback and
  // the column default have to agree, or behaviour depends on whether a
  // settings row happens to exist.
  const db = recorder({});
  const service = memoryService(db, null, null);
  assert.equal((await service.settings()).capture_mode, 'session');

  let routed = false;
  const result = await capture({
    ...scopeStubs,
    status: async () => connected,
    settings: async () => ({...baseSettings, capture_mode: 'session'}),
    recordTurn: async () => {},
    projects: async () => [],
    sessionWindow: async () => [{id: 1, role: 'user', content: 'something durable', classified_at: null}],
    captureTurn: async () => { routed = true; return {memories: [], dropped: 0, failed: false}; },
  }, {sessionKey: 's', assistant: 'Understood.'});
  assert.equal(routed, false, 'the turn router must not run when the pass is the writer');
  assert.equal(result.captured, 0);
});
