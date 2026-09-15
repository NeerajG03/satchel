export const TARGETS = ['claude-code', 'codex'] as const;
export type Target = typeof TARGETS[number];
export const TARGET_LABELS: Record<Target, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

export const PLUGIN = 'satchel-skills';
export const MARKETPLACE = 'satchel-kit';

export type SkillSource = {
  id: string; repository: string; commit_sha: string | null;
  is_delivery_target: boolean; synced_at: string | null;
};
export type Skill = {
  id: string; source_id: string; repository: string; path: string; name: string;
  // blob_sha identifies the file. seen_sha is only the commit it was read at,
  // which is the same for every skill in a source and so detects nothing.
  description: string; blob_sha: string; seen_sha: string; synced_at: string;
};
export type KitItem = { target: Target; skill_id: string };
export type ReleaseManifest = { target: Target; repository: string; skills: { name: string; blob_sha: string }[] };
export type Release = {
  id: string; target: Target; version: number; checksum: string;
  commit_sha: string | null; delivered_at: string | null; manifest: ReleaseManifest;
};
export type Delivery = { repository: string; installation_id: number; branch: string; revoked_at: string | null };

export function normalizeRepository(value: string): string | null {
  const input = value.trim();
  let repository = input;
  const ssh = input.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (ssh) repository = ssh[1];
  else if (/^(https?|ssh):\/\//i.test(input)) {
    try {
      const url = new URL(input);
      if (url.hostname.toLowerCase() !== 'github.com') return null;
      repository = url.pathname.replace(/^\/+|\/+$/g, '');
    } catch { return null; }
  }
  repository = repository.replace(/\.git$/i, '').toLowerCase();
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository) && repository.length <= 201 ? repository : null;
}

// Why this kit differs from what agents last received. Each reason is a
// distinct cause, because "out of date" alone does not tell you what to do.
export function pendingReasons(ticked: Skill[], release: Release | null): string[] {
  const names = ticked.map(skill => skill.name).sort();
  if (!release) return names.length ? [`${names.length} skill${names.length === 1 ? '' : 's'} never published`] : [];
  const published = new Map(release.manifest.skills.map(skill => [skill.name, skill.blob_sha]));
  const added = names.filter(name => !published.has(name));
  const removed = [...published.keys()].filter(name => !names.includes(name)).sort();
  // Compares the file's own identity. Comparing the commit would mark every
  // skill edited whenever any unrelated commit landed in the source.
  const edited = ticked.filter(skill => published.has(skill.name) && published.get(skill.name) !== skill.blob_sha)
    .map(skill => skill.name).sort();
  const reasons: string[] = [];
  if (added.length) reasons.push(`added: ${added.join(', ')}`);
  if (removed.length) reasons.push(`removed: ${removed.join(', ')}`);
  if (edited.length) reasons.push(`edited since v${release.version}: ${edited.join(', ')}`);
  return reasons;
}

export function setupCommands(target: Target, repository: string): string[] {
  return target === 'claude-code'
    ? [`claude plugin marketplace add ${repository}`, `claude plugin install ${PLUGIN}@${MARKETPLACE}`]
    : [`codex plugin marketplace add ${repository}`];
}
export function updateCommand(target: Target): string {
  return target === 'claude-code'
    ? `claude plugin marketplace update ${MARKETPLACE}`
    : `codex plugin marketplace upgrade ${MARKETPLACE}`;
}
