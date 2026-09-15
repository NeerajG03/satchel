import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { jwtVerify, importSPKI } from 'jose';
import { githubApp, appJwt, readFrontmatter, GitHubError } from '../server/github-app.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const appId = 987654;
const repository = 'neerajg03/my-skills';
const commitSha = 'a'.repeat(40);
const treeSha = 'b'.repeat(40);
const newCommit = 'c'.repeat(40);
const b64 = text => Buffer.from(text, 'utf8').toString('base64');

function fake(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = String(url).replace('https://api.github.com', '');
    const method = init.method ?? 'GET';
    const call = { method, path, key: `${method} ${path}`, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const route = routes[call.key];
    if (!route) return new Response(JSON.stringify({ message: `unrouted ${call.key}` }), { status: 404 });
    const resolved = typeof route === 'function' ? route(call) : route;
    return new Response(resolved.body === undefined ? '' : JSON.stringify(resolved.body), { status: resolved.status ?? 200 });
  };
  return { calls, fetchImpl, app: githubApp({ appId, privateKey, fetchImpl }) };
}

const tokenRoute = { 'POST /app/installations/42/access_tokens': { status: 201, body: { token: 'ghs_installation' } } };

test('the App JWT carries the claims GitHub requires', async () => {
  const now = 1_780_000_000;
  const token = await appJwt({ appId, privateKey, now });
  const { payload, protectedHeader } = await jwtVerify(token, await importSPKI(publicKey, 'RS256'),
    { issuer: String(appId), currentDate: new Date(now * 1000) });
  assert.equal(protectedHeader.alg, 'RS256');
  assert.equal(payload.iss, String(appId));
  assert.equal(payload.iat, now - 60, 'back-dated for clock skew');
  assert.ok(payload.exp - now <= 600, 'GitHub rejects an expiry more than 10 minutes out');
});

test('installation ownership is verified before anything is written', async t => {
  await t.test('an installation owned by someone else is refused', async () => {
    const { app } = fake({ 'GET /app/installations/42': { body: { account: { login: 'someone-else' } } }, ...tokenRoute });
    await assert.rejects(app.verifyInstallation({ installationId: 42, repository, login: 'NeerajG03' }),
      e => e instanceof GitHubError && e.status === 403 && /different GitHub account/.test(e.message));
  });

  await t.test('a repository outside the installation is refused', async () => {
    const { app } = fake({
      'GET /app/installations/42': { body: { account: { login: 'neerajg03' } } }, ...tokenRoute,
      'GET /installation/repositories?per_page=100': { body: { repositories: [{ full_name: 'neerajg03/something-else' }] } },
    });
    await assert.rejects(app.verifyInstallation({ installationId: 42, repository, login: 'neerajg03' }),
      e => e.status === 403 && /not installed on that repository/.test(e.message));
  });

  await t.test('a matching account and repository returns a usable token', async () => {
    const { app, calls } = fake({
      'GET /app/installations/42': { body: { account: { login: 'NeerajG03' } } }, ...tokenRoute,
      'GET /installation/repositories?per_page=100': { body: { repositories: [{ full_name: 'NeerajG03/My-Skills' }] } },
    });
    const result = await app.verifyInstallation({ installationId: 42, repository, login: 'neerajg03' });
    assert.equal(result.token, 'ghs_installation');
    const appCall = calls.find(c => c.path === '/app/installations/42');
    assert.match(appCall.headers.authorization, /^Bearer ey/, 'app endpoints use the App JWT, not an installation token');
    const listCall = calls.find(c => c.path.startsWith('/installation/repositories'));
    assert.equal(listCall.headers.authorization, 'Bearer ghs_installation');
  });

  await t.test('a missing token in the response is an error, not an empty token', async () => {
    const { app } = fake({ 'POST /app/installations/42/access_tokens': { status: 201, body: {} } });
    await assert.rejects(app.installationToken(42), e => e.status === 502);
  });
});

