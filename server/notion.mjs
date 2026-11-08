// Notion for a profile: signing in to a workspace, picking a database the
// person shared, and filing a to-do or event in it as a page, with its columns
// filled the way the person set once. Only the server sees a usable token.

const API = 'https://api.notion.com/v1';
const VERSION = '2026-03-11';

export class NotionError extends Error {
  constructor(message, {status, reason} = {}) { super(message); this.status = status; this.reason = reason; }
}

export function notionConfig(env = process.env) {
  const clientId = env.NOTION_CLIENT_ID, clientSecret = env.NOTION_CLIENT_SECRET;
  return clientId && clientSecret ? {clientId, clientSecret} : null;
}

/** Notion's own consent screen, where the person also picks the pages and databases Satchel may use. */
export function notionAuthUrl({clientId, redirectUri, state}) {
  const url = new URL(`${API}/oauth/authorize`);
  url.search = new URLSearchParams({client_id: clientId, redirect_uri: redirectUri, response_type: 'code', owner: 'user', state}).toString();
  return url.toString();
}

async function tokenCall({clientId, clientSecret}, body, fetchImpl) {
  const response = await fetchImpl(`${API}/oauth/token`, {method: 'POST', headers: {'content-type': 'application/json',
    authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, 'notion-version': VERSION},
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000)});
  const out = await response.json().catch(() => ({}));
  if (!response.ok || !out.access_token) throw new NotionError(`Notion answered ${response.status}`, {status: response.status, reason: out.error});
  return out;
}

// What is sealed: both tokens, because every refresh hands out a new pair.
const secretOf = out => JSON.stringify({access: out.access_token, refresh: out.refresh_token ?? null});
export const accessOf = secret => JSON.parse(secret).access;

/** The code Notion sent back, for the token pair, the workspace and who connected it. */
export async function notionExchange(config, {code, redirectUri, fetchImpl = fetch}) {
  const out = await tokenCall(config, {grant_type: 'authorization_code', code, redirect_uri: redirectUri}, fetchImpl);
  if (!out.workspace_id) throw new NotionError('Notion sent no workspace', {reason: 'no_workspace'});
  const person = out.owner?.user ?? {};
  return {account: out.workspace_id, label: (out.workspace_name || 'Notion').slice(0, 200), secret: secretOf(out),
    meta: {user_id: person.id ?? null, user_name: person.name ?? null}};
}

/** A new pair for the old one. The old refresh token stops working once this answers. */
export async function notionRefresh(config, secret, {fetchImpl = fetch} = {}) {
  const {refresh} = JSON.parse(secret);
  if (!refresh) throw new NotionError('Nothing to refresh with', {status: 401, reason: 'no_refresh_token'});
  return secretOf(await tokenCall(config, {grant_type: 'refresh_token', refresh_token: refresh}, fetchImpl));
}

async function call(path, access, {method = 'GET', body, fetchImpl = fetch} = {}) {
  const response = await fetchImpl(`${API}${path}`, {method, headers: {authorization: `Bearer ${access}`, 'notion-version': VERSION,
    ...(body ? {'content-type': 'application/json'} : {})}, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000)});
  const out = await response.json().catch(() => ({}));
  if (!response.ok) throw new NotionError(`Notion answered ${response.status}`, {status: response.status, reason: out.code});
  return out;
}

const plain = rich => (rich ?? []).map(r => r.plain_text ?? r.text?.content ?? '').join('').trim();

/** The databases this workspace shared with Satchel, by name. */
export async function listSources(access, {fetchImpl = fetch} = {}) {
  const out = await call('/search', access, {method: 'POST', fetchImpl,
    body: {filter: {property: 'object', value: 'data_source'}, page_size: 100}});
  return (out.results ?? []).filter(r => r.object === 'data_source' && !r.in_trash)
    .map(r => ({id: r.id, name: (plain(r.title) || 'Untitled').slice(0, 120)}));
}

// The columns Satchel knows how to fill. Anything else is left for Notion's own default.
const FILLABLE = new Set(['title', 'date', 'select', 'status', 'multi_select', 'people', 'checkbox', 'rich_text']);

