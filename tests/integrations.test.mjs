import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {SCOPES} from '../server/google.mjs';
import {cleanSettings, pageBody} from '../server/notion.mjs';
import {sealFor, openFor, sealTag} from '../server/integrations.mjs';
import {handleIntegrations} from '../server/integrations-handler.mjs';

process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??= 'test-publishable';
const key = randomBytes(32);
const config = {sealKey: key, google: {clientId: 'g', clientSecret: 'gs', sealKey: key}, notion: {clientId: 'n', clientSecret: 'ns'}};
const verify = async token => { if (token !== 'person') throw Error('bad'); return {sub: 'alice'}; };
const id = '50000000-0000-4000-8000-000000000001';
const googleId = '60000000-0000-4000-8000-000000000001';
const notionId = '60000000-0000-4000-8000-000000000002';
const sourceId = '70000000-0000-4000-8000-000000000001';
function fakeRes() {
  const res = {status: 0, headers: {}, body: ''};
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.writeHead = (status, headers = {}) => { res.status = status; Object.assign(res.headers, headers); };
  res.end = body => { res.body = body ?? ''; };
  return res;
}
const req = body => ({method: 'POST', headers: {authorization: 'Bearer person', host: 'satchel.test'}, body});
const json = (status, body) => ({ok: status < 400, status, json: async () => body});
const out = res => JSON.parse(res.body);

const EPD = {object: 'data_source', id: sourceId, title: [{plain_text: 'EPD Tasks'}], properties: {
  'Task name': {name: 'Task name', type: 'title', title: {}},
  'Due Date': {name: 'Due Date', type: 'date', date: {}},
  Status: {name: 'Status', type: 'status', status: {options: [{name: 'Todo'}, {name: 'Done'}]}},
  Assignee: {name: 'Assignee', type: 'people', people: {}},
  Tags: {name: 'Tags', type: 'multi_select', multi_select: {options: [{name: 'satchel'}, {name: 'tech-debt'}]}},
  Sprint: {name: 'Sprint', type: 'relation', relation: {}},
}};
const ticketSettings = {data_source_id: sourceId, name: 'EPD Tasks', title: 'Task name', date: 'Due Date', defaults: {
  Status: {type: 'status', value: 'Todo'}, Assignee: {type: 'people', value: 'me'}, Tags: {type: 'multi_select', value: ['satchel']}}};

/** The person's rows, as the database routines would answer them. */
function fakeDb({suggestion = null, connections = {}, slots = {}} = {}) {
  const calls = [];
  const conn = cid => connections[cid];
  return {calls, ownerId: 'alice', connections, rpc: async (name, args) => {
    calls.push([name, args]);
    if (name === 'read_shelf_suggestion' || name === 'claim_shelf_suggestion') return {data: suggestion ? [suggestion] : [], error: null};
    if (name === 'shelf_sort_context') return {data: {timezone: 'Asia/Kolkata'}, error: null};
    if (name === 'decide_shelf_suggestion') return {data: [{id: args.p_id}], error: null};
    if (name === 'destination_for') {
      const slot = slots[`${args.p_profile}/${args.p_slot}`];
      if (!slot) return {data: null, error: {hint: 'satchel:gone:destination'}};
      const c = conn(slot.connection_id);
      return {data: [{...slot, provider: c.provider, token_cipher: c.token_cipher, seal_tag: c.seal_tag, meta: c.meta ?? {}}], error: null};
    }
    if (name === 'list_destinations') return {data: Object.entries(slots).map(([k, s]) => ({profile: k.split('/')[0], slot: k.split('/')[1], ...s})), error: null};
    if (name === 'connection_token') return conn(args.p_id) ? {data: [conn(args.p_id)], error: null} : {data: null, error: {hint: 'satchel:gone:connection'}};
    if (name === 'update_connection_token') { conn(args.p_id).token_cipher = args.p_token_cipher; return {data: null, error: null}; }
    if (name === 'remove_connection') return {data: conn(args.p_id) ? [conn(args.p_id)] : [], error: null};
    if (name === 'save_connection') return {data: notionId, error: null};
    return {data: null, error: null};
  }};
}
const run = async (body, db, fetchImpl, extra = {}) => {
  const res = fakeRes();
  await handleIntegrations(req(body), res, {config, makeClient: () => db, verify, fetchImpl, ...extra});
  return res;
};
const notionConn = (pair = {access: 'n-access', refresh: 'n-refresh'}) => ({provider: 'notion', seal_tag: 'notion:ws-1', meta: {user_id: 'u-me'},
  token_cipher: sealFor(config, 'alice', 'notion:ws-1', JSON.stringify(pair))});
// Moved from the old Google links: still sealed to the profile.
const googleConn = () => ({provider: 'google', seal_tag: 'personal', token_cipher: sealFor(config, 'alice', 'personal', 'g-refresh')});

