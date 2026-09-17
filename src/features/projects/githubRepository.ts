export function normalizeGitHubRepository(value: string): string | null {
  const input = value.trim();
  let repository = input;
  const ssh = input.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (ssh) repository = ssh[1];
  else if (/^https?:\/\//i.test(input) || /^ssh:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      if (url.hostname.toLowerCase() !== 'github.com') return null;
      repository = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    } catch { return null; }
  }
  repository = repository.replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository) && repository.length <= 201 ? repository : null;
}
