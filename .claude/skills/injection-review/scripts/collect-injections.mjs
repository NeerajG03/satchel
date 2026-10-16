#!/usr/bin/env node
// Real prompts, what Satchel showed on them, and the memory set to judge
// against, into the private folder the injection eval reads.
//
//   node collect-injections.mjs [--days 21] [--checkout <dir>] [--no-embed] [--refresh]
//
// Three things, all read only:
//
//   snapshot   settings, topics, repository links and every memory (ended ones
//              too, so production's mistakes can be named), with the stored
//              vectors, from the database through the management API.
//   sessions   every Claude Code transcript on this machine that Satchel ran
//              in. A moment is one prompt: what was typed, where, which topic
//              was selected by then, and what Satchel actually injected. The
//              injected text is parsed back to memory ids, so production can
//              be scored against the same gold as the replay.
//   blind      the same sessions with Satchel's text cut out, numbered, for
//              labellers who must never see what was shown.
//
// A session is taken once it has been quiet for 12 hours and never again once
// it has labels, so a label always covers the whole session. A fork repeats
// its parent's messages under the same ids, so a message is kept the first
// time it is seen and the copy is dropped.
//
// Prompts are embedded once with the production model and cached by hash.
// That is the only paid call here, a few cents for a few hundred prompts.
import {readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync} from 'node:fs';
import {join, basename} from 'node:path';
import {createHash} from 'node:crypto';
import {sql, lit} from '../../daily-improvement/scripts/db.mjs';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const DAYS = Number(flag('--days') ?? 21);
const CHECKOUT = flag('--checkout') ?? join(import.meta.dirname, '../../../..');
const DIR = process.env.SATCHEL_INJECTION_EVAL_DIR ?? join(process.env.HOME, 'satchel-daily', 'injection-eval');
const PROJECTS = join(process.env.HOME, '.claude', 'projects');
const SETTLED_MS = 12 * 3600e3;
const BATCH_CHARS = 450_000;

const {classifyPrompt} = await import(join(CHECKOUT, 'server/machine-prompt.mjs'));
const {repositoryFrom} = await import(join(CHECKOUT, 'integrations/shared/workspace.mjs'));
const {handleOf} = await import(join(CHECKOUT, 'server/injection-format.mjs'));
const {promptKey, fill} = await import(join(CHECKOUT, 'eval/lib/injection-cache.mjs'));

for (const sub of ['sessions', 'blind', 'gold', 'vectors', 'runs']) mkdirSync(join(DIR, sub), {recursive: true});
const readJson = (path, fallback) => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 1));

// ---- snapshot -------------------------------------------------------------

const owners = await sql(`select owner_id, count(*) n from public.memories group by 1 order by 2 desc`);
const OWNER = flag('--owner') ?? (owners.length === 1 ? owners[0].owner_id : null);
if (!OWNER) throw new Error(`${owners.length} owners have memories; pass --owner <uuid>`);

// The defaults memory-service.mjs settings() falls back to when no row exists.
const DEFAULTS = {per_prompt_matches: 5, gate: 0.67, scope_boost: 1.1, session_budget_tokens: 15000,
  capture: true, capture_window: 5, capture_mode: 'session', block_size: 30, staleness_commits: 25};
const settingsRow = (await sql(`select per_prompt_matches, gate, scope_boost, session_budget_tokens, capture,
  capture_window, capture_mode, block_size, staleness_commits from public.memory_settings
  where owner_id = ${lit(OWNER)} limit 1`))[0];
const topics = await sql(`select id, slug, name, brief from public.topics
  where owner_id = ${lit(OWNER)} and merged_into is null order by name`);
const links = await sql(`select topic_id, provider, repository from public.topic_repositories where owner_id = ${lit(OWNER)}`);
const memoryRows = await sql(`select m.id, m.topic_id, m.statement, m.name, m.band, m.kind, m.mentions,
    m.affirmed_at, m.updated_at, m.created_at, m.ended_at, m.ended_reason, m.expires_at, m.anchor_repository,
    case when m.anchor_commits is null then null else greatest(h.commits - m.anchor_commits, 0) end as commits_since,
    m.embedding::text as embedding
  from public.memories m
  left join public.repository_heads h on h.owner_id = m.owner_id and h.repository = m.anchor_repository
  where m.owner_id = ${lit(OWNER)}`);