test('a Work to-do becomes a ticket in the Notion database, filled the way the person set it', async () => {
  const suggestion = {id, profile: 'work', kind: 'todo', title: 'Fix the login bug', due_date: '2026-11-12', starts_at: null,
    ends_at: null, source: 'fix login by thursday', status: 'pending'};
  const db = fakeDb({suggestion, connections: {[notionId]: notionConn()},
    slots: {'work/todo': {plugin: 'notion_database', connection_id: notionId, settings: ticketSettings}}});
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push([String(url), init]);
    return json(200, {id: 'page', url: 'https://www.notion.so/Fix-the-login-bug-1'});
  };
  const res = await run({action: 'add', id}, db, fetchImpl);
  assert.equal(res.status, 200);
  assert.equal(out(res).plugin, 'notion_database');
  const [url, init] = sent[0];
  assert.equal(url, 'https://api.notion.com/v1/pages');
  assert.equal(init.headers.authorization, 'Bearer n-access');
  const page = JSON.parse(init.body);
  assert.deepEqual(page.parent, {type: 'data_source_id', data_source_id: sourceId});
  assert.equal(page.properties['Task name'].title[0].text.content, 'Fix the login bug');
  assert.deepEqual(page.properties['Due Date'].date, {start: '2026-11-12', end: null});
  assert.deepEqual(page.properties.Status, {status: {name: 'Todo'}});
  assert.deepEqual(page.properties.Assignee, {people: [{object: 'user', id: 'u-me'}]});
  assert.deepEqual(page.properties.Tags, {multi_select: [{name: 'satchel'}]});
  assert.doesNotMatch(page.markdown, /Fix the login bug/, 'the title is not repeated in the body');
  assert.match(page.markdown, /fix login by thursday/);
  const order = name => db.calls.findIndex(c => c[0] === name);
  assert.ok(order('claim_shelf_suggestion') < order('decide_shelf_suggestion'), 'claimed before it is decided');
  assert.equal(db.calls.find(c => c[0] === 'decide_shelf_suggestion')[1].p_google_link, 'https://www.notion.so/Fix-the-login-bug-1');
});

test('a Personal event goes to Google Calendar on a token moved from the old link', async () => {
  const suggestion = {id, profile: 'personal', kind: 'event', title: 'Dinner', due_date: null, starts_at: '2026-11-12T14:30:00Z',
    ends_at: null, source: 'dinner at 8', status: 'pending'};
  const db = fakeDb({suggestion, connections: {[googleId]: googleConn()},
    slots: {'personal/event': {plugin: 'google_calendar', connection_id: googleId, settings: {}}}});
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(String(url));
    if (String(url).includes('oauth2')) { assert.match(String(init.body), /g-refresh/); return json(200, {access_token: 'a'}); }
    return json(200, {htmlLink: 'https://calendar.google.com/event?eid=1'});
  };
  const res = await run({action: 'add', id}, db, fetchImpl);
  assert.equal(res.status, 200);
  assert.ok(seen.some(u => u.includes('calendar/v3')));
  assert.equal(out(res).kind, 'event');
});

test('an empty slot says where to set it, and nothing is claimed or called', async () => {
  const db = fakeDb({suggestion: {id, profile: 'work', kind: 'event', title: 'x', source: 'x', status: 'pending'}});
  let called = false;
  const res = await run({action: 'add', id}, db, async () => { called = true; });
  assert.equal(res.status, 409);
  assert.match(out(res).error, /Work Calendar/);
  assert.equal(called, false);
  assert.equal(db.calls.some(c => c[0] === 'claim_shelf_suggestion'), false);
});

test('an expired Notion token is refreshed once, the new pair saved sealed, and the add goes through', async () => {
  const suggestion = {id, profile: 'work', kind: 'todo', title: 'T', due_date: null, starts_at: null, ends_at: null, source: 's', status: 'pending'};
  const db = fakeDb({suggestion, connections: {[notionId]: notionConn()},
    slots: {'work/todo': {plugin: 'notion_database', connection_id: notionId, settings: ticketSettings}}});
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/oauth/token')) {
      assert.equal(init.headers.authorization, `Basic ${Buffer.from('n:ns').toString('base64')}`);
      assert.deepEqual(JSON.parse(init.body), {grant_type: 'refresh_token', refresh_token: 'n-refresh'});
      return json(200, {access_token: 'n-access-2', refresh_token: 'n-refresh-2'});
    }
    return init.headers.authorization === 'Bearer n-access' ? json(401, {code: 'unauthorized'}) : json(200, {url: 'https://www.notion.so/T'});
  };
  const res = await run({action: 'add', id}, db, fetchImpl);
  assert.equal(res.status, 200);
  const saved = db.connections[notionId].token_cipher;
  assert.doesNotMatch(saved, /n-refresh-2/);
  assert.deepEqual(JSON.parse(openFor(config, 'alice', 'notion:ws-1', saved)), {access: 'n-access-2', refresh: 'n-refresh-2'});
});

