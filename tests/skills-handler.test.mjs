import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSkillsHandler, verifyCompanionToken, githubLogin } from '../server/skills-handler.mjs';
import { GitHubError } from '../server/github-app.mjs';
import { checksum } from '../server/release-builder.mjs';
import { generateKeyPairSync } from 'node:crypto';
import { SignJWT, importSPKI, createLocalJWKSet, exportJWK } from 'jose';
import { SUPABASE_URL } from '../server/http-handler.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const repository = 'neerajg03/my-skills';
const commitSha = 'a'.repeat(40);
const newCommit = 'c'.repeat(40);
const env = {
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  SATCHEL_GITHUB_APP_ID: '1234',
  SATCHEL_GITHUB_APP_PRIVATE_KEY: 'unused-because-the-app-is-faked',
};

async function jwks() {
  const jwk = await exportJWK(publicKey);
  return createLocalJWKSet({ keys: [{ ...jwk, alg: 'ES256', use: 'sig' }] });
}
const mint = claims => new SignJWT({ sub: 'user-1', user_metadata: { user_name: 'NeerajG03' }, ...claims })
  .setProtectedHeader({ alg: 'ES256' }).setIssuer(SUPABASE_URL + '/auth/v1')
  .setExpirationTime('10m').setIssuedAt().sign(privateKey);

function reply() {
  const res = { status: 0, headers: {}, chunks: [] };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.writeHead = (status, headers) => { res.status = status; Object.assign(res.headers, headers ?? {}); return res; };
  res.end = chunk => { if (chunk) res.chunks.push(String(chunk)); res.done = true; };
  Object.defineProperty(res, 'json', { get() { try { return JSON.parse(res.chunks.join('')); } catch { return null; } } });
  return res;
}

const blobFor = name => name.split('').reduce((a, c) => a + c.charCodeAt(0), 0).toString(16).padStart(40, '7');
const skill = (id, name) => ({ id, name, repository, blob_sha: blobFor(name), seen_sha: commitSha, description: '' });

function harness(over = {}) {
  const state = {
    delivery: { repository, installation_id: 42, branch: 'main', revoked_at: null },
    sources: [{ id: 'src-1', repository, commit_sha: commitSha, is_delivery_target: true }],
    skills: [skill('sk-1', 'review-style'), skill('sk-2', 'trace-analysis')],
    kit: [{ skill_id: 'sk-1' }],
    existing: ['skills/review-style/SKILL.md', 'claude-code/skills/trace-analysis/SKILL.md',
      'claude-code/.claude-plugin/plugin.json', 'README.md'],
    delivered: 3,
    live: ['claude-code'],
    ...over.state,
  };
  const calls = [];
  const record = (name, ...args) => { calls.push({ name, args }); };
  const service = {
    delivery: async () => state.delivery,
    sources: async () => state.sources,
    skills: async () => state.skills,
    kit: async () => state.kit,
    liveTargets: async () => state.live,
    deliveredCount: async () => state.delivered,
    syncSource: async (...a) => { record('syncSource', ...a); return a[2]; },
    connectDelivery: async (...a) => { record('connectDelivery', ...a); return { repository: a[0], branch: a[2] }; },
    openRelease: async a => { record('openRelease', a); return { ...a, version: 4, commit_sha: state.reservedCommit ?? null, checksum: null }; },
    finishRelease: async a => { record('finishRelease', a); return { version: 4, checksum: a.checksum }; },
    ...over.service,
  };
  const app = {
    verifyInstallation: async (...a) => { record('verifyInstallation', ...a); return { token: 'ghs_x', account: 'NeerajG03' }; },
    defaultBranch: async () => 'master',
    resolveBranch: async () => ({ branch: 'main', commitSha, treeSha: 'b'.repeat(40), empty: false }),
    listTreePaths: async () => state.existing,
    readSkill: async a => { record('readSkill', a); return `---\nname: x\n---\nbody for ${a.blobSha}\n`; },
    listSkills: async () => ({ skills: [{ name: 'review-style', path: 'skills/review-style/SKILL.md', description: 'd', nameMismatch: false }], truncated: false }),
    commitRelease: async (...a) => { record('commitRelease', ...a); return newCommit; },
    createTag: async (...a) => { record('createTag', ...a); return { created: true }; },
    ...over.app,
  };
  const handle = createSkillsHandler({
    makeClient: () => ({}), makeService: () => service, makeApp: () => app,
    verify: async token => verifyCompanionToken(token, over.keys ?? state.keys),
    env: over.env ?? env,
  });
  return { handle, calls, state, app, service };
}

