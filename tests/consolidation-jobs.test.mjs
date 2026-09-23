// A consolidation you start and come back to.
//
// Three layers, because each one can be right while the others are wrong.
// The table decides who may see and move a job, and that there is one running
// at a time. The step decides what one call reads and when the job stops. The
// endpoint decides who holds the job, and hands it on.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {applyMigrations} from './helpers/migrations.mjs';
import {consolidateStep} from '../server/consolidation.mjs';
import {handleConsolidateWith, publicOrigin} from '../server/hook-handler.mjs';

async function database() {
  const db = new PGlite();
  const owner = crypto.randomUUID(), other = crypto.randomUUID();
  await db.exec(`
    create role anon; create role authenticated; create role supabase_auth_admin;
    create schema auth; create schema storage;
    create table storage.objects(bucket_id text,name text,metadata jsonb,user_metadata jsonb);
    create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as
      $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql stable as
      $$select (auth.jwt()->>'sub')::uuid$$;
    grant usage on schema auth,public to authenticated,anon;
    insert into auth.users values('${owner}'),('${other}');
  `);
  await applyMigrations(db);
  async function call(sub, sql, params = [], extra = {}) {
    await db.exec('begin; set local role authenticated;');
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({sub, ...extra})]);
      const result = await db.query(sql, params);
      await db.exec('commit');
      return result.rows;
    } catch (error) { await db.exec('rollback'); throw error; }
  }
  return {db, owner, other, call};
}

test('a job is its owner’s, one at a time, with a wall nobody can move', async t => {
  const {db, owner, other, call} = await database();
  try {
    const [job] = await call(owner, 'insert into consolidation_jobs(idle_minutes, waiting) values (30, 15) returning *');

    await t.test('it starts running, with 30 minutes on it', async () => {
      assert.equal(job.status, 'running');
      assert.equal(Math.round((job.deadline_at - job.started_at) / 60000), 30);
    });

    await t.test('a second one cannot start while the first runs', async () => {
      // Two jobs over the same waiting sessions would read each twice and
      // affirm every memory in them twice.
      await assert.rejects(call(owner, 'insert into consolidation_jobs(idle_minutes) values (30)'), {code: '23505'});
      // Somebody else's job is not in the way.
      await call(other, 'insert into consolidation_jobs(idle_minutes) values (30)');
    });

    await t.test('nobody else can read it or move it', async () => {
      assert.deepEqual(await call(other, 'select id from consolidation_jobs where id = $1', [job.id]), []);
      await call(other, "update consolidation_jobs set status = 'stopped' where id = $1", [job.id]);
      assert.equal((await call(owner, 'select status from consolidation_jobs where id = $1', [job.id]))[0].status, 'running');
    });

    await t.test('the deadline and the owner are not the caller’s to set', async () => {
      await assert.rejects(call(owner, "update consolidation_jobs set deadline_at = now() + interval '1 day' where id = $1", [job.id]));
      await assert.rejects(call(owner, 'update consolidation_jobs set owner_id = $2 where id = $1', [job.id, other]));
      await assert.rejects(call(owner, "insert into consolidation_jobs(owner_id) values ($1)", [other]));
    });

    await t.test('once it finishes, the next one can start', async () => {
      await call(owner, "update consolidation_jobs set status = 'finished', finished_at = now() where id = $1", [job.id]);
      await call(owner, 'insert into consolidation_jobs(idle_minutes) values (30)');
    });

    await t.test('an app the owner connected cannot read the report', async () => {
      // The report names memories from every scope. A connection granted one
      // project must not learn what the pass decided about the others.
      const app = {client_id: 'claude-ai', satchel_grant_id: crypto.randomUUID()};
      assert.deepEqual(await call(owner, 'select id from consolidation_jobs', [], app), []);
      await assert.rejects(call(owner, "insert into consolidation_jobs(idle_minutes) values (5)", [], app));
      await call(owner, "update consolidation_jobs set read = 99", [], app);
      assert.ok((await call(owner, 'select read from consolidation_jobs')).every(j => j.read !== 99));
    });

    await t.test('the schedule’s own client can, because it is the job', async () => {
      await db.query(`insert into public.consolidation_credentials(owner_id, client_id, secret_id, endpoint)
        values ($1, 'satchel-cron', $2, 'https://satchel.test/api/consolidate')`, [owner, crypto.randomUUID()]);
      const cron = {client_id: 'satchel-cron', satchel_grant_id: crypto.randomUUID()};
      assert.ok((await call(owner, 'select id from consolidation_jobs', [], cron)).length >= 1);
      // And only its owner's: the same client id means nothing for anyone else.
      assert.deepEqual(await call(other, 'select id from consolidation_jobs', [], cron), []);
    });

    await t.test('a caller with no identity gets nothing', async () => {
      await db.exec('begin; set local role anon;');
      try { await assert.rejects(db.query('select * from public.consolidation_jobs')); }
      finally { await db.exec('rollback'); }
    });
  } finally { await db.close(); }
});