test('a token stored by someone else will not open: nothing is called and the claim is released', async () => {
  const suggestion = {id, profile: 'work', kind: 'todo', title: 'x', source: 'x', status: 'pending'};
  const stolen = {...notionConn(), token_cipher: sealFor(config, 'victim', 'notion:ws-1', '{"access":"v"}')};
  const db = fakeDb({suggestion, connections: {[notionId]: stolen},
    slots: {'work/todo': {plugin: 'notion_database', connection_id: notionId, settings: ticketSettings}}});
  let called = false;
  const res = await run({action: 'add', id}, db, async () => { called = true; });
  assert.equal(res.status, 409);
  assert.equal(called, false);
  assert.ok(db.calls.some(c => c[0] === 'release_shelf_suggestion'));
});

test('connecting seals the token to the account before it is saved', async () => {
  const notion = fakeDb();
  const res = await run({action: 'link', provider: 'notion', code: 'abc'}, notion, async (url, init) => {
    const sent = JSON.parse(init.body);
    assert.deepEqual([sent.grant_type, sent.code], ['authorization_code', 'abc']);
    assert.match(sent.redirect_uri, /\/settings\/notion$/);
    return json(200, {access_token: 'secret-a', refresh_token: 'secret-r', workspace_id: 'ws-1', workspace_name: 'Different',
      owner: {type: 'user', user: {id: 'u-me', name: 'Neeraj'}}});
  });
  assert.equal(res.status, 200);
  const saved = notion.calls.find(c => c[0] === 'save_connection')[1];
  assert.deepEqual([saved.p_provider, saved.p_account, saved.p_label, saved.p_seal_tag, saved.p_meta.user_id],
    ['notion', 'ws-1', 'Different', 'notion:ws-1', 'u-me']);
  assert.doesNotMatch(saved.p_token_cipher, /secret/);

  const google = fakeDb();
  const idToken = `x.${Buffer.from(JSON.stringify({email: 'me@gmail.com'})).toString('base64url')}.y`;
  const ok = await run({action: 'link', provider: 'google', code: 'abc', verifier: 'v'.repeat(64)}, google,
    async () => json(200, {refresh_token: 'refresh-xyz', id_token: idToken, scope: SCOPES.join(' ')}));
  assert.equal(ok.status, 200);
  const g = google.calls.find(c => c[0] === 'save_connection')[1];
  assert.equal(g.p_seal_tag, sealTag('google', 'me@gmail.com'));
  assert.equal(openFor(config, 'alice', g.p_seal_tag, g.p_token_cipher), 'refresh-xyz');
});

test('starting needs the provider set up; the Notion screen is Notion’s own', async () => {
  const db = fakeDb();
  const start = await run({action: 'start', provider: 'notion'}, db);
  assert.equal(start.status, 200);
  const url = new URL(out(start).url);
  assert.equal(url.origin + url.pathname, 'https://api.notion.com/v1/oauth/authorize');
  assert.equal(url.searchParams.get('owner'), 'user');
  assert.equal(url.searchParams.get('state'), out(start).state);
  assert.equal((await run({action: 'start', provider: 'notion'}, db, fetch, {config: {...config, notion: null}})).status, 503);
  assert.equal((await run({action: 'start', provider: 'google'}, db, fetch, {config: null})).status, 503);
  assert.equal((await run({action: 'start', provider: 'slack'}, db)).status, 400);
});

test('setting a Notion slot keeps only what fits the live database', async () => {
  const db = fakeDb({connections: {[notionId]: notionConn(), [googleId]: googleConn()}});
  const fetchImpl = async url => { assert.match(String(url), /data_sources/); return json(200, EPD); };
  const res = await run({action: 'set', profile: 'work', slot: 'todo', plugin: 'notion_database', connection: notionId, settings: {
    data_source_id: sourceId, date: 'Due Date', defaults: {
      Status: {value: 'Todo'}, Assignee: {value: 'me'}, Tags: {value: ['satchel', 'made-up']},
      Priority: {value: 'P0'}, Sprint: {value: 'x'}, 'Task name': {value: 'sneaky'}}}}, db, fetchImpl);
  assert.equal(res.status, 200);
  const saved = db.calls.find(c => c[0] === 'set_destination')[1];
  assert.deepEqual(saved.p_settings, ticketSettings);
  const tasksForEvents = await run({action: 'set', profile: 'work', slot: 'event', plugin: 'google_tasks', connection: googleId}, db);
  assert.equal(tasksForEvents.status, 400);
  const wrongAccount = await run({action: 'set', profile: 'work', slot: 'event', plugin: 'google_calendar', connection: notionId}, db);
  assert.equal(wrongAccount.status, 404);
  const cleared = await run({action: 'set', profile: 'work', slot: 'event', plugin: null}, db);
  assert.equal(cleared.status, 200);
});

