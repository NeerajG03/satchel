// Google for a profile: linking an account, reading the week ahead, and adding
// what the person said yes to. Only the server ever sees a usable token: the
// refresh token is sealed with SATCHEL_GOOGLE_TOKEN_KEY before it is stored,
// and an access token lives for one request.
import {createCipheriv, createDecipheriv, createHash, randomBytes} from 'node:crypto';

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

/**
 * AES-256-GCM, as iv.tag.ciphertext in base64url. `bound` (the owner and the
 * profile) is authenticated with it, so a sealed token copied into another
 * person's row, or onto the other profile, will not open.
 */
export const bindingFor = (ownerId, profile) => `${ownerId}|${profile}`;

export function seal(text, key, bound) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(bound, 'utf8'));
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map(b => b.toString('base64url')).join('.');
}

export function open(sealed, key, bound) {
  const [iv, tag, body] = sealed.split('.').map(p => Buffer.from(p, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(bound, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/** A PKCE pair: the verifier stays with the tab that started, the challenge goes to Google. */
export function pkce() {
  const verifier = randomBytes(48).toString('base64url');
  return {verifier, challenge: createHash('sha256').update(verifier).digest('base64url')};
}

export function authUrl({clientId, redirectUri, state, challenge}) {
  const url = new URL(AUTH);
  url.search = new URLSearchParams({client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
    scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
    code_challenge: challenge, code_challenge_method: 'S256'}).toString();
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
export async function exchangeCode({clientId, clientSecret, code, verifier, redirectUri, fetchImpl = fetch}) {
  const body = await post(TOKEN, {code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri,
    grant_type: 'authorization_code', code_verifier: verifier}, fetchImpl);
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

const note = s => `From your Satchel Shelf: “${s.source}”`;
const dayIn = (at, timezone) => new Intl.DateTimeFormat('en-CA', {timeZone: timezone}).format(new Date(at));

/** A to-do as a Google task. Tasks keeps only the date of a due time, so a time goes in the notes. */
export function taskBody(s, {timezone = 'UTC'} = {}) {
  const day = s.due_date ?? (s.starts_at ? dayIn(s.starts_at, timezone) : null);
  const time = s.starts_at ? new Intl.DateTimeFormat('en-GB', {timeZone: timezone, hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23'}).format(new Date(s.starts_at)) : null;
  return {title: s.title, notes: time ? `At ${time}. ${note(s)}` : note(s), ...(day ? {due: `${day}T00:00:00.000Z`} : {})};
}

/** An event, or a to-do put on a calendar: timed when it has a time, all day when it has only a day. */
export function eventBody(s, {timezone = 'UTC'} = {}) {
  if (s.starts_at) return {summary: s.title, description: note(s),
    start: {dateTime: s.starts_at, timeZone: timezone}, end: {dateTime: s.ends_at ?? s.starts_at, timeZone: timezone}};
  if (!s.due_date) throw new GoogleError('A calendar needs a day', {reason: 'no_day'});
  return {summary: s.title, description: note(s), start: {date: s.due_date}, end: {date: nextDay(s.due_date)}};
}

export async function addTask(access, s, {timezone, fetchImpl = fetch} = {}) {
  const made = await call(TASKS, access, {method: 'POST', body: taskBody(s, {timezone}), fetchImpl});
  return {link: made.webViewLink ?? 'https://tasks.google.com/'};
}

export async function addEvent(access, s, {timezone, fetchImpl = fetch} = {}) {
  const made = await call(CALENDAR, access, {method: 'POST', body: eventBody(s, {timezone}), fetchImpl});
  return {link: made.htmlLink ?? 'https://calendar.google.com/'};
}

// Titles can be written by anyone who sends an invite, so each is one short
// line: it can never pose as another part of the prompt or the page.
const oneLine = text => (text ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim().slice(0, 120) || '(no title)';

/** The next seven days of one calendar, by start time. */
export async function fetchEvents(access, {now = new Date(), fetchImpl = fetch} = {}) {
  const url = new URL(CALENDAR);
  url.search = new URLSearchParams({timeMin: now.toISOString(), timeMax: new Date(now.getTime() + 7 * 86400000).toISOString(),
    singleEvents: 'true', orderBy: 'startTime', maxResults: '30'}).toString();
  return ((await call(url, access, {fetchImpl})).items ?? []).map(i => ({kind: 'event', title: oneLine(i.summary),
    at: i.start?.dateTime ?? null, day: i.start?.date ?? null, link: i.htmlLink ?? null}));
}

/** Open tasks in the default list. */
export async function fetchTasks(access, {fetchImpl = fetch} = {}) {
  const url = new URL(TASKS);
  url.search = new URLSearchParams({showCompleted: 'false', maxResults: '20'}).toString();
  return ((await call(url, access, {fetchImpl})).items ?? []).map(i => ({kind: 'task', title: oneLine(i.title), at: null,
    day: i.due ? i.due.slice(0, 10) : null, link: i.webViewLink ?? null}));
}

/** Items as lines the sorting call can read. */
export function weekLines(items, {timezone = 'UTC'} = {}) {
  const when = item => item.at
    ? new Intl.DateTimeFormat('en-GB', {timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit',
      minute: '2-digit', hourCycle: 'h23'}).format(new Date(item.at))
    : item.day ?? '';
  return items.map(i => i.kind === 'event'
    ? `  event: ${when(i)} ${i.title}`
    : `  open task: ${i.title}${i.day ? ` (due ${i.day})` : ''}`);
}
