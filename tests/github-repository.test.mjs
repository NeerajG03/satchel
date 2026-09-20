import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGitHubRepository } from '../src/features/projects/githubRepository.ts';

test('accepts owner/repo in every common spelling', () => {
  for (const input of ['NeerajG03/satchel', 'NeerajG03/satchel/', 'NeerajG03/satchel.git', 'https://github.com/NeerajG03/satchel', 'https://github.com/NeerajG03/satchel/', 'git@github.com:NeerajG03/satchel.git'])
    assert.equal(normalizeGitHubRepository(input), 'neerajg03/satchel', input);
});

test('rejects other hosts and malformed values', () => {
  assert.equal(normalizeGitHubRepository('https://gitlab.com/a/b'), null);
  assert.equal(normalizeGitHubRepository('just-a-name'), null);
  assert.equal(normalizeGitHubRepository('a/b/c'), null);
});
