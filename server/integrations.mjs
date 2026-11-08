// Integrations: each profile has a To-dos slot and a Calendar slot, and each
// slot uses one plugin on one connected account. A provider knows how to sign
// in; a plugin knows how to add to one place and, if it can, read the week.
import {googleConfig, authUrl, exchangeCode, accessToken, revoke, seal, open, pkce, addTask, addEvent,
  fetchEvents, fetchTasks, weekLines} from './google.mjs';
import {notionConfig, notionAuthUrl, notionExchange, notionRefresh, accessOf, addPage} from './notion.mjs';

export const SLOTS = ['todo', 'event'];

/** Both providers share the server's one sealing key; either is off until its own keys are set. */
export function integrationsConfig(env = process.env) {
  const google = googleConfig(env);
  if (!google) return null;
  return {sealKey: google.sealKey, google, notion: notionConfig(env)};
}

export const PROVIDERS = {
  google: {
    start: ({config, redirectUri, state}) => {
      const {verifier, challenge} = pkce();
      return {url: authUrl({clientId: config.clientId, redirectUri, state, challenge}), verifier};
    },
    link: async ({config, code, verifier, redirectUri, fetchImpl}) => {
      const out = await exchangeCode({...config, code, verifier, redirectUri, fetchImpl});
      return {account: out.email, label: out.email, secret: out.refreshToken, scopes: out.scopes, meta: {}};
    },
    // The sealed secret is a refresh token; each use asks Google for an access token that lives one request.
    access: (config, secret, fetchImpl) => accessToken({...config, refreshToken: secret, fetchImpl}),
    revoke: (config, secret, fetchImpl) => revoke({refreshToken: secret, fetchImpl}),
  },
  notion: {
    // Notion takes no PKCE; the state still has to come back to the tab that started.
    start: ({config, redirectUri, state}) => ({url: notionAuthUrl({clientId: config.clientId, redirectUri, state}), verifier: null}),
    link: async ({config, code, redirectUri, fetchImpl}) => ({...await notionExchange(config, {code, redirectUri, fetchImpl}), scopes: ''}),
    access: async (config, secret) => accessOf(secret),
    refresh: (config, secret, fetchImpl) => notionRefresh(config, secret, {fetchImpl}),
  },
};

export const PLUGINS = {
  google_tasks: {provider: 'google', slots: ['todo'],
    add: (access, s, ctx) => addTask(access, s, ctx),
    week: (access, ctx) => fetchTasks(access, ctx)},
  google_calendar: {provider: 'google', slots: ['event', 'todo'],
    add: (access, s, ctx) => addEvent(access, s, ctx),
    week: (access, ctx) => fetchEvents(access, ctx)},
  notion_database: {provider: 'notion', slots: ['todo', 'event'],
    add: (access, s, ctx) => addPage(access, s, ctx.settings, {userId: ctx.meta?.user_id, timezone: ctx.timezone, fetchImpl: ctx.fetchImpl})},
};

/**
 * The cipher is bound to the owner and the connection's seal tag, so a token
 * copied into another person's row will not open. Rows moved from the old
 * Google links keep the profile they were sealed to as their tag.
 */
export const sealTag = (provider, account) => `${provider}:${account}`;
const binding = (ownerId, tag) => `${ownerId}|${tag}`;
export const sealFor = (config, ownerId, tag, secret) => seal(secret, config.sealKey, binding(ownerId, tag));
export const openFor = (config, ownerId, tag, sealed) => open(sealed, config.sealKey, binding(ownerId, tag));

/**
 * Runs `use` with an access token for one connection. When the provider says
 * the token has expired and it can refresh, it refreshes once, saves the new
 * pair sealed, and tries again.
 */
