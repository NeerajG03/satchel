import {test} from 'node:test';
import assert from 'node:assert/strict';
import {settle, zonedInstant, localNow, buildSortPrompt, createSorter} from '../server/shelf-sort.mjs';
import {sortItem} from '../server/shelf.mjs';

const item = {kind: 'voice', note: '', transcript: 'Remind me to call the dentist on Tuesday afternoon, and sync with Arun at 4 tomorrow.', description: 'Voice note about a dentist.'};
const topics = [{id: 't1', name: 'Release', profile: 'work'}];

test('a time in the person’s zone becomes the right instant, across zones and daylight saving', () => {
  assert.equal(zonedInstant('2026-11-10', '15:00', 'Asia/Kolkata').toISOString(), '2026-11-10T09:30:00.000Z');
  assert.equal(zonedInstant('2026-07-01', '09:00', 'Europe/London').toISOString(), '2026-07-01T08:00:00.000Z');
  assert.equal(zonedInstant('2026-12-01', '09:00', 'Europe/London').toISOString(), '2026-12-01T09:00:00.000Z');
  assert.equal(zonedInstant('2026-03-08', '03:30', 'America/New_York').toISOString(), '2026-03-08T07:30:00.000Z');
});

test('the capture time is shown as the person reads it', () => {
  assert.equal(localNow(new Date('2026-11-04T10:00:00Z'), 'Asia/Kolkata'), 'Wednesday 2026-11-04 15:30 (Asia/Kolkata)');
});

test('only grounded, well-formed suggestions survive', () => {
  const out = settle({profile: 'personal', topic: 1, suggestions: [
    {kind: 'todo', title: 'Call the dentist', date: '2026-11-10', time: null, end_time: null, profile: null, words: 'call the dentist on Tuesday afternoon'},
    {kind: 'event', title: 'Sync with Arun', date: '2026-11-05', time: '16:00', end_time: null, profile: 'work', words: 'Sync with Arun at 4 tomorrow'},
    {kind: 'todo', title: 'Book flights to Goa', date: null, time: null, end_time: null, profile: null, words: 'book the Goa flights'},
    {kind: 'event', title: 'No day', date: null, time: '10:00', end_time: null, profile: null, words: 'call the dentist'},
    {kind: 'todo', title: 'Bad date', date: '2026-13-40', time: null, end_time: null, profile: null, words: 'call the dentist'},
  ]}, {item, topics, timezone: 'Asia/Kolkata'});
  assert.equal(out.topic_id, 't1');
  assert.deepEqual(out.suggestions.map(s => s.title), ['Call the dentist', 'Sync with Arun', 'Bad date']);
  const [dentist, sync, bad] = out.suggestions;
  assert.equal(dentist.due_date, '2026-11-10');
  assert.equal(sync.starts_at, '2026-11-05T10:30:00.000Z');
  assert.equal(sync.ends_at, '2026-11-05T11:00:00.000Z', 'a missing end is half an hour on');
  assert.equal(bad.due_date, null, 'an impossible date is dropped, the to-do kept');
});

test('words from Satchel’s own description of a photo still have to be in the capture', () => {
  const photo = {kind: 'photo', note: '', transcript: null, description: 'Electricity bill, due 15 November 2026, total 2,340.'};
  const out = settle({profile: null, topic: null, suggestions: [
    {kind: 'todo', title: 'Pay the electricity bill', date: '2026-11-15', time: null, end_time: null, profile: null, words: 'Electricity bill, due 15 November 2026'},
  ]}, {item: photo, topics: [], timezone: 'UTC'});
  assert.equal(out.suggestions.length, 1);
});

test('the prompt carries the zone-aware time, the topics and the capture', () => {
  const prompt = buildSortPrompt({item, topics, timezone: 'Asia/Kolkata', now: new Date('2026-11-04T10:00:00Z')});
  assert.match(prompt, /Wednesday 2026-11-04 15:30/);
  assert.match(prompt, /1\. Release \[work\]/);
  assert.match(prompt, /what they said: Remind me/);
});