const vectors = {};
const iso = value => value == null ? null : new Date(String(value).replace(' ', 'T').replace(/(:\d\d(?:\.\d+)?)([+-]\d\d)$/, '$1$2:00')).toISOString();
const memories = memoryRows.map(({embedding, ...m}) => {
  if (embedding) vectors[m.id] = JSON.parse(embedding);
  for (const key of ['affirmed_at', 'updated_at', 'created_at', 'ended_at', 'expires_at']) m[key] = iso(m[key]);
  return m;
});
const snapshot = {taken_at: new Date().toISOString(), owner: OWNER,
  settings: settingsRow ?? DEFAULTS, topics, links, memories};
writeJson(join(DIR, 'snapshot.json'), snapshot);
writeJson(join(DIR, 'vectors', 'memories.json'), vectors);

// Handles are six hex characters; two memories could share one. The parser
// refuses an ambiguous handle rather than guessing.
const byHandle = new Map();
for (const m of memories) {
  const h = handleOf(m.id);
  byHandle.set(h, byHandle.has(h) ? null : m.id);
}
const idsIn = text => [...String(text).matchAll(/^\s{2}([0-9a-f]{6})\s/gm)]
  .map(match => byHandle.get(match[1])).filter(Boolean);

// ---- sessions -------------------------------------------------------------

const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(x => x?.type === 'text').map(x => x.text).join('\n') : '';
// ◪ is the mark the block carried until 16 October and old sessions still hold.
const MARK = /<satchel>|[▣◪] retrieved|Satchel memory/;
// Written into the transcript by the host and never sent to the prompt hook.
const NOT_A_PROMPT = /^\s*\[Request interrupted by user/;
// The person typed it, but into the shell, not to the agent.
const SHELL = /^\s*<(bash-input|bash-stdout|bash-stderr)>/;
const repoCache = new Map();
function repositoryOf(cwd) {
  if (!cwd) return null;
  if (!repoCache.has(cwd)) {
    // A worktree that has since been removed still belongs to its parent's remote.
    const path = existsSync(cwd) ? cwd : cwd.replace(/\/\.claude\/worktrees\/[^/]+.*$/, '');
    repoCache.set(cwd, existsSync(path) ? repositoryFrom(path) : null);
  }
  return repoCache.get(cwd);
}

const labelled = new Set();
for (const file of readdirSync(join(DIR, 'gold')).filter(f => f.endsWith('.json')))
  for (const s of readJson(join(DIR, 'gold', file), [])) labelled.add(s.session);

const since = Date.now() - DAYS * 86400e3;
const files = [];
for (const project of readdirSync(PROJECTS)) {
  const dir = join(PROJECTS, project);
  if (!statSync(dir).isDirectory()) continue;
  for (const f of readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
    const path = join(dir, f);
    const mtime = statSync(path).mtimeMs;
    if (mtime >= since && Date.now() - mtime >= SETTLED_MS) files.push({path, mtime});
  }
}

const parsed = [];
for (const {path} of files) {
  const raw = readFileSync(path, 'utf8');
  if (!MARK.test(raw)) continue;
  const session = basename(path, '.jsonl');
  const events = [];
  let cwd = null, title = null, first = null, lastPrompt = null, startKind = null;
  const seenStart = new Set();
  const satchelCalls = new Map();
  for (const line of raw.split('\n')) {
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.isSidechain) continue;
    if (d.cwd && !cwd) cwd = d.cwd;
    if (d.type === 'custom-title') title = d.customTitle ?? title;
    const ts = d.timestamp ?? null;
    if (ts && !first) first = ts;
    if (d.type === 'attachment') {
      const a = d.attachment ?? {};
      // The context row is named plain `SessionStart`; the kind (startup,
      // resume, compact) is on the hook's other rows, which come first.
      if (/^SessionStart:/.test(a.hookName ?? '')) startKind = a.hookName.split(':')[1];
      let body = '';
      if (a.type === 'hook_additional_context') body = (a.content ?? []).join('\n');
      else if (a.type === 'hook_success' && a.stdout) {
        try { body = JSON.parse(a.stdout)?.hookSpecificOutput?.additionalContext ?? ''; } catch {}
      }
      if (!body || !MARK.test(body)) continue;
      const hook = a.hookName ?? a.hookEvent ?? '';
      if (hook.startsWith('SessionStart')) {
        // The same block arrives twice, once as the hook's output and once as
        // the context it added. One start, one event.
        const key = `${body}|${String(ts).slice(0, 16)}`;
        if (seenStart.has(key)) continue;
        seenStart.add(key);
        const kind = hook.split(':')[1] ?? startKind;
        const last = events.at(-1);
        if (last?.kind === 'start' && !last.loaded.length && Date.parse(ts) - Date.parse(last.ts) < 5000) {
          last.loaded = idsIn(body); last.how ??= kind; continue;
        }
        events.push({kind: 'start', ts, how: kind, loaded: idsIn(body),
          active: body.match(/active (?:topic|project): ([0-9a-f-]{36})/)?.[1] ?? null});
      } else if (hook.startsWith('UserPromptSubmit') && lastPrompt && !lastPrompt.shownText) {
        lastPrompt.shownText = body;
        lastPrompt.shown = idsIn(body);
      }
    } else if (d.type === 'user' && !d.isMeta && !d.isCompactSummary && !d.isVisibleInTranscriptOnly) {
      const content = d.message?.content;
      if (Array.isArray(content) && content.some(x => x?.type === 'tool_result')) {
        for (const x of content) if (x?.type === 'tool_result' && satchelCalls.has(x.tool_use_id))
          satchelCalls.get(x.tool_use_id).ok = !x.is_error;
        continue;
      }
      const text = textOf(content);
      if (!text.trim() || NOT_A_PROMPT.test(text)) continue;
      // `host` is what production's classifier says; `typed` is the truth the
      // gold is built on. They differ exactly where the classifier leaks.
      const {kind, query} = classifyPrompt(text);
      const shell = SHELL.test(text.replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>\s*/g, ''));
      lastPrompt = {kind: 'prompt', ts, uuid: d.uuid, text, typed: !kind && !shell, host: kind ?? (shell ? 'shell' : null),
        classified: kind ?? null, query, shown: []};
      events.push(lastPrompt);
    } else if (d.type === 'assistant') {
      for (const x of d.message?.content ?? []) {
        if (x?.type === 'text' && x.text?.trim()) {
          events.push({kind: 'reply', ts, text: x.text});
          // The agent is asked to mark the part of an answer a Satchel row
          // shaped. A marked reply is the one sign in a transcript that a row
          // did work, rather than only being shown.
          if (lastPrompt && x.text.includes('▣')) lastPrompt.cited = true;
        }
        else if (x?.type === 'tool_use' && /satchel/i.test(x.name ?? '') && /select_(topic|project)$/.test(x.name)) {
          const call = {kind: 'select', ts, topic_id: x.input?.topic_id ?? x.input?.project_id ?? null};
          satchelCalls.set(x.id, call);
          events.push(call);
        }
      }
    }
  }
  if (!events.some(e => e.kind === 'start')) continue;
  parsed.push({session, cwd, title, first, repository: repositoryOf(cwd), events});
}