test('only a companion token may manage skills', async t => {
  const keys = await jwks();
  await t.test('an agent token is rejected, which is the inverse of the MCP verifier', async () => {
    await assert.rejects(verifyCompanionToken(await mint({ client_id: 'some-agent', satchel_grant_id: 'g' }), keys),
      /Agent tokens cannot manage skills/);
  });
  await t.test('a plain companion token passes', async () => {
    const payload = await verifyCompanionToken(await mint(), keys);
    assert.equal(payload.sub, 'user-1');
  });
  await t.test('the request is refused with 401 when the token is missing or an agent token', async () => {
    for (const authorization of [undefined, `Bearer ${await mint({ client_id: 'a', satchel_grant_id: 'g' })}`]) {
      const { handle } = harness({ keys });
      const res = reply();
      await handle({ method: 'POST', headers: authorization ? { authorization } : {}, body: { action: 'connect' } }, res);
      assert.equal(res.status, 401);
    }
  });
  await t.test('a GitHub identity is required and never taken from the request body', () => {
    assert.equal(githubLogin({ user_metadata: { user_name: 'NeerajG03' } }), 'NeerajG03');
    assert.throws(() => githubLogin({ user_metadata: {} }), /No GitHub identity/);
    assert.throws(() => githubLogin({ user_metadata: { user_name: 'not a login!' } }), /No GitHub identity/);
  });
});

test('the handler refuses what it cannot safely do', async t => {
  const keys = await jwks();
  const authorization = `Bearer ${await mint()}`;
  const send = async (body, over = {}) => {
    const { handle, calls } = harness({ keys, ...over });
    const res = reply();
    await handle({ method: 'POST', headers: { authorization }, body }, res);
    return { res, calls };
  };

  await t.test('a non-POST is 405', async () => {
    const { handle } = harness({ keys });
    const res = reply();
    await handle({ method: 'GET', headers: { authorization }, body: {} }, res);
    assert.equal(res.status, 405);
  });

  await t.test('an unconfigured deployment says so instead of half working', async () => {
    const { res } = await send({ action: 'connect' }, { env: { VITE_SUPABASE_PUBLISHABLE_KEY: 'k' } });
    assert.equal(res.status, 503);
    assert.match(res.json.error, /not configured/);
  });

  await t.test('a malformed repository never reaches GitHub', async () => {
    const { res, calls } = await send({ action: 'connect', repository: 'not-a-repo', installation_id: 42 });
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });

  await t.test('an installation the user does not own is 403 and writes nothing', async () => {
    const { res, calls } = await send({ action: 'connect', repository, installation_id: 42 }, {
      app: { verifyInstallation: async () => { throw new GitHubError(403, 'That installation belongs to a different GitHub account'); } },
    });
    assert.equal(res.status, 403);
    assert.ok(!calls.some(c => c.name === 'connectDelivery'), 'no claim is stored on a failed check');
  });

  await t.test('a good connect verifies first, then stores the claim', async () => {
    const { res, calls } = await send({ action: 'connect', repository: 'NeerajG03/My-Skills', installation_id: 42 });
    assert.equal(res.status, 200);
    assert.deepEqual(calls.map(c => c.name), ['verifyInstallation', 'connectDelivery']);
    assert.equal(calls[1].args[0], 'neerajg03/my-skills', 'normalized before storage');
    assert.equal(calls[1].args[2], 'master', 'the repository default branch is recorded, not assumed to be main');
  });

  await t.test('publishing without a connected repository is refused', async () => {
    const { res } = await send({ action: 'publish', target: 'claude-code', release_id: 'r1' },
      { state: { delivery: null } });
    assert.match(res.json.error, /Connect a delivery repository/);
  });

  await t.test('a revoked delivery is treated as not connected', async () => {
    const { res } = await send({ action: 'publish', target: 'claude-code', release_id: 'r1' },
      { state: { delivery: { repository, installation_id: 42, branch: 'main', revoked_at: '2026-09-15T00:00:00Z' } } });
    assert.match(res.json.error, /Connect a delivery repository/);
  });

  await t.test('an unknown target and an empty kit are both refused', async () => {
    assert.equal((await send({ action: 'publish', target: 'cursor', release_id: 'r1' })).res.status, 400);
    const { res } = await send({ action: 'publish', target: 'claude-code', release_id: 'r1' }, { state: { kit: [] } });
    assert.match(res.json.error, /Tick at least one skill/);
  });
});

