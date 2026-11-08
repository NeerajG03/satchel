// /api/integrations: connect and disconnect accounts, point a profile's slots
// at a plugin, add a suggestion the person said yes to, and read the week.
// The person's own, from the web app only.
import {createClient} from '@supabase/supabase-js';
import {randomBytes} from 'node:crypto';
import {verifyCompanionToken} from './agent-token.mjs';
import {personFor, readBody, send, idPattern} from './shelf.mjs';
import {publicOrigin} from './hook-handler.mjs';
import {GoogleError} from './google.mjs';
import {NotionError, listSources, sourceSchema} from './notion.mjs';
import {integrationsConfig, PROVIDERS, PLUGINS, SLOTS, sealTag, sealFor, openFor, withAccess, addToSlot, upcoming,
  connectionById as connection} from './integrations.mjs';

const PROFILES = new Set(['work', 'personal']);
const NAMES = {google: 'Google', notion: 'Notion'};
const isId = value => typeof value === 'string' && idPattern.test(value);
// One fixed address per provider, registered with it. A preview deployment's
// own host is never registered, so it can be set to production's here.
export const redirectUri = (req, provider) => process.env[PROVIDERS[provider].redirectEnv] || `${publicOrigin(req)}/settings/${provider}`;

export async function handleIntegrations(req, res, {config = integrationsConfig(), makeClient = createClient,
  verify = verifyCompanionToken, fetchImpl = fetch} = {}) {
  const db = await personFor(req, res, makeClient, verify);
  if (!db) return;
  let body;
  try { body = readBody(req.body); } catch { return send(res, 400, {error: 'Satchel could not read that request.'}); }
  if (!config) return send(res, 503, {error: body.action === 'upcoming'
    ? 'Connections are not set up on this server yet, so your week cannot be shown here.'
    : 'Connections are not set up on this server yet, so nothing was changed.'});
  const provider = typeof body.provider === 'string' && PROVIDERS[body.provider] ? body.provider : null;

  if (body.action === 'start') {
    if (!provider) return send(res, 400, {error: 'Pick Google or Notion first.'});
    if (!config[provider]) return send(res, 503, {error: `${NAMES[provider]} is not set up on this server yet, so nothing was connected.`});
    const state = randomBytes(24).toString('base64url');
    // The tab keeps the state and any verifier; a code that reaches anyone else cannot be used from another tab.
    const {url, verifier} = PROVIDERS[provider].start({config: config[provider], redirectUri: redirectUri(req, provider), state});
    return send(res, 200, {url, state, verifier, provider});
  }

  if (body.action === 'link') {
    if (!provider || !config[provider] || typeof body.code !== 'string' || body.code.length > 2000
      || (provider === 'google' && (typeof body.verifier !== 'string' || body.verifier.length > 200)))
      return send(res, 400, {error: 'Satchel could not read what came back. Try connecting again.'});
    let linked;
    try {
      linked = await PROVIDERS[provider].link({config: config[provider], code: body.code, verifier: body.verifier,
        redirectUri: redirectUri(req, provider), fetchImpl});
    } catch (error) {
      const why = error instanceof GoogleError && error.reason === 'missing_scope'
        ? 'Google did not give Satchel the calendar and to-do permissions. Connect again and leave every box ticked.'
        : `${NAMES[provider]} did not accept the connection, so nothing was saved. Try connecting again.`;
      return send(res, 400, {error: why});
    }
    const tag = sealTag(provider, linked.account);
    const {data: id, error} = await db.rpc('save_connection', {p_provider: provider, p_account: linked.account, p_label: linked.label,
      p_token_cipher: sealFor(config, db.ownerId, tag, linked.secret), p_seal_tag: tag, p_scopes: linked.scopes ?? '', p_meta: linked.meta ?? {}});
    if (error) return send(res, 502, {error: 'Satchel could not save the connection. Try again.'});
    return send(res, 200, {id, provider, label: linked.label});
  }

  if (body.action === 'unlink') {
    if (!isId(body.id)) return send(res, 400, {error: 'Satchel could not read that request.'});
    const {data: rows, error} = await db.rpc('remove_connection', {p_id: body.id});
    if (error) return send(res, 502, {error: 'Satchel could not disconnect it. Try again.'});
    const gone = rows?.[0];
    // Also withdrawn at Google, so the old permission is gone there too. Notion
    // has no revoke; its own Settings page lists Satchel until removed there.
    if (gone && PROVIDERS[gone.provider]?.revoke && config[gone.provider]) {
      try { await PROVIDERS[gone.provider].revoke(config[gone.provider], openFor(config, db.ownerId, gone.seal_tag, gone.token_cipher), fetchImpl); }
      catch { /* disconnected here either way */ }
    }
    return send(res, 200, {id: body.id, revoked: Boolean(gone && PROVIDERS[gone.provider]?.revoke)});
  }

  if (body.action === 'sources' || body.action === 'schema') {
    if (!isId(body.id) || (body.action === 'schema' && !isId(body.source))) return send(res, 400, {error: 'Satchel could not read that request.'});
    const account = await connection(db, body.id);
    if (account?.provider !== 'notion') return send(res, 404, {error: 'That Notion workspace is no longer connected. Reload Settings.'});
    try {
      const out = await withAccess(db, config, account, access => body.action === 'sources'
        ? listSources(access, {fetchImpl}) : sourceSchema(access, body.source, {fetchImpl}), {fetchImpl});
      return send(res, 200, body.action === 'sources' ? {sources: out} : out);
    } catch (error) {
      return send(res, error instanceof NotionError && error.status === 404 ? 404 : 502, {error: error instanceof NotionError && error.status === 404
        ? 'Notion would not show that database. Share it with Satchel in Notion, then reload.'
        : 'Notion did not answer just now. Reload to try again.'});
    }
  }

  if (body.action === 'set') {
    const profile = PROFILES.has(body.profile) ? body.profile : null;
    const slot = SLOTS.includes(body.slot) ? body.slot : null;
    if (!profile || !slot) return send(res, 400, {error: 'Satchel could not read that request.'});
    if (body.plugin == null) {
      const {error} = await db.rpc('set_destination', {p_profile: profile, p_slot: slot, p_plugin: null});
      return error ? send(res, 502, {error: 'Satchel could not change it. Try again.'}) : send(res, 200, {profile, slot, plugin: null});
    }
    const plugin = PLUGINS[body.plugin];
    const cannot = 'That place cannot hold this. Pick another.';
    if (!plugin || !plugin.slots.includes(slot) || !isId(body.connection)) return send(res, 400, {error: cannot});
    let settings = {};
    // A plugin with choices of its own reads the account to check them; the
    // database checks the account and its provider for every plugin.
    if (plugin.configure) {
      const account = await connection(db, body.connection);
      if (account?.provider !== plugin.provider) return send(res, 404, {error: 'That account is no longer connected. Reload Settings.'});
      try { settings = await withAccess(db, config, account, access => plugin.configure(access, body.settings ?? {}, {fetchImpl}), {fetchImpl}); }
      catch (error) {
        return send(res, 400, {error: error.reason === 'no_source' ? 'Pick a Notion database first.'
          : error.reason === 'no_title' ? 'That database has no title column, so Satchel cannot file anything in it.'
          : 'Notion would not show that database. Share it with Satchel in Notion, then try again.'});
      }
    }
    const {error} = await db.rpc('set_destination', {p_profile: profile, p_slot: slot, p_plugin: body.plugin,
      p_connection_id: body.connection, p_settings: settings});
    if (error) return send(res, error.hint === 'satchel:gone:connection' ? 404 : error.hint === 'satchel:invalid:plugin' ? 400 : 502,
      {error: error.hint === 'satchel:gone:connection' ? 'That account is no longer connected. Reload Settings.'
        : error.hint === 'satchel:invalid:plugin' ? cannot : 'Satchel could not save it. Try again.'});
    return send(res, 200, {profile, slot, plugin: body.plugin, settings});
  }

  if (body.action === 'upcoming') {
    try { return send(res, 200, await upcoming(db, config, {fetchImpl})); }
    catch { return send(res, 502, {error: 'Satchel could not read your week just now. Reload to try again.'}); }
  }

  if (body.action === 'add') {
    if (!isId(body.id)) return send(res, 400, {error: 'Satchel could not read that request.'});
    const profile = PROFILES.has(body.profile) ? body.profile : null;
    // The timezone is needed only at the end; asked for now so it costs no extra wait.
    const context = db.rpc('shelf_sort_context').then(r => r.data, () => null);
    const {data: rows, error} = await db.rpc('read_shelf_suggestion', {p_id: body.id});
    const found = rows?.[0];
    if (error || !found || found.status !== 'pending') return send(res, 404, {error: 'That suggestion is gone or was already decided. Reload the Shelf.'});
    const where = profile ?? found.profile;
    if (!where) return send(res, 400, {error: 'Pick Work or Personal for this one first.'});
    const slotName = `${where === 'work' ? 'Work' : 'Personal'} ${found.kind === 'todo' ? 'To-dos' : 'Calendar'}`;
    const {data: slots, error: slotError} = await db.rpc('destination_for', {p_profile: where, p_slot: found.kind});
    const slot = slots?.[0];
    if (slotError || !PLUGINS[slot?.plugin]) return send(res, 409, {error: `Pick where ${slotName} go in Settings first.`});
    // Claimed before the plugin is asked, so a second click or tab cannot make it twice.
    const {data: claimed, error: claimError} = await db.rpc('claim_shelf_suggestion', {p_id: found.id});
    const s = claimed?.[0];
    if (claimError || !s) return send(res, 409, {error: 'That one is already being added. Reload the Shelf.'});
    const timezone = (await context)?.timezone || 'UTC';
    let made;
    try { made = await addToSlot(db, config, s, slot, {timezone, fetchImpl}); }
    catch (error) {
      await db.rpc('release_shelf_suggestion', {p_id: s.id});
      if (error.reason === 'no_day') return send(res, 400, {error: 'A calendar needs a day. Add this one somewhere else, or dismiss it.'});
      const gone = !(error instanceof GoogleError || error instanceof NotionError) || error.reason === 'invalid_grant' || error.status === 401;
      return send(res, gone ? 409 : 502, {error: gone
        ? `The account behind ${slotName} no longer accepts Satchel. Connect it again in Settings.`
        : 'It was not taken this time, so nothing was added. Try again.'});
    }
    const {error: decideError} = await db.rpc('decide_shelf_suggestion', {p_id: s.id, p_status: 'added', p_profile: where,
      p_google_link: made.link});
    // The plugin has it now; a failure here only leaves the card showing it.
    // `kind` and `place` are what the phone says it was added to.
    return send(res, 200, {id: s.id, kind: made.plugin === 'google_tasks' ? 'task' : 'event', plugin: made.plugin, place: made.place,
      link: made.link, recorded: !decideError});
  }

  return send(res, 400, {error: 'Satchel could not read that request.'});
}