// A service that behaves like the real one closely enough to hold a job: the
// step guard is the part that matters, so it is implemented, not stubbed.
function fakeService({documents = [], failWith = {}} = {}) {
  const marked = new Set();
  const jobs = new Map();
  const service = {
    pendingDocuments: async () => documents.filter(d => !marked.has(d.id)),
    projects: async () => [],
    settings: async () => ({block_size: 30, staleness_commits: 25}),
    documentTurns: async id => [{id: 1, role: 'user', content: `said in ${id}`}],
    memoriesInScope: async () => [],
    markDocumentConsolidated: async id => { marked.add(id); },
    logConsolidationRun: async () => {},
    captureMemory: async args => ({id: crypto.randomUUID(), ...args}),
    async startConsolidationJob({idleMinutes, waiting}) {
      const running = [...jobs.values()].find(j => j.status === 'running');
      if (running) return {job: running, started: false};
      const now = Date.now();
      const job = {id: crypto.randomUUID(), status: 'running', idle_minutes: idleMinutes, waiting, step: 0,
        read: 0, added: 0, extended: 0, replaced: 0, retired: 0, affirmed: 0, dropped: 0, failed: 0, runs: [],
        started_at: new Date(now).toISOString(), heartbeat_at: new Date(now).toISOString(),
        deadline_at: new Date(now + 30 * 60000).toISOString()};
      jobs.set(job.id, job);
      return {job: {...job}, started: true};
    },
    consolidationJob: async id => jobs.has(id) ? {...jobs.get(id)} : null,
    async moveConsolidationJob(id, step, patch) {
      const job = jobs.get(id);
      if (!job || job.step !== step || job.status !== 'running') return null;
      Object.assign(job, patch, {heartbeat_at: new Date().toISOString()});
      return {...job};
    },
    rotateConsolidationCredential: async () => {},
  };
  const consolidator = {
    model: 'test-model', retryAfterMs: 120000, timeoutMs: 40000,
    consolidate: async ({turns}) => {
      const which = turns[0].content.split(' ').pop();
      // A function fails only when it returns an error, so a case can fail once.
      const failure = typeof failWith[which] === 'function' ? failWith[which]() : failWith[which];
      if (failure) throw failure;
      return {changes: [{action: 'add', statement: `A claim from ${which}.`, source: `said in ${which}`,
        kind: 'fact', project: null, why: 'new'}], dropped: [], prompt: 'p', raw: '{}'};
    },
  };
  return {service, consolidator, jobs, marked};
}
const docs = n => Array.from({length: n}, (_, i) => ({id: `d${i + 1}`, session_key: `s${i + 1}`,
  project_id: null, turns: 1, consolidated_through: null}));

