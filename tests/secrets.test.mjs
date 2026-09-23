// What the secret scanner takes out, and what it leaves alone.
//
// Every fake credential here is assembled at run time rather than written out.
// A literal that looks like a GitHub or Stripe key is exactly what push
// protection exists to stop, and a test file is not a reason to teach it
// exceptions.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {redact, scrub, looksRandom} from '../server/secrets.mjs';

const join = (...parts) => parts.join('');
// Deterministic, so a value that passes once passes always, and random
// enough to look like the real thing.
const random = (length, seed = 7) => {
  let out = '';
  for (let n = 0; out.length < length; n++)
    out += createHash('sha256').update(`${seed}:${n}`).digest('base64').replace(/[^A-Za-z0-9]/g, '');
  return out.slice(0, length);
};

test('a connection string keeps its user and host and loses the password', () => {
  // The shape that leaked on 22 September: pasted to ask about the cluster,
  // so the host is the useful part and the password is the dangerous one.
  const url = join('mongodb', '+srv://reader:', random(16), '@cluster0.example.mongodb.net/app');
  const out = redact(`why does ${url} time out`);
  assert.equal(out.text, 'why does mongodb+srv://reader:[hidden: mongodb password]@cluster0.example.mongodb.net/app time out');
  assert.deepEqual(out.found, ['password']);
  assert.equal(scrub(join('postgres://app:', random(12), '@db.local:5432/x')),
    'postgres://app:[hidden: postgres password]@db.local:5432/x');
  // How people explain the shape. Found in a real reply on 23 September.
  for (const shown of ['mongodb+srv://user:pass@', 'postgres://u:<password>@host', 'redis://:${REDIS_PASSWORD}@cache'])
    assert.deepEqual(redact(shown), {text: shown, found: []});
});

test('credentials known by their shape are taken out wherever they sit', () => {
  const cases = [
    [join('sk-ant-', 'api03-', random(40)), 'anthropic key'],
    [join('sk-', 'proj-', random(40)), 'openai key'],
    [join('sk-', 'lf-', random(8), '-', random(4), '-', random(12)), 'langfuse key'],
    [join('gh', 'p_', random(36)), 'github token'],
    [join('github', '_pat_', random(40)), 'github token'],
    [join('xo', 'xb-', random(12), '-', random(20)), 'slack token'],
    [join('AI', 'za', random(35)), 'google api key'],
    [join('AK', 'IA', random(16).toUpperCase()), 'aws access key'],
    [join('sk', '_live_', random(24)), 'stripe key'],
    [join('sb', '_secret_', random(30)), 'supabase secret key'],
    [join('eyJ', random(20), '.', 'eyJ', random(30), '.', random(30)), 'token'],
  ];
  for (const [secret, kind] of cases) {
    const out = redact(`the key is ${secret} ok`);
    assert.equal(out.text, `the key is [hidden: ${kind}] ok`, kind);
    assert.deepEqual(out.found, [kind], kind);
  }
});

test('a private key goes whole, not line by line', () => {
  const block = ['-----BEGIN OPENSSH PRIVATE KEY-----', random(60), random(60), '-----END OPENSSH PRIVATE KEY-----'].join('\n');
  assert.equal(scrub(`here:\n${block}\nthanks`), 'here:\n[hidden: private key]\nthanks');
  // A paste cut off before the end is still a key.
  assert.equal(scrub(`${block.split('\n').slice(0, 2).join('\n')}`), '[hidden: private key]');
});

test('an env file keeps its names and loses its values', () => {
  const env = [
    'DATABASE_HOST=db.internal',
    `DB_PASSWORD=${random(18)}`,
    `STRIPE_WEBHOOK_SECRET="${random(24)}"`,
    'NODE_ENV=production',
  ].join('\n');
  assert.equal(scrub(env), [
    'DATABASE_HOST=db.internal',
    'DB_PASSWORD=[hidden: secret]',
    'STRIPE_WEBHOOK_SECRET="[hidden: secret]"',
    'NODE_ENV=production',
  ].join('\n'));
  assert.equal(scrub(`{"apiKey": "${random(20)}", "region": "syd1"}`),
    '{"apiKey": "[hidden: secret]", "region": "syd1"}');
});

test('code that only mentions secrets is left alone', () => {
  // What an agent's replies are full of. Mangling these would make every
  // document about auth unreadable for the pass that has to read it.
  const code = [
    'const token = fresh.accessToken;',
    'apiKey = process.env.SATCHEL_ROUTER_KEY ?? process.env.GEMINI_API_KEY',
    'password: z.string().min(8),',
    'secret_id uuid not null,',
    "token := row.refresh_token;",
    'Set `password=changeme` in the example file',
    'the token is valid for an hour',
    'SB_TOKEN=...        # a personal access token',
  ].join('\n');
  const out = redact(code);
  assert.equal(out.text, code);
  assert.deepEqual(out.found, []);
});

test('a value is only a secret next to a secret name when it looks random', () => {
  assert.equal(looksRandom(random(20)), true);
  assert.equal(looksRandom('fresh.accessToken'), false);
  assert.equal(looksRandom('hunter2'), false, 'too short to tell from a word');
  assert.equal(looksRandom('correcthorsebatterystaple'), false, 'no digits');
  assert.equal(looksRandom('${SUPABASE_KEY}'), false);
});

test('what was found is named and never quoted', () => {
  const secret = join('gh', 'p_', random(36));
  const out = redact(`push with ${secret} and ${join('mysql://root:', random(14), '@localhost/db')}`);
  assert.deepEqual(out.found.sort(), ['github token', 'password']);
  assert.ok(!JSON.stringify(out.found).includes(secret.slice(4)));
  assert.ok(!out.text.includes(secret));
});

test('nothing to scan is not an error', () => {
  assert.deepEqual(redact(''), {text: '', found: []});
  assert.deepEqual(redact(null), {text: '', found: []});
  assert.equal(scrub('no em dashes, ever'), 'no em dashes, ever');
});