test('a repository with no commits is the expected first-publish state', async t => {
  await t.test('an existing branch resolves to its commit and tree', async () => {
    const { app } = fake({
      [`GET /repos/${repository}`]: { body: { default_branch: 'main' } },
      [`GET /repos/${repository}/git/ref/heads/main`]: { body: { object: { sha: commitSha } } },
      [`GET /repos/${repository}/git/commits/${commitSha}`]: { body: { tree: { sha: treeSha } } },
    });
    assert.deepEqual(await app.resolveBranch({ token: 't', repository }), { branch: 'main', commitSha, treeSha, empty: false });
  });

  await t.test('a 404 on the ref means empty, not broken', async () => {
    const { app } = fake({ [`GET /repos/${repository}`]: { body: { default_branch: 'trunk' } } });
    assert.deepEqual(await app.resolveBranch({ token: 't', repository }), { branch: 'trunk', commitSha: null, treeSha: null, empty: true });
  });
});

test('skill discovery reads only skills/<name>/SKILL.md', async t => {
  const tree = {
    truncated: false,
    tree: [
      { type: 'blob', path: 'skills/review-style/SKILL.md', sha: '1'.repeat(40) },
      { type: 'blob', path: 'skills/trace-analysis/SKILL.md', sha: '2'.repeat(40) },
      { type: 'blob', path: 'skills/review-style/reference.md', sha: '3'.repeat(40) },
      { type: 'blob', path: 'claude-code/skills/review-style/SKILL.md', sha: '4'.repeat(40) },
      { type: 'blob', path: 'skills/Bad Name/SKILL.md', sha: '5'.repeat(40) },
      { type: 'blob', path: 'README.md', sha: '6'.repeat(40) },
      { type: 'tree', path: 'skills/review-style', sha: '7'.repeat(40) },
    ],
  };
  const routes = {
    [`GET /repos/${repository}/git/trees/${commitSha}?recursive=1`]: { body: tree },
    [`GET /repos/${repository}/git/blobs/${'1'.repeat(40)}`]: { body: { encoding: 'base64', content: b64('---\nname: review-style\ndescription: How I want a review written.\n---\n\nLead with the risk.\n') } },
    [`GET /repos/${repository}/git/blobs/${'2'.repeat(40)}`]: { body: { encoding: 'base64', content: b64('---\nname: renamed-upstream\ndescription: Walks a trace.\n---\n\nDeepest frame first.\n') } },
  };

  await t.test('generated copies, support files and invalid names are all skipped', async () => {
    const { app } = fake(routes);
    const { skills, truncated } = await app.listSkills({ token: 't', repository, commitSha });
    assert.deepEqual(skills.map(s => s.name), ['review-style', 'trace-analysis']);
    assert.equal(truncated, false);
  });

  await t.test('content is decoded and the description comes from frontmatter', async () => {
    const { app } = fake(routes);
    const { skills } = await app.listSkills({ token: 't', repository, commitSha });
    assert.equal(skills[0].description, 'How I want a review written.');
    assert.match(skills[0].content, /Lead with the risk\./);
    assert.equal(skills[0].nameMismatch, false);
  });

  await t.test('a frontmatter name that disagrees with the directory is surfaced, not corrected', async () => {
    const { app } = fake(routes);
    const { skills } = await app.listSkills({ token: 't', repository, commitSha });
    assert.equal(skills[1].nameMismatch, true, 'Claude uses frontmatter name for the invocation name');
  });

  await t.test('a truncated tree is reported rather than returned as a partial shelf', async () => {
    const { app } = fake({ ...routes, [`GET /repos/${repository}/git/trees/${commitSha}?recursive=1`]: { body: { ...tree, truncated: true } } });
    assert.equal((await app.listSkills({ token: 't', repository, commitSha })).truncated, true);
  });
});