test('one step reads until its time is up and says there is more', async () => {
  const {service, consolidator, jobs} = fakeService({documents: docs(5)});
  const {job} = await service.startConsolidationJob({idleMinutes: 30, waiting: 5});
  const held = await service.moveConsolidationJob(job.id, 0, {step: 1});
  // A clock that moves a minute per session, and a two and a half minute step.
  let clock = Date.now();
  const now = () => (clock += 60000);
  const out = await consolidateStep(service, consolidator, held, {budgetMs: 150000, now});
  assert.equal(out.more, true);
  assert.equal(out.job.read, 2);
  assert.equal(out.job.added, 2);
  assert.deepEqual(out.job.runs.map(r => r.document), ['d1', 'd2']);
  // The report carries what each session did and why, which is what the page shows.
  assert.equal(out.job.runs[0].actions[0].statement, 'A claim from d1.');
  assert.equal(jobs.get(job.id).status, 'running');
});

test('the last step finishes the job and says so', async () => {
  const {service, consolidator} = fakeService({documents: docs(3)});
  const {job} = await service.startConsolidationJob({idleMinutes: 30, waiting: 3});
  const held = await service.moveConsolidationJob(job.id, 0, {step: 1});
  const out = await consolidateStep(service, consolidator, held);
  assert.equal(out.more, false);
  assert.equal(out.job.status, 'finished');
  assert.equal(out.job.read, 3);
  assert.match(out.job.stop_reason, /Every waiting session was read/);
});

test('nothing waiting is a finished job, not an error', async () => {
  const {service, consolidator} = fakeService();
  const {job} = await service.startConsolidationJob({idleMinutes: 30, waiting: 0});
  const out = await consolidateStep(service, consolidator, await service.moveConsolidationJob(job.id, 0, {step: 1}));
  assert.equal(out.job.status, 'finished');
  assert.equal(out.job.stop_reason, 'Nothing was waiting.');
});

test('a spent quota stops the job instead of failing every session after it', async () => {
  const spent = Object.assign(new Error('quota'), {code: 'ROUTER_LIMIT', spent: true,
    reason: "consolidation is rate limited, the day's free quota is used up"});
  const {service, consolidator, marked} = fakeService({documents: docs(6), failWith: {d2: spent}});
  const {job} = await service.startConsolidationJob({idleMinutes: 30, waiting: 6});
  const out = await consolidateStep(service, consolidator, await service.moveConsolidationJob(job.id, 0, {step: 1}));
  assert.equal(out.job.status, 'stopped');
  assert.match(out.job.stop_reason, /quota is used up for today\. 4 sessions were left waiting/);
  assert.equal(out.job.read, 2);
  assert.equal(out.job.failed, 1);
  // The one that failed is still waiting for tomorrow.
  assert.deepEqual([...marked], ['d1']);
});

test('a model with no room to wait is handed to the next step, not counted as a failure', async () => {
  // The next step starts with a full clock, so it has room for the two minute
  // wait. The session is the first one it reaches because nothing about it
  // was written to the row.
  let calls = 0;
  const later = () => (calls++ === 0
    ? Object.assign(new Error('busy'), {code: 'ROUTER_HOST', status: 503, later: true}) : null);
  const {service, consolidator, marked} = fakeService({documents: docs(3), failWith: {d2: later}});
  const {job} = await service.startConsolidationJob({idleMinutes: 30, waiting: 3});
  const first = await consolidateStep(service, consolidator, await service.moveConsolidationJob(job.id, 0, {step: 1}));
  assert.equal(first.more, true);
  assert.deepEqual(first.job.runs.map(r => r.document), ['d1']);
  assert.equal(first.job.failed, 0);
  const second = await consolidateStep(service, consolidator,
    await service.moveConsolidationJob(job.id, first.job.step, {step: first.job.step + 1}));
  assert.deepEqual(second.job.runs.map(r => r.document), ['d1', 'd2', 'd3']);
  assert.equal(second.job.failed, 0);
  assert.equal(second.job.status, 'finished');
  assert.deepEqual([...marked].sort(), ['d1', 'd2', 'd3']);
});

