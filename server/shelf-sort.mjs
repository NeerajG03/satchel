// Sorting a Shelf item: its profile and topic, and the to-dos and events it
// mentions. The model proposes; this file decides what survives. Every
// suggestion must quote words that are really in the capture, and dates and
// times are worked out here from the person's timezone, not trusted as text.
import {z} from 'zod';
import {generateText} from 'ai';
import {askModel} from './consolidator.mjs';
import {providerFor, asBaseUrl} from './model-provider.mjs';
import {storedPrompt, SHELF_SORT_PROMPT} from './prompt-store.mjs';

export const SORT_SCHEMA = z.object({
  profile: z.enum(['work', 'personal']).nullable(),
  topic: z.number().int().nullable(),
  suggestions: z.array(z.object({
    kind: z.enum(['todo', 'event']),
    title: z.string(),
    date: z.string().nullable(),
    time: z.string().nullable(),
    end_time: z.string().nullable(),
    profile: z.enum(['work', 'personal']).nullable(),
    words: z.string(),
  })).max(10),
});

const TRANSCRIBE = 'Write down exactly what is said in this voice note, word for word, in the language it is spoken. No summary, no labels, no commentary. If nothing is said, reply with nothing.';

/** The capture time as the person would read it: weekday, date and clock in their zone. */
export function localNow(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {timeZone: timezone, weekday: 'long', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(now);
  const get = type => parts.find(p => p.type === type)?.value;
  return `${get('weekday')} ${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} (${timezone})`;
}

/** A wall-clock date and time in a zone, as the instant it names. */
export function zonedInstant(date, time, timezone) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = instant => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone: timezone, hourCycle: 'h23', year: 'numeric',
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'}).formatToParts(new Date(instant))
      .map(x => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - instant;
  };
  // Twice, so a guess on the far side of a daylight-saving change settles.
  let instant = guess - offsetAt(guess);
  instant = guess - offsetAt(instant);
  return new Date(instant);
}

export function buildSortPrompt({item, topics = [], timezone, now = new Date(), calendar = null}) {
  const lines = [`captured: ${localNow(now, timezone)}`, ''];
  lines.push('topics');
  if (!topics.length) lines.push('  (none)');
  topics.forEach((t, i) => lines.push(`  ${i + 1}. ${t.name}${t.profile ? ` [${t.profile}]` : ''}${t.brief ? `: ${t.brief.slice(0, 160)}` : ''}`));
  if (calendar) lines.push('', 'calendar and open tasks', calendar);
  lines.push('', `the capture (${item.kind})`);
  if (item.note) lines.push(`what they typed: ${item.note}`);
  if (item.transcript) lines.push(`what they said: ${item.transcript}`);
  if (item.description) lines.push(`what Satchel saw in it: ${item.description}`);
  return lines.join('\n');
}

const squash = text => (text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** What the model proposed, cut down to what is grounded and well formed. */
export function settle(proposal, {item, topics = [], timezone}) {
  const haystack = squash([item.note, item.transcript, item.description].filter(Boolean).join(' '));
  const topic = Number.isInteger(proposal.topic) ? topics[proposal.topic - 1] ?? null : null;
  const suggestions = [];
  for (const s of proposal.suggestions ?? []) {
    const words = squash(s.words);
    if (words.length < 3 || !haystack.includes(words)) continue;
    const title = (s.title ?? '').trim().slice(0, 300);
    if (!title) continue;
    const date = DATE.test(s.date ?? '') && !Number.isNaN(Date.parse(s.date)) ? s.date : null;
    const time = date && TIME.test(s.time ?? '') ? s.time : null;
    if (s.kind === 'event' && !date) continue;
    const out = {kind: s.kind, title, source: s.words.trim().slice(0, 1000), profile: s.profile ?? null,
      due_date: null, starts_at: null, ends_at: null};
    if (time) {
      const start = zonedInstant(date, time, timezone);
      out.starts_at = start.toISOString();
      if (s.kind === 'event') {
        const end = TIME.test(s.end_time ?? '') ? zonedInstant(date, s.end_time, timezone) : null;
        out.ends_at = (end && end > start ? end : new Date(start.getTime() + 30 * 60 * 1000)).toISOString();
      }
    } else out.due_date = date;
    suggestions.push(out);
  }
  return {profile: proposal.profile ?? null, topic_id: topic?.id ?? null, suggestions};
}

export function createSorter({
  model = process.env.SATCHEL_SHELF_MODEL ?? 'gemini-3.8-flash',
  provider = process.env.SATCHEL_ROUTER_PROVIDER ?? 'google',
  baseURL = asBaseUrl(process.env.SATCHEL_ROUTER_URL),
  apiKey = process.env.SATCHEL_ROUTER_KEY ?? process.env.GEMINI_API_KEY,
  timeoutMs = Number(process.env.SATCHEL_SHELF_TIMEOUT_MS ?? 45000),
  promptResolver = () => storedPrompt(SHELF_SORT_PROMPT),
  fetchImpl = fetch,
  ask = askModel,
} = {}) {
  if (!apiKey) return null;
  return {
    model,
    /** The words of a voice note, as said. Null when nothing was said. */
    async transcribe({bytes, mimeType}) {
      const {text} = await generateText({
        model: providerFor({provider, apiKey, baseURL, fetchImpl}).languageModel(model), temperature: 0, maxRetries: 1,
        abortSignal: AbortSignal.timeout(timeoutMs),
        messages: [{role: 'user', content: [{type: 'file', data: bytes, mediaType: mimeType}, {type: 'text', text: TRANSCRIBE}]}],
        telemetry: {functionId: 'shelf-transcribe'},
      });
      return text.trim().slice(0, 8000) || null;
    },
    async sort({item, topics, timezone, now, calendar}) {
      const {text: system} = await promptResolver();
      const prompt = buildSortPrompt({item, topics, timezone, now, calendar});
      const {object} = await ask({provider, apiKey, baseURL, fetchImpl, model, schema: SORT_SCHEMA, system, prompt,
        signal: AbortSignal.timeout(timeoutMs), functionId: 'shelf-sort'});
      return settle(object, {item, topics, timezone});
    },
  };
}
