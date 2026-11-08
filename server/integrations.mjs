// Integrations: each profile has a To-dos slot and a Calendar slot, and each
// slot uses one plugin on one connected account. A provider knows how to sign
// in; a plugin knows how to add to one place and, if it can, read the week.
import {googleConfig, authUrl, exchangeCode, accessToken, revoke, seal, open, pkce, bindingFor, addTask, addEvent,
  fetchEvents, fetchTasks, weekLines} from './google.mjs';
import {notionConfig, notionAuthUrl, notionExchange, notionRefresh, accessOf, addPage, sourceSchema, cleanSettings,
  NotionError} from './notion.mjs';
import {idPattern} from './shelf.mjs';

export const SLOTS = ['todo', 'event'];

/** Both providers share the server's one sealing key; either is off until its own keys are set. */
export function integrationsConfig(env = process.env) {
  const google = googleConfig(env);
  if (!google) return null;
  return {sealKey: google.sealKey, google, notion: notionConfig(env)};
}

export const PROVIDERS = {
  google: {
    redirectEnv: 'GOOGLE_REDIRECT_URI',
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
    redirectEnv: 'NOTION_REDIRECT_URI',
    // Notion takes no PKCE; the state still has to come back to the tab that started.
    start: ({config, redirectUri, state}) => ({url: notionAuthUrl({clientId: config.clientId, redirectUri, state}), verifier: null}),
    link: async ({config, code, redirectUri, fetchImpl}) => ({...await notionExchange(config, {code, redirectUri, fetchImpl}), scopes: ''}),
    access: async (config, secret) => accessOf(secret),
    refresh: (config, secret, fetchImpl) => notionRefresh(config, secret, {fetchImpl}),
  },
};

export const PLUGINS = {
  google_tasks: {provider: 'google', label: 'Google Tasks', slots: ['todo'],
    add: (access, s, ctx) => addTask(access, s, ctx),
    week: (access, ctx) => fetchTasks(access, ctx)},
  google_calendar: {provider: 'google', label: 'Google Calendar', slots: ['event', 'todo'],
    add: (access, s, ctx) => addEvent(access, s, ctx),
    week: (access, ctx) => fetchEvents(access, ctx)},
  notion_database: {provider: 'notion', label: 'Notion', slots: ['todo', 'event'],
    add: (access, s, ctx) => addPage(access, s, ctx.settings, {userId: ctx.meta?.user_id, timezone: ctx.timezone, fetchImpl: ctx.fetchImpl}),
    // Which database, and how its columns are filled, kept only where it fits the live database.
    configure: async (access, raw, {fetchImpl}) => {
      if (!idPattern.test(raw?.data_source_id ?? '')) throw new NotionError('No database picked', {reason: 'no_source'});
      return cleanSettings(await sourceSchema(access, raw.data_source_id, {fetchImpl}), raw);
    }},
};

/**
 * The cipher is bound to the owner and the connection's seal tag, so a token
 * copied into another person's row will not open. Rows moved from the old
 * Google links keep the profile they were sealed to as their tag.
 */
export const sealTag = (provider, account) => `${provider}:${account}`;
export const sealFor = (config, ownerId, tag, secret) => seal(secret, config.sealKey, bindingFor(ownerId, tag));
export const openFor = (config, ownerId, tag, sealed) => open(sealed, config.sealKey, bindingFor(ownerId, tag));

/** One connection's sealed token and what its plugins need, or null when it is gone. */
export async function connectionById(db, id) {
  const {data, error} = await db.rpc('connection_token', {p_id: id});
  return error || !data?.[0] ? null : {...data[0], connection_id: id};
}

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
    // The old pair is dead now, so this request goes ahead on the new one even
    // if saving it fails; the next request would then ask to connect again.
    try {
      await db.rpc('update_connection_token', {p_id: connection.connection_id,
        p_token_cipher: sealFor(config, db.ownerId, connection.seal_tag, next)});
    } catch { /* see above */ }
    return use(await provider.access(keys, next, fetchImpl));
  }
}

/** Adds one suggestion through a slot read with destination_for. */
export async function addToSlot(db, config, s, slot, {timezone = 'UTC', fetchImpl = fetch} = {}) {
  const plugin = PLUGINS[slot.plugin];
  const made = await withAccess(db, config, slot, access => plugin.add(access, s,
    {settings: slot.settings, meta: slot.meta, timezone, fetchImpl}), {fetchImpl});
  const place = slot.plugin === 'notion_database' ? slot.settings?.name || 'Notion' : PLUGINS[slot.plugin].label;
  return {plugin: slot.plugin, place, link: made.link};
}

/** Every slot that can read its week, read once per plugin and account, labelled by each profile that uses it. */
async function readWeeks(db, config, {now, fetchImpl}) {
  const {data: slots, error} = await db.rpc('list_destinations');
  if (error) throw error;
  const reads = new Map();
  for (const slot of slots ?? []) {
    if (!PLUGINS[slot.plugin]?.week) continue;
    const key = `${slot.plugin}|${slot.connection_id}`;
    reads.set(key, {...slot, profiles: [...new Set([...(reads.get(key)?.profiles ?? []), slot.profile])]});
  }
  // One access token per account, shared by its Calendar and Tasks reads.
  const tokens = new Map();
  const accessFor = id => {
    if (!tokens.has(id)) tokens.set(id, connectionById(db, id).then(connection => withAccess(db, config, connection, access => access, {fetchImpl})));
    return tokens.get(id);
  };
  const read = await Promise.all([...reads.values()].map(async slot => {
    try { return {slot, items: await PLUGINS[slot.plugin].week(await accessFor(slot.connection_id), {now, fetchImpl})}; }
    catch { return {slot, items: null}; }
  }));
  return read.flatMap(({slot, items}) => slot.profiles.map(profile => ({profile, items})));
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