test('a publish reserves, writes only its own paths, then stamps delivery', async t => {
  const keys = await jwks();
  const authorization = `Bearer ${await mint()}`;
  const publish = async (over = {}) => {
    const { handle, calls } = harness({ keys, ...over });
    const res = reply();
    await handle({ method: 'POST', headers: { authorization }, body: { action: 'publish', target: 'claude-code', release_id: 'rel-1' } }, res);
    return { res, calls };
  };

  await t.test('ownership is re-verified on every publish, not just on connect', async () => {
    const { calls } = await publish();
    assert.equal(calls.filter(c => c.name === 'verifyInstallation').length, 1);
  });

  await t.test('delivery is stamped before tagging, since a tag is only a convenience', async () => {
    const { res, calls } = await publish();
    assert.equal(res.status, 200);
    assert.deepEqual(calls.map(c => c.name).filter(n => !['verifyInstallation', 'readSkill'].includes(n)),
      ['openRelease', 'commitRelease', 'finishRelease', 'createTag']);
    assert.equal(res.json.release.commit_sha, newCommit);
    assert.equal(res.json.release.version, 4);
  });

  await t.test('skill content is read by its own blob sha, not the commit sha', async () => {
    // Passing seen_sha here asks GitHub for a blob by a commit id, which 404s
    // and makes every publish fail. It shipped once; it does not ship again.
    const { calls } = await publish();
    const read = calls.filter(c => c.name === 'readSkill');
    assert.equal(read.length, 1);
    assert.equal(read[0].args[0].blobSha, blobFor('review-style'));
    assert.notEqual(read[0].args[0].blobSha, commitSha, 'a commit sha is not a blob sha');
  });

  await t.test('the stored checksum describes exactly the bytes that were committed', async () => {
    const { calls } = await publish();
    const committed = calls.find(c => c.name === 'commitRelease').args[0].files;
    const stamped = calls.find(c => c.name === 'finishRelease').args[0];
    assert.equal(stamped.checksum, checksum(committed),
      'building before the version is allocated stores a checksum for a tree that never existed');
    assert.deepEqual(stamped.files, committed);
    assert.deepEqual(stamped.generatedPaths, Object.keys(committed).sort());
  });

  await t.test('the committed tree carries the allocated version, not the provisional one', async () => {
    const { calls } = await publish();
    const commit = calls.find(c => c.name === 'commitRelease').args[0];
    assert.equal(JSON.parse(commit.files['claude-code/.claude-plugin/plugin.json']).version, '0.0.4');
    assert.match(commit.message, /claude-code release v4/);
    assert.equal(calls.find(c => c.name === 'createTag').args[0].tag, 'claude-code-v4');
  });

  await t.test('only the unticked generated path is deleted, never a shared or source path', async () => {
    const { res, calls } = await publish({
      state: {
        existing: ['claude-code/skills/trace-analysis/SKILL.md', 'README.md',
          'skills/review-style/SKILL.md', 'codex/skills/review-style/SKILL.md', 'LICENSE'],
      },
    });
    const commit = calls.find(c => c.name === 'commitRelease').args[0];
    assert.deepEqual(commit.deletions, ['claude-code/skills/trace-analysis/SKILL.md']);
    assert.deepEqual(res.json.release.removed, ['claude-code/skills/trace-analysis/SKILL.md']);
  });

  await t.test('a first publish into an empty repository deletes nothing', async () => {
    const { calls } = await publish({
      app: { resolveBranch: async () => ({ branch: 'main', commitSha: null, treeSha: null, empty: true }) },
    });
    assert.deepEqual(calls.find(c => c.name === 'commitRelease').args[0].deletions, []);
  });

  await t.test('a README written before Satchel ever published here is left alone', async () => {
    const { res, calls } = await publish({ state: { delivered: 0, existing: ['README.md'] } });
    assert.ok(!('README.md' in calls.find(c => c.name === 'commitRelease').args[0].files));
    assert.match(res.json.notes.join(' '), /Left your existing README\.md alone/);
  });

  await t.test('once Satchel owns the repository it does maintain the README', async () => {
    const { calls } = await publish({ state: { delivered: 2, existing: ['README.md'] } });
    assert.ok('README.md' in calls.find(c => c.name === 'commitRelease').args[0].files);
  });

  await t.test('replaying a delivered release returns it instead of committing again', async () => {
    const { res, calls } = await publish({ state: { reservedCommit: newCommit } });
    assert.equal(res.status, 200);
    assert.ok(!calls.some(c => c.name === 'commitRelease'), 'a replay must not add a second commit');
    assert.match(res.json.notes.join(' '), /already delivered/);
  });

  await t.test('a tag failure still leaves the release delivered, and says so', async () => {
    const { res, calls } = await publish({
      app: { createTag: async () => { throw new GitHubError(409, 'Tag claude-code-v4 already points at a different commit'); } },
    });
    assert.equal(res.status, 200);
    assert.ok(calls.some(c => c.name === 'finishRelease'), 'the commit landed, so the release is delivered');
    assert.match(res.json.notes.join(' '), /tag could not be created/);
  });

  await t.test('a failed commit is an uncertain outcome and is never stamped as delivered', async () => {
    const { res, calls } = await publish({
      app: { commitRelease: async () => { throw new GitHubError(502, 'GitHub is unavailable'); } },
    });
    assert.equal(res.status, 502);
    assert.ok(calls.some(c => c.name === 'openRelease'), 'the version stays reserved for a retry');
    assert.ok(!calls.some(c => c.name === 'finishRelease'), 'an uncertain publish must not be reported as delivered');
    assert.ok(!res.json.release);
  });


});

