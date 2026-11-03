// /api/google: link a Google account to a profile, add a suggestion the person
// said yes to, and unlink. The person's own, from the web app only.
import {createClient} from '@supabase/supabase-js';
import {randomBytes} from 'node:crypto';
import {verifyCompanionToken} from './agent-token.mjs';
import {personFor, readBody, send} from './shelf.mjs';
import {publicOrigin} from './hook-handler.mjs';
import {googleConfig, authUrl, exchangeCode, accessToken, addToGoogle, revoke, seal, open, GoogleError} from './google.mjs';

const PROFILES = new Set(['work', 'personal']);
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const redirectUri = req => `${publicOrigin(req)}/settings/google`;

export async function handleGoogle(req, res, {config = googleConfig(), makeClient = createClient,
  verify = verifyCompanionToken, fetchImpl = fetch} = {}) {
  const db = await personFor(req, res, makeClient, verify);
  if (!db) return;
  let body;
  try { body = readBody(req.body); } catch { return send(res, 400, {error: 'Satchel could not read that request.'}); }
  if (!config) return send(res, 503, {error: 'Google is not set up on this server yet, so nothing was linked.'});
  const profile = typeof body.profile === 'string' && PROFILES.has(body.profile) ? body.profile : null;

  if (body.action === 'start') {
    if (!profile) return send(res, 400, {error: 'Pick Work or Personal first.'});
    const state = randomBytes(24).toString('base64url');
    return send(res, 200, {url: authUrl({clientId: config.clientId, redirectUri: redirectUri(req), state}), state});
  }

  if (body.action === 'link') {
    if (!profile || typeof body.code !== 'string' || body.code.length > 2000)
      return send(res, 400, {error: 'Satchel could not read what Google sent back. Try linking again.'});
    let linked;
    try { linked = await exchangeCode({...config, code: body.code, redirectUri: redirectUri(req), fetchImpl}); }
    catch (error) {
      const why = error instanceof GoogleError && error.reason === 'missing_scope'
        ? 'Google did not give Satchel the calendar and to-do permissions. Link again and leave every box ticked.'
        : 'Google did not accept the link, so nothing was saved. Try linking again.';
      return send(res, 400, {error: why});
    }
    const {error} = await db.rpc('save_google_link', {p_profile: profile, p_email: linked.email,
      p_token_cipher: seal(linked.refreshToken, config.sealKey), p_scopes: linked.scopes});
    if (error) return send(res, 502, {error: 'Satchel could not save the link. Try again.'});
    return send(res, 200, {profile, email: linked.email});
  }

  if (body.action === 'unlink') {
    if (!profile) return send(res, 400, {error: 'Pick Work or Personal first.'});
    const {data: sealed, error} = await db.rpc('remove_google_link', {p_profile: profile});
    if (error) return send(res, 502, {error: 'Satchel could not unlink it. Try again.'});
    // Also withdrawn at Google, so the old permission is gone there too.
    if (sealed) await revoke({refreshToken: open(sealed, config.sealKey), fetchImpl}).catch(() => {});
    return send(res, 200, {profile});
  }

  if (body.action === 'add') {
    if (typeof body.id !== 'string' || !idPattern.test(body.id)) return send(res, 400, {error: 'Satchel could not read that request.'});
    const {data: rows, error} = await db.rpc('read_shelf_suggestion', {p_id: body.id});
    const s = rows?.[0];
    if (error || !s || s.status !== 'pending') return send(res, 404, {error: 'That suggestion is gone or was already decided. Reload the Shelf.'});
    const where = profile ?? s.profile;
    if (!where) return send(res, 400, {error: 'Pick Work or Personal for this one first.'});
    const {data: sealed} = await db.rpc('google_link_token', {p_profile: where});
    if (!sealed) return send(res, 409, {error: `Link a Google account to ${where === 'work' ? 'Work' : 'Personal'} in Settings first.`});
    const {data: context} = await db.rpc('shelf_sort_context');
    let made;
    try {
      const access = await accessToken({...config, refreshToken: open(sealed, config.sealKey), fetchImpl});
      made = await addToGoogle(access, s, {timezone: context?.timezone || 'UTC', fetchImpl});
    } catch (error) {
      const gone = error instanceof GoogleError && (error.reason === 'invalid_grant' || error.status === 401);
      return send(res, gone ? 409 : 502, {error: gone
        ? 'Google no longer accepts this link. Unlink and link the account again in Settings.'
        : 'Google did not take it this time, so nothing was added. Try again.'});
    }
    const {error: decideError} = await db.rpc('decide_shelf_suggestion', {p_id: s.id, p_status: 'added', p_profile: where,
      p_google_link: made.link});
    // Google has it now; a failure here only leaves the card showing it.
    return send(res, 200, {id: s.id, kind: made.kind, link: made.link, recorded: !decideError});
  }

  return send(res, 400, {error: 'Satchel could not read that request.'});
}