/** One database's columns that Satchel can fill, with the choices each allows. */
export async function sourceSchema(access, id, {fetchImpl = fetch} = {}) {
  const out = await call(`/data_sources/${encodeURIComponent(id)}`, access, {fetchImpl});
  const columns = Object.values(out.properties ?? {}).filter(p => FILLABLE.has(p.type)).map(p => ({
    name: p.name, type: p.type,
    ...(['select', 'status', 'multi_select'].includes(p.type) ? {options: (p[p.type]?.options ?? []).map(o => o.name)} : {}),
  }));
  return {id, name: (plain(out.title) || 'Untitled').slice(0, 120), columns};
}

const text = value => typeof value === 'string' ? value.trim().slice(0, 2000) : '';

/**
 * What the person asked for, kept only where it fits the live database: a
 * column that exists, of the type it claims, with a choice it offers. A name
 * that does not fit is dropped rather than letting Notion refuse every add.
 */
export function cleanSettings(schema, input = {}) {
  const byName = new Map(schema.columns.map(c => [c.name, c]));
  const title = schema.columns.find(c => c.type === 'title');
  if (!title) throw new NotionError('That database has no title column', {reason: 'no_title'});
  const date = byName.get(input.date)?.type === 'date' ? input.date : null;
  const defaults = {};
  for (const [name, raw] of Object.entries(input.defaults ?? {}).slice(0, 30)) {
    const column = byName.get(name);
    if (!column || column.type === 'title' || name === date) continue;
    const value = raw?.value;
    if (['select', 'status'].includes(column.type) && column.options.includes(value)) defaults[name] = {type: column.type, value};
    else if (column.type === 'multi_select' && Array.isArray(value)) {
      const picked = value.filter(v => column.options.includes(v)).slice(0, 20);
      if (picked.length) defaults[name] = {type: column.type, value: picked};
    } else if (column.type === 'people' && value === 'me') defaults[name] = {type: 'people', value: 'me'};
    else if (column.type === 'checkbox' && typeof value === 'boolean') defaults[name] = {type: 'checkbox', value};
    else if (column.type === 'rich_text' && text(value)) defaults[name] = {type: 'rich_text', value: text(value)};
  }
  return {data_source_id: schema.id, name: schema.name, title: title.name, date, defaults};
}

const rich = content => [{text: {content: content.slice(0, 2000)}}];

/** A to-do or event as a Notion page in the chosen database. The title goes only in the title column. */
export function pageBody(s, settings, {userId = null, timezone = 'UTC'} = {}) {
  const properties = {[settings.title]: {title: rich(s.title)}};
  if (settings.date && (s.starts_at || s.due_date)) properties[settings.date] = {date: s.starts_at
    ? {start: s.starts_at, end: s.ends_at ?? null, time_zone: null}
    : {start: s.due_date, end: null}};
  for (const [name, {type, value}] of Object.entries(settings.defaults ?? {})) {
    if (type === 'select' || type === 'status') properties[name] = {[type]: {name: value}};
    else if (type === 'multi_select') properties[name] = {multi_select: value.map(v => ({name: v}))};
    else if (type === 'people' && userId) properties[name] = {people: [{object: 'user', id: userId}]};
    else if (type === 'checkbox') properties[name] = {checkbox: value};
    else if (type === 'rich_text') properties[name] = {rich_text: rich(value)};
  }
  // With no date column, the day still reaches the page, in its body.
  const when = !settings.date && (s.starts_at || s.due_date)
    ? `When: ${s.starts_at ? new Intl.DateTimeFormat('en-GB', {timeZone: timezone, dateStyle: 'medium', timeStyle: 'short'}).format(new Date(s.starts_at)) : s.due_date}\n\n`
    : '';
  return {parent: {type: 'data_source_id', data_source_id: settings.data_source_id}, properties,
    markdown: `${when}From your Satchel Shelf: “${s.source.replace(/[\r\n]+/g, ' ')}”`, markdown_version: 'v2'};
}

export async function addPage(access, s, settings, {userId, timezone, fetchImpl = fetch} = {}) {
  const made = await call('/pages', access, {method: 'POST', body: pageBody(s, settings, {userId, timezone}), fetchImpl});
  return {link: made.url ?? 'https://www.notion.so/'};
}