test('the database list and its columns come from the workspace', async () => {
  const db = fakeDb({connections: {[notionId]: notionConn()}});
  const sources = await run({action: 'sources', id: notionId}, db, async (url, init) => {
    assert.deepEqual(JSON.parse(init.body).filter, {property: 'object', value: 'data_source'});
    return json(200, {results: [EPD, {object: 'data_source', id: 'gone', in_trash: true, title: []}]});
  });
  assert.deepEqual(out(sources).sources, [{id: sourceId, name: 'EPD Tasks'}]);
  const schema = await run({action: 'schema', id: notionId, source: sourceId}, db, async () => json(200, EPD));
  assert.deepEqual(out(schema).columns.map(c => c.name), ['Task name', 'Due Date', 'Status', 'Assignee', 'Tags'], 'relations are left out');
  const unshared = await run({action: 'schema', id: notionId, source: sourceId}, db, async () => json(404, {code: 'object_not_found'}));
  assert.equal(unshared.status, 404);
  const google = await run({action: 'sources', id: googleId}, fakeDb({connections: {[googleId]: googleConn()}}));
  assert.equal(google.status, 404);
});

test('disconnecting Google withdraws it there; Notion has nothing to withdraw', async () => {
  let revoked = false;
  const g = await run({action: 'unlink', id: googleId}, fakeDb({connections: {[googleId]: googleConn()}}),
    async url => { revoked = String(url).includes('revoke'); return json(200, {}); });
  assert.deepEqual([g.status, revoked, out(g).revoked], [200, true, true]);
  const n = await run({action: 'unlink', id: notionId}, fakeDb({connections: {[notionId]: notionConn()}}), async () => { throw Error('no call'); });
  assert.deepEqual([n.status, out(n).revoked], [200, false]);
});

test('coming up reads every calendar and list slot, soonest first, and names a profile that would not answer', async () => {
  const brokenId = '60000000-0000-4000-8000-000000000003';
  const db = fakeDb({connections: {[googleId]: googleConn(), [notionId]: notionConn(),
    [brokenId]: {provider: 'google', seal_tag: 'work', token_cipher: sealFor(config, 'victim', 'work', 'x')}},
  slots: {
    'personal/event': {plugin: 'google_calendar', connection_id: googleId},
    'personal/todo': {plugin: 'google_tasks', connection_id: googleId},
    'work/todo': {plugin: 'notion_database', connection_id: notionId},
    'work/event': {plugin: 'google_calendar', connection_id: brokenId}}});
  const soon = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const fetchImpl = async url => {
    const u = String(url);
    if (u.includes('oauth2')) return json(200, {access_token: 'a'});
    if (u.includes('calendar')) return json(200, {items: [
      {summary: 'Standup', start: {dateTime: '2026-11-05T04:30:00Z'}}, {summary: 'Release day', start: {date: '2026-11-04'}}]});
    return json(200, {items: [{title: 'Renew insurance', due: `${soon}T00:00:00.000Z`}, {title: 'Long ago', due: '2020-07-11T00:00:00.000Z'}]});
  };
  const res = await run({action: 'upcoming'}, db, fetchImpl);
  assert.equal(res.status, 200);
  assert.deepEqual(out(res).failed, ['work']);
  assert.deepEqual(out(res).items.map(i => [i.profile, i.kind, i.title]),
    [['personal', 'event', 'Release day'], ['personal', 'event', 'Standup'], ['personal', 'task', 'Renew insurance']]);
});

test('with no date column the day goes in the page body; columns that left the database are dropped', () => {
  const page = pageBody({title: 'Call', starts_at: '2026-11-12T04:30:00Z', source: 'call\nmom'},
    {...ticketSettings, date: null}, {userId: null, timezone: 'Asia/Kolkata'});
  assert.match(page.markdown, /^When: 12 Nov 2026, 10:00/);
  assert.equal(page.properties.Assignee, undefined, 'no Notion user to assign');
  assert.match(page.markdown, /“call mom”$/, 'the source stays on one line');
  const schema = {id: sourceId, name: 'Bare', columns: [{name: 'Name', type: 'title'}]};
  assert.deepEqual(cleanSettings(schema, ticketSettings), {data_source_id: sourceId, name: 'Bare', title: 'Name', date: null, defaults: {}});
  assert.throws(() => cleanSettings({id: sourceId, name: 'x', columns: []}, {}), e => e.reason === 'no_title');
});