export async function withAccess(db, config, connection, use, {fetchImpl = fetch} = {}) {
  const provider = PROVIDERS[connection.provider];
  const keys = config[connection.provider];
  if (!provider || !keys) throw Object.assign(new Error('That provider is not set up here'), {reason: 'not_set_up'});
  const secret = openFor(config, db.ownerId, connection.seal_tag, connection.token_cipher);
  try { return await use(await provider.access(keys, secret, fetchImpl)); }
  catch (error) {
    if (error.status !== 401 || !provider.refresh) throw error;
    const next = await provider.refresh(keys, secret, fetchImpl);
    const {error: saveError} = await db.rpc('update_connection_token', {p_id: connection.connection_id ?? connection.id,
      p_token_cipher: sealFor(config, db.ownerId, connection.seal_tag, next)});
    if (saveError) throw saveError;
    return use(await provider.access(keys, next, fetchImpl));
  }
}

/** Adds one suggestion to its profile's slot. Throws `gone` when the slot is empty. */
export async function addToSlot(db, config, s, profile, {timezone = 'UTC', fetchImpl = fetch} = {}) {
  const {data: rows, error} = await db.rpc('destination_for', {p_profile: profile, p_slot: s.kind});
  if (error) throw Object.assign(new Error('No slot'), {reason: error.hint === 'satchel:gone:destination' ? 'no_slot' : 'db'});
  const slot = rows?.[0];
  const plugin = PLUGINS[slot?.plugin];
  if (!plugin) throw Object.assign(new Error('No slot'), {reason: 'no_slot'});
  const made = await withAccess(db, config, slot, access => plugin.add(access, s,
    {settings: slot.settings, meta: slot.meta, timezone, fetchImpl}), {fetchImpl});
  return {plugin: slot.plugin, link: made.link};
}

/** Every slot that can read its week, read once per plugin and account, labelled by profile. */
async function readWeeks(db, config, {now, fetchImpl}) {
  const {data: slots, error} = await db.rpc('list_destinations');
  if (error) throw error;
  const seen = new Map();
  for (const slot of slots ?? []) {
    if (!PLUGINS[slot.plugin]?.week) continue;
    const key = `${slot.plugin}|${slot.connection_id}|${slot.profile}`;
    if (!seen.has(key)) seen.set(key, slot);
  }
  return Promise.all([...seen.values()].map(async slot => {
    try {
      const {data: tokens} = await db.rpc('connection_token', {p_id: slot.connection_id});
      const items = await withAccess(db, config, {...tokens[0], connection_id: slot.connection_id},
        access => PLUGINS[slot.plugin].week(access, {now, fetchImpl}), {fetchImpl});
      return {profile: slot.profile, items};
    } catch { return {profile: slot.profile, items: null}; }
  }));
}

/**
 * What is coming up across every profile, for the Shelf page. A profile where
 * a calendar or list would not answer is named, so the page can say so.
 */
export async function upcoming(db, config, {fetchImpl = fetch, now = new Date()} = {}) {
  const weeks = await readWeeks(db, config, {now, fetchImpl});
  const end = now.getTime() + 7 * 86400000;
  // Google keeps a task's due day as midnight UTC; a day's grace keeps today's in every zone.
  const start = now.getTime() - 86400000;
  const due = i => Date.parse(`${i.day}T00:00:00Z`);
  const items = weeks.flatMap(w => (w.items ?? [])
    .filter(i => i.kind === 'event' || (i.day && due(i) <= end && due(i) >= start))
    .map(i => ({...i, profile: w.profile})));
  // Calendars give times in their own offsets, so compare instants, not strings.
  const key = i => Date.parse(i.at ?? `${i.day}T00:00:00Z`);
  const failed = [...new Set(weeks.filter(w => !w.items).map(w => w.profile))];
  const linked = [...new Set(weeks.map(w => w.profile))];
  return {items: items.sort((a, b) => key(a) - key(b)), failed, linked};
}

/** Every profile's week ahead, labelled, for the sorting call, or null when there is none. */
export async function calendarContext(db, config, timezone, {fetchImpl = fetch, now = new Date()} = {}) {
  const weeks = await readWeeks(db, config, {now, fetchImpl}).catch(() => []);
  const byProfile = new Map();
  for (const w of weeks) if (w.items?.length) byProfile.set(w.profile, [...(byProfile.get(w.profile) ?? []), ...w.items]);
  return [...byProfile].map(([profile, items]) => [`${profile}:`, ...weekLines(items, {timezone})].join('\n')).join('\n') || null;
}