test('a publish changes only the paths it is given', async t => {
  const files = { 'README.md': 'x\n', 'claude-code/skills/review-style/SKILL.md': 'y\n' };
  const writeRoutes = {
    [`POST /repos/${repository}/git/trees`]: { status: 201, body: { sha: 'd'.repeat(40) } },
    [`POST /repos/${repository}/git/commits`]: { status: 201, body: { sha: newCommit } },
    [`PATCH /repos/${repository}/git/refs/heads%2Fmain`]: { body: { object: { sha: newCommit } } },
    [`POST /repos/${repository}/git/refs`]: { status: 201, body: { object: { sha: newCommit } } },
  };

  await t.test('base_tree is sent, so untouched paths survive the commit', async () => {
    const { app, calls } = fake(writeRoutes);
    const sha = await app.commitRelease({ token: 't', repository, branch: 'main',
      parent: { commitSha, treeSha, empty: false }, files, deletions: ['claude-code/skills/gone/SKILL.md'], message: 'Satchel release' });
    assert.equal(sha, newCommit);
    const treeCall = calls.find(c => c.path.endsWith('/git/trees'));
    assert.equal(treeCall.body.base_tree, treeSha, 'without base_tree the user source would be deleted');
    assert.deepEqual(treeCall.body.tree.filter(e => e.sha === null).map(e => e.path), ['claude-code/skills/gone/SKILL.md']);
    assert.deepEqual(treeCall.body.tree.filter(e => e.content).map(e => e.path),
      ['README.md', 'claude-code/skills/review-style/SKILL.md']);
    assert.equal(calls.find(c => c.path.endsWith('/git/commits')).body.parents[0], commitSha);
  });

  await t.test('an empty repository gets a parentless commit and a created ref', async () => {
    const { app, calls } = fake(writeRoutes);
    await app.commitRelease({ token: 't', repository, branch: 'main',
      parent: { commitSha: null, treeSha: null, empty: true }, files, message: 'first' });
    const treeCall = calls.find(c => c.path.endsWith('/git/trees'));
    assert.ok(!('base_tree' in treeCall.body));
    assert.deepEqual(calls.find(c => c.path.endsWith('/git/commits')).body.parents, []);
    assert.ok(calls.some(c => c.key === `POST /repos/${repository}/git/refs`), 'a new branch is created, not patched');
  });

  await t.test('nonsense writes are refused before any request is made', async () => {
    const { app, calls } = fake(writeRoutes);
    await assert.rejects(app.commitRelease({ token: 't', repository, branch: 'main',
      parent: { empty: false, treeSha }, files: {}, message: 'nothing' }), /empty change/);
    await assert.rejects(app.commitRelease({ token: 't', repository, branch: 'main',
      parent: { empty: true }, files, deletions: ['x'], message: 'impossible' }), /no commits/);
    assert.equal(calls.length, 0);
  });

  await t.test('a bad repository name never reaches the network', async () => {
    const { app, calls } = fake(writeRoutes);
    await assert.rejects(app.commitRelease({ token: 't', repository: '../../etc/passwd', branch: 'main',
      parent: { empty: false, treeSha }, files, message: 'x' }), /Invalid repository/);
    assert.equal(calls.length, 0);
  });
});

test('a retried publish is not defeated by its own tag', async t => {
  const tag = 'claude-code-v4';
  await t.test('a fresh tag is created', async () => {
    const { app } = fake({ [`POST /repos/${repository}/git/refs`]: { status: 201, body: {} } });
    assert.deepEqual(await app.createTag({ token: 't', repository, commitSha: newCommit, tag }), { tag, created: true });
  });

  await t.test('an existing tag on the same commit is success', async () => {
    const { app } = fake({
      [`POST /repos/${repository}/git/refs`]: { status: 422, body: { message: 'Reference already exists' } },
      [`GET /repos/${repository}/git/ref/tags/${tag}`]: { body: { object: { sha: newCommit } } },
    });
    assert.deepEqual(await app.createTag({ token: 't', repository, commitSha: newCommit, tag }), { tag, created: false });
  });

  await t.test('an existing tag on a different commit is a real conflict', async () => {
    const { app } = fake({
      [`POST /repos/${repository}/git/refs`]: { status: 422, body: { message: 'Reference already exists' } },
      [`GET /repos/${repository}/git/ref/tags/${tag}`]: { body: { object: { sha: commitSha } } },
    });
    await assert.rejects(app.createTag({ token: 't', repository, commitSha: newCommit, tag }),
      e => e.status === 409 && /different commit/.test(e.message));
  });
});

test('frontmatter reading stays inside what it can honestly parse', () => {
  assert.deepEqual(readFrontmatter('---\nname: a\ndescription: b\n---\nbody'), { name: 'a', description: 'b' });
  assert.equal(readFrontmatter('---\nname: a\ndescription: >\n  one\n  two\n---\n').description, 'one two');
  assert.equal(readFrontmatter('---\ndescription: "quoted value"\n---\n').description, 'quoted value');
  assert.deepEqual(readFrontmatter('no frontmatter'), {});
  assert.deepEqual(readFrontmatter('---\nname: a\nunterminated'), {}, 'a missing closing fence is not frontmatter');
  assert.deepEqual(readFrontmatter('---\nallowed-tools:\n  - Read\n  - Grep\n---\n').name, undefined);
});
