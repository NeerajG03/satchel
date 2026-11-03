// Google for a profile: linking an account, reading the week ahead, and adding
// what the person said yes to. Only the server ever sees a usable token: the
// refresh token is sealed with SATCHEL_GOOGLE_TOKEN_KEY before it is stored,
// and an access token lives for one request.
import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';

export const SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/tasks',
];
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const REVOKE = 'https://oauth2.googleapis.com/revoke';
const CALENDAR = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const TASKS = 'https://tasks.googleapis.com/tasks/v1/lists/@default/tasks';

export class GoogleError extends Error {
  constructor(message, {status, reason} = {}) { super(message); this.status = status; this.reason = reason; }
}

export function googleConfig(env = process.env) {
  const clientId = env.GOOGLE_CLIENT_ID, clientSecret = env.GOOGLE_CLIENT_SECRET, key = env.SATCHEL_GOOGLE_TOKEN_KEY;
  if (!clientId || !clientSecret || !key) return null;
  const sealKey = Buffer.from(key, 'base64');
  if (sealKey.length !== 32) return null;
  return {clientId, clientSecret, sealKey};
}

/** AES-256-GCM, as iv.tag.ciphertext in base64url. */
export function seal(text, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map(b => b.toString('base64url')).join('.');
}

export function open(sealed, key) {
  const [iv, tag, body] = sealed.split('.').map(p => Buffer.from(p, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

export function authUrl({clientId, redirectUri, state, loginHint}) {
  const url = new URL(AUTH);
  url.search = new URLSearchParams({client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
    scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
    ...(loginHint ? {login_hint: loginHint} : {})}).toString();
  return url.toString();
}

async function post(url, form, fetchImpl) {
  const response = await fetchImpl(url, {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams(form), signal: AbortSignal.timeout(10000)});
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new GoogleError(`Google answered ${response.status}`, {status: response.status, reason: body.error});
  return body;
}

/** The code Google sent back, for a refresh token and the account's email. */
export async function exchangeCode({clientId, clientSecret, code, redirectUri, fetchImpl = fetch}) {
  const body = await post(TOKEN, {code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri,
    grant_type: 'authorization_code'}, fetchImpl);
  if (!body.refresh_token) throw new GoogleError('Google sent no refresh token', {reason: 'no_refresh_token'});
  // Straight from Google's token endpoint over TLS, so the id token's claims
  // can be read without checking its signature again.
  const claims = JSON.parse(Buffer.from((body.id_token ?? '').split('.')[1] ?? '', 'base64url').toString('utf8') || '{}');
  if (!claims.email) throw new GoogleError('Google sent no email', {reason: 'no_email'});
  const granted = new Set((body.scope ?? '').split(' '));
  const missing = SCOPES.filter(s => s.startsWith('https://') && !granted.has(s));
  if (missing.length) throw new GoogleError('Not every permission was given', {reason: 'missing_scope'});
  return {refreshToken: body.refresh_token, email: claims.email, scopes: body.scope ?? ''};
}

export async function accessToken({clientId, clientSecret, refreshToken, fetchImpl = fetch}) {
  const body = await post(TOKEN, {refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret,
    grant_type: 'refresh_token'}, fetchImpl);
  return body.access_token;
}

export async function revoke({refreshToken, fetchImpl = fetch}) {
  await post(REVOKE, {token: refreshToken}, fetchImpl).catch(() => {});
}

async function call(url, access, {method = 'GET', body, fetchImpl = fetch} = {}) {
  const response = await fetchImpl(url, {method, headers: {authorization: `Bearer ${access}`,
    ...(body ? {'content-type': 'application/json'} : {})}, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000)});
  const out = await response.json().catch(() => ({}));
  if (!response.ok) throw new GoogleError(`Google answered ${response.status}`, {status: response.status, reason: out.error?.status});
  return out;
}

const nextDay = date => new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

/** What a suggestion becomes in Google: a task, or an event (all day when it has no time). */
export function googleBody(s, {timezone = 'UTC', from = 'From your Satchel Shelf'} = {}) {
  const note = `${from}: “${s.source}”`;
  if (s.kind === 'todo') {
    const day = s.due_date ?? (s.starts_at ? new Intl.DateTimeFormat('en-CA', {timeZone: timezone}).format(new Date(s.starts_at)) : null);
    // Google Tasks keeps only the date of a due time, so a time goes in the notes.
    const time = s.starts_at ? new Intl.DateTimeFormat('en-GB', {timeZone: timezone, hour: '2-digit', minute: '2-digit',
      hourCycle: 'h23'}).format(new Date(s.starts_at)) : null;
    return {kind: 'task', body: {title: s.title, notes: time ? `At ${time}. ${note}` : note,
      ...(day ? {due: `${day}T00:00:00.000Z`} : {})}};
  }
  if (s.starts_at) return {kind: 'event', body: {summary: s.title, description: note,
    start: {dateTime: s.starts_at, timeZone: timezone}, end: {dateTime: s.ends_at ?? s.starts_at, timeZone: timezone}}};
  return {kind: 'event', body: {summary: s.title, description: note, start: {date: s.due_date}, end: {date: nextDay(s.due_date)}}};
}

export async function addToGoogle(access, suggestion, {timezone, fetchImpl = fetch} = {}) {
  const {kind, body} = googleBody(suggestion, {timezone});
  const made = await call(kind === 'task' ? TASKS : CALENDAR, access, {method: 'POST', body, fetchImpl});
  return {kind, link: made.htmlLink ?? made.webViewLink ?? (kind === 'task' ? 'https://tasks.google.com/' : 'https://calendar.google.com/')};
}

/** The week ahead as lines the sorting call can read: events, then open tasks. */
export async function weekAhead(access, {timezone = 'UTC', now = new Date(), fetchImpl = fetch} = {}) {
  const events = new URL(CALENDAR);
  events.search = new URLSearchParams({timeMin: now.toISOString(), timeMax: new Date(now.getTime() + 7 * 86400000).toISOString(),
    singleEvents: 'true', orderBy: 'startTime', maxResults: '30'}).toString();
  const tasks = new URL(TASKS);
  tasks.search = new URLSearchParams({showCompleted: 'false', maxResults: '20'}).toString();
  const [e, t] = await Promise.all([call(events, access, {fetchImpl}), call(tasks, access, {fetchImpl})]);
  const when = item => item.start?.dateTime
    ? new Intl.DateTimeFormat('en-GB', {timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit',
      minute: '2-digit', hourCycle: 'h23'}).format(new Date(item.start.dateTime))
    : item.start?.date ?? '';
  return [
    ...(e.items ?? []).map(i => `  event: ${when(i)} ${i.summary ?? '(no title)'}`),
    ...(t.items ?? []).map(i => `  open task: ${i.title}${i.due ? ` (due ${i.due.slice(0, 10)})` : ''}`),
  ];
}

/** Every linked profile's week ahead, labelled, or null when none is linked. */
export async function calendarContext(db, config, timezone, {fetchImpl = fetch, now = new Date()} = {}) {
  const {data: links} = await db.rpc('google_link_status');
  const parts = await Promise.all((links ?? []).map(async link => {
    const {data: sealed} = await db.rpc('google_link_token', {p_profile: link.profile});
    const access = await accessToken({...config, refreshToken: open(sealed, config.sealKey), fetchImpl});
    const lines = await weekAhead(access, {timezone, now, fetchImpl});
    return lines.length ? [`${link.profile}:`, ...lines].join('\n') : null;
  }).map(p => p.catch(() => null)));
  return parts.filter(Boolean).join('\n') || null;
}