// Oldest first, so a fork's copy of its parent's prompts is the one dropped.
parsed.sort((a, b) => String(a.first).localeCompare(String(b.first)));
const seenMessage = new Set();
let collected = 0, skipped = 0;
for (const s of parsed) {
  // --refresh rewrites a labelled session's events after a collector fix. The
  // numbering is the same, so its labels still line up; its blind file is not
  // written again.
  if (labelled.has(s.session) && !args.includes('--refresh')) {
    for (const e of s.events) if (e.kind === 'prompt') seenMessage.add(e.uuid);
    skipped++; continue;
  }
  let n = 0;
  s.events = s.events.filter(e => {
    if (e.kind !== 'prompt') return true;
    if (seenMessage.has(e.uuid)) return false;
    seenMessage.add(e.uuid);
    return true;
  });
  for (const e of s.events) if (e.kind === 'prompt' && e.typed) e.n = ++n;
  if (!n) continue;
  s.prompts = n;
  writeJson(join(DIR, 'sessions', `${s.session}.json`), s);
  collected++;
}

// ---- blind files -------------------------------------------------------------

const slugOf = Object.fromEntries(topics.map(t => [t.id, t.slug]));
const linkedTo = repo => links.filter(l => l.repository === repo).map(l => slugOf[l.topic_id]).filter(Boolean);
// The mark comes off too: it says Satchel helped, and the labeller must judge
// the need without knowing what was shown.
const clipReply = raw => { const text = raw.replace(/▣\s?/g, ''); return text.length > 700 ? text.slice(0, 700) + ' [reply cut]' : text; };
// What the person typed, without the reminders the host wraps round it.
const REMINDER = /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>\s*/g;

const unlabelled = readdirSync(join(DIR, 'sessions')).map(f => readJson(join(DIR, 'sessions', f)))
  .filter(s => !labelled.has(s.session));