test('near the 30 minutes, a model with no room to wait is an ordinary failure left for the next pass', async () => {
  const busy = Object.assign(new Error('busy'), {code: 'ROUTER_HOST', status: 503, later: true,
    reason: 'the model could not answer'});
  const {service, consolidator, marked} = fakeService({documents: docs(2), failWith: {d1: busy}});
  const {job} = await service.startConsolidationJob({idleMinutes: 30, waiting: 2});
  const held = await service.moveConsolidationJob(job.id, 0, {step: 1});
  const out = await consolidateStep(service, consolidator,
    {...held, deadline_at: new Date(Date.now() + 90000).toISOString()});
  assert.equal(out.job.failed, 1);
  assert.deepEqual(out.job.runs.map(r => r.document), ['d1', 'd2']);
  assert.deepEqual([...marked], ['d2'], 'the one that failed is still waiting');
});

test('a session that failed once is not asked about again in the same job', async () => {
  const broken = Object.assign(new Error('bad'), {reason: 'the model answered 500'});
  const {service, consolidator} = fakeService({documents: docs(3), failWith: {d1: broken}});
  const {job} = await service.startConsolidationJob({idleMinutes: 30, waiting: 3});
  let clock = Date.now();
  const first = await consolidateStep(service, consolidator,
    await service.moveConsolidationJob(job.id, 0, {step: 1}), {budgetMs: 90000, now: () => (clock += 60000)});
  assert.equal(first.more, true);
  const second = await consolidateStep(service, consolidator,
    await service.moveConsolidationJob(job.id, 1, {step: 2}));
  assert.deepEqual(second.job.runs.map(r => r.document), ['d1', 'd2', 'd3']);
  assert.equal(second.job.status, 'finished');
});

test('the 30 minutes are the job’s, however many calls it took', async () => {
  const {service, consolidator, jobs} = fakeService({documents: docs(4)});
  const {job} = await service.startConsolidationJob({idleMinutes: 30, waiting: 4});
  // A minute per tick of the clock, and a wall two and a half minutes out:
  // one session fits, then the wall is reached.
  jobs.get(job.id).deadline_at = new Date(Date.now() + 150000).toISOString();
  let clock = Date.now();
  const out = await consolidateStep(service, consolidator,
    await service.moveConsolidationJob(job.id, 0, {step: 1}), {now: () => (clock += 60000)});
  assert.equal(out.job.status, 'stopped');
  assert.match(out.job.stop_reason, /30 minutes ran out with 3 sessions still waiting/);
});

test('a step that lost the job stops writing to it', async () => {
  const {service, consolidator} = fakeService({documents: docs(3)});
  const {job} = await service.startConsolidationJob({idleMinutes: 30, waiting: 3});
  const mine = await service.moveConsolidationJob(job.id, 0, {step: 1});
  // Somebody pressed carry on and took it over.
  await service.moveConsolidationJob(job.id, 1, {step: 2});
  const out = await consolidateStep(service, consolidator, mine);
  assert.equal(out.lost, true);
  assert.equal((await service.consolidationJob(job.id)).read, 0, 'the other call’s job is left alone');
});

// The endpoint, driven with a fake connection. connect() is the tested path
// for tokens; this is about what happens after a caller is known.
function request(body) {
  return {method: 'POST', headers: {authorization: 'Bearer caller-token', host: 'evil.example'}, body};
}
function response() {
  const res = {status: null, body: '', headers: {}, setHeader(k, v) { this.headers[k] = v; },
    writeHead(status) { this.status = status; }, end(text = '') { this.body = text; }};
  return res;
}

