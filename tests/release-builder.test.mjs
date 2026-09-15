import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRelease, checksum, deletions, PLUGIN, MARKETPLACE, SHARED } from '../server/release-builder.mjs';

const repository = 'neerajg03/my-skills';
const review = { name: 'review-style', content: '---\nname: review-style\ndescription: How I want a review written.\n---\n\nLead with the risk.\n' };
const trace = { name: 'trace-analysis', content: '---\nname: trace-analysis\ndescription: Walks a stack trace down.\n---\n\nStart at the deepest frame.\n' };
const build = (over = {}) => buildRelease({ target: 'claude-code', version: 1, repository, skills: [review], liveTargets: ['claude-code'], ...over });

test('the release builder is deterministic and never emits an MCP declaration', async t => {
  await t.test('the same selection produces byte-identical output', () => {
    const a = build(), b = build();
    assert.deepEqual(a.files, b.files);
    assert.equal(a.checksum, b.checksum);
    assert.deepEqual(a.generatedPaths, b.generatedPaths);
  });

  await t.test('the checksum moves when anything that ships moves', () => {
    const base = build().checksum;
    assert.notEqual(build({ skills: [review, trace] }).checksum, base);
    assert.notEqual(build({ skills: [{ ...review, content: review.content + 'and the fix.\n' }] }).checksum, base);
    assert.notEqual(build({ version: 2 }).checksum, base);
    assert.notEqual(build({ target: 'codex' }).checksum, base);
  });

  await t.test('the checksum ignores key order but not path or length', () => {
    assert.equal(checksum({ a: '1', b: '2' }), checksum({ b: '2', a: '1' }));
    assert.notEqual(checksum({ a: '1', b: '2' }), checksum({ a: '12', b: '' }));
    assert.notEqual(checksum({ a: '1' }), checksum({ b: '1' }));
  });

  await t.test('no file declares an MCP server or a registered app', () => {
    for (const target of ['claude-code', 'codex']) {
      const { files } = build({ target, skills: [review, trace], liveTargets: ['claude-code', 'codex'] });
      for (const path of Object.keys(files)) {
        assert.ok(!/(^|\/)\.?mcp\.json$/.test(path), `${path} would mark the kit Desktop only`);
        assert.ok(!/(^|\/)\.app\.json$/.test(path), `${path} references a registered app`);
      }
      const all = Object.values(files).join('\n');
      assert.ok(!all.includes('mcpServers'), 'no manifest may declare mcpServers');
    }
  });

  await t.test('a skill ships verbatim, so the delivered file matches its source', () => {
    const { files } = build({ skills: [review, trace] });
    assert.equal(files['claude-code/skills/review-style/SKILL.md'], review.content);
    assert.equal(files['claude-code/skills/trace-analysis/SKILL.md'], trace.content);
  });

  await t.test('each host gets its own marketplace naming only its own plugin', () => {
    const { files } = build({ liveTargets: ['claude-code', 'codex'] });
    const claude = JSON.parse(files['.claude-plugin/marketplace.json']);
    const codex = JSON.parse(files['.agents/plugins/marketplace.json']);
    assert.equal(claude.name, MARKETPLACE);
    assert.equal(codex.name, MARKETPLACE);
    assert.deepEqual(claude.plugins.map(p => p.source), ['./claude-code']);
    assert.deepEqual(codex.plugins.map(p => p.source.path), ['./codex']);
    assert.equal(claude.plugins[0].name, PLUGIN);
    // Codex requires these three on every entry; Claude's schema has none of them.
    assert.equal(codex.plugins[0].policy.installation, 'AVAILABLE');
    assert.equal(codex.plugins[0].policy.authentication, 'ON_INSTALL');
    assert.equal(codex.plugins[0].category, 'Productivity');
  });

  await t.test('a target that has never been published is not advertised', () => {
    const { files } = build({ liveTargets: ['claude-code'] });
    assert.deepEqual(JSON.parse(files['.agents/plugins/marketplace.json']).plugins, []);
    assert.equal(JSON.parse(files['.claude-plugin/marketplace.json']).plugins.length, 1);
  });

  await t.test('the plugin version is bumped so hosts actually ship the update', () => {
    assert.equal(JSON.parse(build({ version: 7 }).files['claude-code/.claude-plugin/plugin.json']).version, '0.0.7');
    assert.equal(JSON.parse(build({ target: 'codex', version: 7 }).files['codex/plugin.json']).version, '0.0.7');
  });

  await t.test('Codex gets one portable manifest, not a second competing one', () => {
    const { files } = build({ target: 'codex' });
    assert.ok(files['codex/plugin.json']);
    assert.ok(!files['codex/.claude-plugin/plugin.json'],
      'a second manifest would replace rather than merge the OpenAI extension');
    assert.equal(JSON.parse(files['codex/plugin.json']).$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  });

  await t.test('generated paths are the shared files plus this target only', () => {
    const { generatedPaths } = build({ skills: [review, trace] });
    for (const path of SHARED) assert.ok(generatedPaths.includes(path));
    assert.ok(generatedPaths.every(p => SHARED.includes(p) || p.startsWith('claude-code/')));
    assert.deepEqual(generatedPaths, [...generatedPaths].sort());
  });

  await t.test('a bad selection is refused rather than silently collapsed', () => {
    assert.throws(() => build({ skills: [review, review] }), /Duplicate skill/);
    assert.throws(() => build({ target: 'cursor' }), /Unsupported target/);
    assert.throws(() => build({ version: 0 }), /positive integer/);
  });
});

test('a publish can only delete paths its own target previously owned', async t => {
  const { generatedPaths } = build({ skills: [review] });

  await t.test('the user source directory is never a deletion candidate', () => {
    const previous = [
      'skills/review-style/SKILL.md', 'skills/trace-analysis/SKILL.md',
      'skills/anything/reference.md', 'README.md', 'LICENSE', '.gitignore',
      '.claude-plugin/marketplace.json', 'codex/skills/review-style/SKILL.md',
    ];
    assert.deepEqual(deletions({ previousPaths: previous, generatedPaths, target: 'claude-code' }), []);
  });

  await t.test('a skill removed from the kit loses its generated copy', () => {
    assert.deepEqual(deletions({
      previousPaths: [...generatedPaths, 'claude-code/skills/trace-analysis/SKILL.md'],
      generatedPaths, target: 'claude-code',
    }), ['claude-code/skills/trace-analysis/SKILL.md']);
  });

  await t.test('one target never deletes the other target files', () => {
    const codex = build({ target: 'codex', skills: [review] });
    assert.deepEqual(deletions({
      previousPaths: ['claude-code/skills/review-style/SKILL.md', 'claude-code/.claude-plugin/plugin.json'],
      generatedPaths: codex.generatedPaths, target: 'codex',
    }), []);
  });

  await t.test('shared files are rewritten, never removed', () => {
    const result = deletions({ previousPaths: SHARED, generatedPaths: ['claude-code/x'], target: 'claude-code' });
    assert.deepEqual(result, []);
  });

  await t.test('a first publish with no history deletes nothing', () => {
    assert.deepEqual(deletions({ generatedPaths, target: 'claude-code' }), []);
  });
});