const sizes = [];
for (const s of unlabelled) {
  const lines = [`# Session ${s.session}`,
    `Repository: ${s.repository ?? 'none'}${s.repository ? `, linked to topics: ${linkedTo(s.repository).join(', ') || 'none'}` : ''}`,
    `Started: ${String(s.first).slice(0, 10)}${s.title ? `, titled "${s.title}"` : ''}`, ''];
  for (const e of s.events) {
    if (e.kind === 'prompt' && e.typed) lines.push(`[P${e.n}] ${e.text.replace(REMINDER, '').trim()}`);
    else if (e.kind === 'prompt') lines.push(`[host message: ${e.host}, not typed by the person]`);
    else if (e.kind === 'reply') lines.push(`  agent: ${clipReply(e.text)}`);
    else if (e.kind === 'start' && e.how === 'compact') lines.push('[the conversation was compacted here]');
    else if (e.kind === 'select') lines.push(`[the agent selected topic ${slugOf[e.topic_id] ?? e.topic_id}]`);
  }
  const text = lines.join('\n');
  writeFileSync(join(DIR, 'blind', `${s.session}.md`), text);
  sizes.push({session: s.session, prompts: s.prompts, chars: text.length});
}

const live = memories.filter(m => !m.ended_at && (!m.expires_at || m.expires_at > snapshot.taken_at));
const memoryList = ['# Every live memory', '', 'handle | scope | kind | band | statement',
  ...live.sort((a, b) => String(slugOf[a.topic_id] ?? '').localeCompare(String(slugOf[b.topic_id] ?? '')))
    .map(m => `${handleOf(m.id)} | ${slugOf[m.topic_id] ?? 'personal'} | ${m.kind} | ${m.band} | ${m.statement}`),
  '', '# Topics', '', 'slug | repositories | brief',
  ...topics.map(t => `${t.slug} | ${links.filter(l => l.topic_id === t.id).map(l => l.repository).join(', ') || 'none'} | ${t.brief}`)];
writeFileSync(join(DIR, 'blind', 'memories.md'), memoryList.join('\n'));

// Batches by size. One in ten sessions, chosen by its id so the choice is
// stable, is also put in a check batch for a second labeller.
const batches = [];
let current = null;
for (const s of sizes.sort((a, b) => b.chars - a.chars)) {
  if (!current || current.chars + s.chars > BATCH_CHARS) batches.push(current = {sessions: [], chars: 0});
  current.sessions.push(s.session); current.chars += s.chars;
}
const check = sizes.filter(s => parseInt(createHash('sha1').update(s.session).digest('hex').slice(0, 4), 16) % 10 === 0)
  .map(s => s.session);
const template = readFileSync(join(import.meta.dirname, '../references/blind-label.md'), 'utf8')
  .split('\n---\n')[1].trim();
// Date and time, so a second run on the same day cannot overwrite the first
// run's labels.
const stamp = snapshot.taken_at.slice(0, 16).replace(/[:]/g, '');
const write = (name, sessions) => {
  const out = join(DIR, 'gold', `${name}.json`);
  writeFileSync(join(DIR, 'blind', `prompt-${name}.txt`), template
    .replaceAll('{memories}', join(DIR, 'blind', 'memories.md'))
    .replaceAll('{files}', sessions.map(s => join(DIR, 'blind', `${s}.md`)).join('\n'))
    .replaceAll('{out}', out));
  return {name, sessions: sessions.length, out};
};
const prompts = batches.map((b, i) => write(`gold-${stamp}-${i + 1}`, b.sessions));
if (check.length) prompts.push(write(`check-${stamp}`, check));
writeJson(join(DIR, 'blind', 'INDEX.json'), {collected_at: snapshot.taken_at, prompts});

// ---- prompt vectors ------------------------------------------------------------

const cachePath = join(DIR, 'vectors', 'prompts.json');
const cache = readJson(cachePath, {});
const queries = [];
for (const f of readdirSync(join(DIR, 'sessions')))
  for (const e of readJson(join(DIR, 'sessions', f)).events)
    if (e.kind === 'prompt' && e.query && !cache[promptKey(e.query)]) queries.push(e.query);
const embedded = args.includes('--no-embed') ? 0 : await fill(cache, queries);
if (embedded) writeJson(cachePath, cache);

console.log(`snapshot: ${live.length} live memories of ${memories.length}, ${topics.length} topics, ${Object.keys(vectors).length} vectors`);
console.log(`sessions: ${collected} collected, ${skipped} already labelled, ${parsed.length - collected - skipped} with no typed prompt`);
console.log(`blind: ${prompts.length} prompt files (${check.length} sessions double labelled) in ${join(DIR, 'blind')}`);
console.log(`prompt vectors: ${embedded} embedded now, ${Object.keys(cache).length} cached`);
console.log(DIR);