test('publicOrigin never trusts the Host a caller sent', () => {
  const req = {headers: {host: 'evil.example'}};
  assert.equal(publicOrigin(req, {VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'satchel-pi.vercel.app',
    VERCEL_URL: 'satchel-abc.vercel.app'}), 'https://satchel-pi.vercel.app');
  assert.equal(publicOrigin(req, {VERCEL_ENV: 'preview', VERCEL_URL: 'satchel-abc.vercel.app'}), 'https://satchel-abc.vercel.app');
  assert.equal(publicOrigin(req, {SATCHEL_PUBLIC_URL: 'https://satchel.example/'}), 'https://satchel.example');
  // Only off Vercel entirely, which is the local server on 127.0.0.1.
  assert.equal(publicOrigin({headers: {host: '127.0.0.1:3000'}}, {}), 'http://127.0.0.1:3000');
});

test('the endpoint answers at once and hands the job on to its next call', async t => {
  // Stubbed at the module boundary: connect() needs a real JWT, and the
  // handler under test is everything after it.
  const {service, consolidator, jobs} = fakeService({documents: docs(3)});
  const work = [];
  const sent = [];
  const env = {...process.env};
  process.env.SATCHEL_PUBLIC_URL = 'https://satchel.test';
  t.after(() => { process.env = env; });
  const connection = {service, token: 'caller-token', ownerId: 'o1', rotated: null};
  const fetchImpl = async (url, init) => { sent.push({url, init}); return {status: 202}; };

  const res = response();
  await handleConsolidateWith(connection, request({idle_minutes: 30}), res,
    // A step with no time at all, so it hands on before reading anything.
    {consolidator, background: p => work.push(p), fetchImpl, stepMs: -1});
  assert.equal(res.status, 202, 'the answer does not wait for the reading');
  const {job} = JSON.parse(res.body);
  assert.equal(job.step, 1);
  await Promise.all(work);

  await t.test('the next call is sent to the configured origin, not the Host header', () => {
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'https://satchel.test/api/consolidate');
    assert.equal(sent[0].init.headers.authorization, 'Bearer caller-token');
    assert.deepEqual(JSON.parse(sent[0].init.body), {job: job.id, step: 1});
  });

  await t.test('a second press while it runs shows the running job and starts nothing', async () => {
    const again = response();
    await handleConsolidateWith(connection, request({}), again, {consolidator, background: p => work.push(p), fetchImpl});
    assert.equal(again.status, 202);
    assert.equal(JSON.parse(again.body).running, true);
    assert.equal(jobs.size, 1);
  });

  await t.test('a hand on for a step it does not hold is refused', async () => {
    const late = response();
    await handleConsolidateWith(connection, request({job: job.id, step: 0}), late,
      {consolidator, background: p => work.push(p), fetchImpl});
    assert.equal(late.status, 409);
  });

  await t.test('the chain carries it to the end', async () => {
    const next = response();
    await handleConsolidateWith(connection, request(JSON.parse(sent[0].init.body)), next,
      {consolidator, background: p => work.push(p), fetchImpl});
    assert.equal(next.status, 202);
    await Promise.all(work);
    const done = await service.consolidationJob(job.id);
    assert.equal(done.status, 'finished');
    assert.equal(done.read, 3);
  });

  await t.test('a job that went quiet can be carried on by anyone who owns it', async () => {
    const {service: s2, consolidator: c2, jobs: j2} = fakeService({documents: docs(2)});
    const {job: quiet} = await s2.startConsolidationJob({idleMinutes: 30, waiting: 2});
    Object.assign(j2.get(quiet.id), {step: 3, heartbeat_at: new Date(Date.now() - 10 * 60000).toISOString()});
    const carry = response();
    const more = [];
    await handleConsolidateWith({...connection, service: s2}, request({job: quiet.id}), carry,
      {consolidator: c2, background: p => more.push(p), fetchImpl});
    assert.equal(carry.status, 202);
    await Promise.all(more);
    assert.equal((await s2.consolidationJob(quiet.id)).status, 'finished');
  });

});