test('a sync caches identity and refuses to act on a partial listing', async t => {
  const keys = await jwks();
  const authorization = `Bearer ${await mint()}`;
  const listed = truncated => ({
    listSkills: async () => ({
      truncated,
      skills: [
        { name: 'review-style', path: 'skills/review-style/SKILL.md', blobSha: blobFor('review-style'), description: 'How I want it.', nameMismatch: false },
        { name: 'trace-analysis', path: 'skills/trace-analysis/SKILL.md', blobSha: blobFor('trace-analysis'), description: 'Traces.', nameMismatch: true },
      ],
    }),
  });
  const send = async app => {
    const { handle, calls } = harness({ keys, app });
    const res = reply();
    await handle({ method: 'POST', headers: { authorization }, body: { action: 'sync', source_id: 'src-1' } }, res);
    return { res, calls };
  };

  await t.test('identity is cached, with a blob sha and no content', async () => {
    const { res, calls } = await send(listed(false));
    assert.equal(res.status, 200);
    assert.equal(res.json.synced, 2);
    assert.match(res.json.warnings[0], /frontmatter name differs/);
    const synced = calls.find(c => c.name === 'syncSource').args[2];
    assert.deepEqual(Object.keys(synced[0]).sort(), ['blob_sha', 'description', 'name', 'path'],
      'no skill content is ever sent to the database');
  });

  await t.test('a truncated listing changes nothing at all', async () => {
    // Syncing a partial list deletes every skill it could not see, and the kit
    // selections with them, then warns afterwards. Refuse instead.
    const { res, calls } = await send(listed(true));
    assert.equal(res.status, 409);
    assert.ok(!calls.some(c => c.name === 'syncSource'));
    assert.match(res.json.error, /too large to list/);
  });
});