test('sorting saves once and sends only the person’s own words on to memory', async () => {
  const calls = [];
  const db = {rpc: async (name, args) => {
    calls.push([name, args]);
    if (name === 'shelf_sort_context') return {data: {timezone: 'Asia/Kolkata', topics}, error: null};
    if (name === 'save_shelf_sorting') return {data: 1, error: null};
    if (name === 'save_shelf_wants') return {data: args.p_wants.length, error: null};
    return {data: null, error: null};
  }};
  const sorter = createSorter({apiKey: 'x', promptResolver: async () => ({text: 'sort'}),
    ask: async () => ({object: {profile: 'work', topic: 1, suggestions: [
      {kind: 'event', title: 'Sync with Arun', date: '2026-11-05', time: '16:00', end_time: null, profile: null, words: 'sync with Arun at 4 tomorrow'}],
      wants: [{list: 'other', title: 'Arun', detail: null, words: 'Arun'}]}})});
  const out = await sortItem(db, sorter, {item: {...item, id: 'i1', note: 'release'}, description: item.description, transcript: item.transcript});
  assert.deepEqual(out, {suggestions: 1, profile: 'work', lines: 1});
  assert.deepEqual(calls.find(c => c[0] === 'save_shelf_wants')[1], {p_item: 'i1', p_wants: [{list: 'other', title: 'Arun', detail: null, words: 'Arun'}]});
  const saved = calls.find(c => c[0] === 'save_shelf_sorting')[1];
  assert.equal(saved.p_topic_id, 't1');
  assert.equal(saved.p_suggestions[0].starts_at, '2026-11-05T10:30:00.000Z');
  const memory = calls.find(c => c[0] === 'record_document_turn')[1];
  assert.equal(memory.p_session_key, 'shelf-i1');
  assert.equal(memory.p_content, `release\n${item.transcript}`);
  assert.doesNotMatch(memory.p_content, /Voice note about/, 'Satchel’s description is not the person’s words');
});

test('a photo with no note sends nothing on to memory', async () => {
  const calls = [];
  const db = {rpc: async (name) => { calls.push(name);
    return name === 'shelf_sort_context' ? {data: {timezone: null, topics: []}, error: null} : {data: 0, error: null}; }};
  const sorter = createSorter({apiKey: 'x', promptResolver: async () => ({text: 's'}),
    ask: async () => ({object: {profile: null, topic: null, suggestions: []}})});
  await sortItem(db, sorter, {item: {id: 'p1', kind: 'photo', note: ''}, description: 'A receipt.', transcript: null});
  assert.equal(calls.includes('record_document_turn'), false);
});

test('a list title survives only when it is in the capture, Satchel’s reading of a screenshot included', () => {
  const shot = {kind: 'photo', note: '', transcript: null,
    description: 'Screenshot of a reading list: Piranesi by Susanna Clarke, Project Hail Mary.'};
  const out = settle({profile: 'personal', topic: null, suggestions: [], wants: [
    {list: 'books', title: 'Piranesi', detail: 'Susanna Clarke', words: 'Piranesi by Susanna Clarke'},
    {list: 'books', title: ' Project   Hail Mary ', detail: null, words: 'Project Hail Mary'},
    {list: 'books', title: 'The Martian', detail: 'Andy Weir', words: 'Project Hail Mary'},
    {list: 'watch', title: '   ', detail: null, words: ''},
  ]}, {item: shot, topics: [], timezone: 'UTC'});
  assert.deepEqual(out.wants.map(w => [w.list, w.title, w.detail]),
    [['books', 'Piranesi', 'Susanna Clarke'], ['books', 'Project Hail Mary', null]], 'a title not in it is invented');
});

test('a receipt keeps only a printed amount and a shown currency; a fact is never a secret', () => {
  const item = {kind: 'photo', note: 'office wifi Satchel-5G pass hunter22', transcript: null,
    description: 'Receipt from Toit, total Rs 2,340. Card number 4111 1111 1111 1111. Parking B2, pillar 47. Gate code 4590.'};
  const out = settle({profile: null, topic: null, suggestions: [], wants: [],
    expenses: [
      {shop: 'Toit', amount: 2340, currency: 'INR', date: '2026-11-04', words: 'total Rs 2,340'},
      {shop: 'Toit', amount: 2500, currency: 'USD', date: 'yesterday', words: 'guess'},
      {shop: 'Nowhere Cafe', amount: 100, currency: 'INR', date: null, words: 'x'}],
    facts: [
      {label: 'Parking', value: 'B2, pillar 47', words: 'Parking B2, pillar 47'},
      {label: 'Office wifi', value: 'Satchel-5G', words: 'office wifi Satchel-5G'},
      {label: 'Wifi password', value: 'hunter22', words: 'pass hunter22'},
      {label: 'Card', value: '4111 1111 1111 1111', words: 'Card number'},
      {label: 'Gate', value: '4590', words: 'Gate code 4590'},
      {label: 'Made up', value: 'Level 9', words: 'x'}],
  }, {item, topics: [], timezone: 'UTC'});
  const spent = out.wants.filter(w => w.kind === 'expense');
  assert.deepEqual(spent.map(w => [w.title, w.amount, w.currency, w.date]),
    [['Toit', '2340.00', 'INR', '2026-11-04'], ['Toit', null, null, null]], 'an unprinted amount, unshown currency and bad day are dropped; an unseen shop is gone');
  assert.deepEqual(out.wants.filter(w => w.kind === 'fact').map(w => [w.title, w.detail]),
    [['Parking', 'B2, pillar 47'], ['Office wifi', 'Satchel-5G']], 'no password, card number or gate code, and nothing not in the capture');
});
