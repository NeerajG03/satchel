// Generates every artboard for the Satchel redesign canvas.
import { writeFileSync, mkdirSync } from 'node:fs';
const out = new URL('./project/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const FONTS = 'https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400;1,6..72,500&family=Instrument+Sans:wght@400;500;600&family=DM+Mono:wght@400;500&family=Caveat:wght@600&display=swap';

// One small design system: paper + hardware. Dark theme swaps the paper tokens only.
const CSS = (dark) => `
  :root { --outer:${dark ? '#171612' : '#DED8CC'}; --hw:#26231F; --hw2:#332E28; --hw3:#3E3831; --hwtext:#EEE7DB; --hwmuted:#A79E90;
    --paper:${dark ? '#26231F' : '#F4F0E7'}; --paper2:${dark ? '#2F2A24' : '#EDE7DB'}; --paper3:${dark ? '#3A342D' : '#E4DCCD'};
    --ink:${dark ? '#EEE7DB' : '#1F1B17'}; --muted:${dark ? '#B4AA9B' : '#6B6257'}; --line:${dark ? '#484238' : '#D9D1C4'};
    --accent:${dark ? '#FF9A70' : '#B8451A'}; --orange:#E4571E; --red:${dark ? '#FFACA4' : '#A82720'}; --green:${dark ? '#8FD3A6' : '#2E7A4A'}; --amber:${dark ? '#F1C25A' : '#8A5E00'};
    --led-green:#3E9E62; --led-amber:#E2A11E; --led-red:#C8442E; --led-off:#6E665C; }
  body { margin:0; background:var(--outer); color:var(--ink); font:15px/1.5 'Instrument Sans', system-ui, sans-serif; -webkit-font-smoothing:antialiased; }
  a { color:var(--accent); text-decoration:none; } a:hover { color:var(--orange); text-decoration:underline; text-underline-offset:3px; }
  * { box-sizing:border-box; }
  h1,h2,h3 { font-family:'Newsreader', Georgia, serif; font-weight:400; margin:0; letter-spacing:-.01em; }
  .serif { font-family:'Newsreader', Georgia, serif; }
  .mono { font-family:'DM Mono', ui-monospace, monospace; }
  .eyebrow { font:500 11px/1.4 'DM Mono', monospace; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); }
  .muted { color:var(--muted); } .fine { font-size:12.5px; line-height:1.5; }
  /* hardware */
  .frame { background:var(--hw); border-radius:22px; display:flex; flex-direction:column; overflow:hidden; box-shadow:0 30px 70px #0003; }
  .top { height:64px; display:flex; align-items:center; justify-content:space-between; padding:0 28px 0 24px; color:var(--hwtext); }
  .wordmark { font:600 34px/1 'Caveat', cursive; color:var(--hwtext); letter-spacing:0; position:relative; top:-2px; }
  .topmeta { display:flex; align-items:center; gap:22px; font:500 11px/1 'DM Mono', monospace; letter-spacing:.09em; text-transform:uppercase; color:var(--hwmuted); }
  .device { margin-left:14px; font:500 10.5px/1 'DM Mono', monospace; letter-spacing:.12em; color:var(--hwmuted); text-transform:uppercase; }
  .body { display:flex; flex-grow:1; min-height:0; padding:0 14px 14px 14px; gap:0; }
  .rail { width:154px; display:flex; flex-direction:column; gap:6px; padding:4px 10px 0 0; }
  .rail a { display:flex; align-items:center; gap:10px; min-height:44px; padding:0 14px; border-radius:9px; color:var(--hwtext); font-weight:500; font-size:14px; background:var(--hw2); box-shadow:inset 0 1px 0 #fff1, 0 1px 0 #0006; }
  .rail a:hover { background:var(--hw3); text-decoration:none; }
  .rail a[aria-current] { background:var(--paper); color:#1F1B17; box-shadow:0 1px 0 #0006; }
  .rail a[aria-current] .dot { background:var(--orange); }
  .rail .dot { width:7px; height:7px; border-radius:50%; background:#5C554C; flex:none; }
  .rail .spacer { flex-grow:1; }
  .key { display:inline-flex; align-items:center; justify-content:center; gap:8px; min-height:38px; padding:0 14px; border-radius:8px; background:var(--hw2); color:var(--hwtext); font:500 13px 'Instrument Sans', sans-serif; border:0; cursor:pointer; box-shadow:inset 0 1px 0 #fff1, 0 1px 0 #0008; }
  .key.on { background:var(--orange); color:#1F1B17; }
  .paper { flex-grow:1; min-width:0; background:var(--paper); border-radius:14px; padding:34px 44px 30px; display:flex; flex-direction:column; overflow:hidden; position:relative; }
  .paper::before { content:''; position:absolute; inset:0; border-radius:14px; box-shadow:inset 0 0 0 1px #0000000d, inset 0 2px 8px #0000000a; pointer-events:none; }
  .h1 { font-size:44px; line-height:1.05; letter-spacing:-.02em; }
  .h2 { font-size:26px; line-height:1.15; }
  .h3 { font-size:20px; line-height:1.25; }
  .lede { font-size:15px; color:var(--muted); max-width:560px; }
  .head { display:flex; align-items:flex-end; justify-content:space-between; gap:24px; }
  /* buttons */
  .btn { display:inline-flex; align-items:center; justify-content:center; gap:8px; min-height:40px; padding:0 16px; border-radius:8px; border:1px solid var(--line); background:var(--paper2); color:var(--ink); font:500 14px 'Instrument Sans', sans-serif; cursor:pointer; white-space:nowrap; }
  .btn:hover { background:var(--paper3); }
  .btn.primary { background:#1F1B17; color:#F4F0E7; border-color:#1F1B17; box-shadow:0 2px 0 #0009; }
  .btn.primary:hover { box-shadow:0 0 0 2px var(--orange), 0 2px 0 #0009; }
  .btn.quiet { background:transparent; border-color:transparent; padding:0 10px; }
  .btn.quiet:hover { background:var(--paper2); }
  .btn.danger { background:var(--red); color:#F4F0E7; border-color:transparent; }
  .btn.sm { min-height:32px; padding:0 12px; font-size:13px; }
  .btn.icon { width:40px; padding:0; }
  /* chips, leds, fields */
  .chip { display:inline-flex; align-items:center; gap:6px; height:24px; padding:0 9px; border-radius:999px; border:1px solid var(--line); font:500 10.5px 'DM Mono', monospace; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); white-space:nowrap; }
  .chip.ink { color:var(--ink); border-color:var(--ink); }
  .chip.blocked { color:var(--red); border-color:var(--red); }
  .chip.done { color:var(--muted); border-style:dashed; }
  .chip.progress { color:var(--accent); border-color:var(--accent); }
  .led { width:9px; height:9px; border-radius:50%; background:var(--led-off); flex:none; box-shadow:inset 0 1px 1px #0004; }
  .led.green { background:var(--led-green); box-shadow:0 0 0 3px #3E9E6233; } .led.amber { background:var(--led-amber); box-shadow:0 0 0 3px #E2A11E33; } .led.red { background:var(--led-red); box-shadow:0 0 0 3px #C8442E33; }
  .field { width:100%; border:1px solid var(--line); background:var(--paper2); color:var(--ink); border-radius:8px; padding:11px 13px; font:15px/1.4 'Instrument Sans', sans-serif; }
  .field.serif { font:20px/1.4 'Newsreader', Georgia, serif; }
  .field::placeholder { color:var(--muted); }
  label.f { display:flex; flex-direction:column; gap:6px; font-size:13px; font-weight:500; }
  .ph { color:var(--muted); font-weight:400; }
  .row { display:flex; align-items:center; gap:12px; }
  .between { display:flex; align-items:center; justify-content:space-between; gap:16px; }
  .col { display:flex; flex-direction:column; }
  .hr { height:1px; background:var(--line); }
  .entry { padding:20px 0; border-bottom:1px solid var(--line); display:flex; flex-direction:column; gap:8px; }
  .entry .title { font-size:22px; line-height:1.25; }
  .prov { font:11.5px/1.5 'DM Mono', monospace; color:var(--muted); letter-spacing:.02em; }
  .kbd { font:11px 'DM Mono', monospace; border:1px solid var(--line); border-radius:4px; padding:1px 5px; color:var(--muted); }
  .panel { background:var(--paper2); border:1px solid var(--line); border-radius:12px; padding:18px 20px; }
  .panel.ink { background:var(--ink); color:var(--paper); border-color:transparent; }
  .empty { display:flex; flex-direction:column; align-items:flex-start; gap:12px; max-width:520px; }
  .steps { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:16px; }
  .step { border:1px solid var(--line); border-radius:12px; padding:18px 18px 16px; display:flex; flex-direction:column; gap:10px; background:var(--paper); }
  .step .n { font:500 11px 'DM Mono', monospace; letter-spacing:.1em; color:var(--muted); }
  .seg { display:inline-flex; border:1px solid var(--line); border-radius:9px; overflow:hidden; background:var(--paper2); }
  .seg a { padding:9px 14px; font-weight:500; font-size:13px; color:var(--muted); border-right:1px solid var(--line); }
  .seg a:last-child { border-right:0; } .seg a[aria-current] { background:var(--paper); color:var(--ink); } .seg a:hover { text-decoration:none; color:var(--ink); }
  .foot { display:flex; justify-content:space-between; margin-top:auto; padding-top:18px; font:11px 'DM Mono', monospace; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
  .stepper { display:flex; align-items:center; gap:0; }
  .stepper span { font:500 10.5px 'DM Mono', monospace; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); padding:6px 10px; border:1px solid var(--line); background:var(--paper2); }
  .stepper span:first-child { border-radius:999px 0 0 999px; } .stepper span:last-child { border-radius:0 999px 999px 0; }
  .stepper span.on { background:var(--ink); color:var(--paper); border-color:var(--ink); } .stepper span.past { color:var(--ink); }
  .check { display:flex; gap:10px; align-items:flex-start; font-size:14px; } .check i { width:18px; height:18px; border:1.5px solid var(--ink); border-radius:4px; flex:none; margin-top:2px; display:inline-block; }
  .check i.on { background:var(--ink); box-shadow:inset 0 0 0 3px var(--paper); }
  .tick { color:var(--green); }
  /* phone */
  .phone { background:var(--hw); border-radius:44px; padding:14px 12px 12px; display:flex; flex-direction:column; gap:10px; box-shadow:0 30px 70px #0004; }
  .phone .ptop { display:flex; align-items:center; justify-content:space-between; padding:6px 12px 0; color:var(--hwtext); }
  .phone .wordmark { font-size:28px; }
  .phone .paper { border-radius:26px; padding:22px 20px 18px; }
  .scrim { position:absolute; inset:0; background:#1F1B1766; border-radius:14px; display:flex; align-items:center; justify-content:center; z-index:5; }
  .sheet { background:var(--paper); border-radius:14px; padding:26px 28px; width:520px; display:flex; flex-direction:column; gap:16px; box-shadow:0 30px 80px #0006, 0 0 0 1px #0002; animation: settle .32s cubic-bezier(.2,.7,.2,1) both; }
  .drop { position:absolute; right:44px; top:96px; width:360px; background:var(--paper); border:1px solid var(--line); border-radius:12px; box-shadow:0 18px 50px #0003; padding:10px; display:flex; flex-direction:column; gap:4px; z-index:6; animation: settle .18s ease-out both; }
  .drop a { display:flex; align-items:center; justify-content:space-between; gap:10px; min-height:40px; padding:0 12px; border-radius:8px; color:var(--ink); font-weight:500; font-size:14px; }
  .drop a:hover { background:var(--paper2); text-decoration:none; } .drop a[aria-current] { background:var(--paper2); box-shadow:inset 3px 0 0 var(--orange); }
  .focus { outline:3px solid var(--accent); outline-offset:3px; }
  mark { background:#E4571E33; color:inherit; border-radius:3px; padding:0 2px; }
  /* motion: one clock, two curves */
  .btn, .key, .rail a, .tabs a, .chip, .seg a { transition: background-color .18s ease-out, color .18s ease-out, box-shadow .18s ease-out, transform .12s ease-out; }
  .key:active, .btn.primary:active, .rail a:active { transform: translateY(1px); box-shadow: inset 0 1px 0 #fff1, 0 0 0 #0000; }
  .entry { animation: settle .32s cubic-bezier(.2,.7,.2,1) both; }
  .entry:nth-child(2) { animation-delay:.04s } .entry:nth-child(3) { animation-delay:.08s } .entry:nth-child(4) { animation-delay:.12s } .entry:nth-child(5) { animation-delay:.16s } .entry:nth-child(6) { animation-delay:.2s }
  @keyframes settle { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
  .led.green { animation: verify .9s cubic-bezier(.2,.7,.2,1) both; }
  @keyframes verify { 0% { background:var(--led-amber); box-shadow:0 0 0 0 #3E9E6266; } 60% { background:var(--led-green); box-shadow:0 0 0 7px #3E9E6200; } 100% { background:var(--led-green); box-shadow:0 0 0 3px #3E9E6233; } }
  .panel.ink { animation: settle .4s cubic-bezier(.2,.7,.2,1) both; }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration:.01ms !important; transition-duration:.01ms !important; } }
  .tabs { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:6px; }
  .tabs a { display:flex; align-items:center; justify-content:center; min-height:48px; border-radius:12px; background:var(--hw2); color:var(--hwtext); font-weight:500; font-size:13px; box-shadow:inset 0 1px 0 #fff1, 0 1px 0 #0006; }
  .tabs a[aria-current] { background:var(--paper); color:#1F1B17; }
`;

const page = ({ w, h, body, dark = false, lang = 'en', extraCss = '' }) => `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <link rel="stylesheet" href="${FONTS}">
  <style>${CSS(dark)}${extraCss}</style>
</helmet>
${body}
</x-dc>
<script data-dc-script data-props='{"$preview":{"width":${w},"height":${h}}}'>
class Component extends DCLogic {
  renderVals() { return {}; }
}
</script>
</body>
</html>`;

const NAV = [['Left off', 'Main.dc.html'], ['Book', 'Book.dc.html'], ['Tasks', 'Tasks.dc.html'], ['Projects', 'Projects.dc.html'], ['Apps', 'Apps.dc.html'], ['Settings', 'Settings.dc.html']];
const rail = (active) => `<nav class="rail" aria-label="Destinations">
  ${NAV.map(([l, f]) => `<a href="${f}"${l === active ? ' aria-current="page"' : ''}><span class="dot"></span>${l}</a>`).join('\n  ')}
  <div class="spacer"></div>
  <a href="Book.dc.html" style="background:var(--orange); color:#1F1B17;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>Write</a>
</nav>`;

const top = ({ device = 'MacBook', status = 'green', statusText = 'Synced', account = 'neerajg03' }) => `<header class="top">
  <div class="row" style="gap:0;"><span class="wordmark">satchel</span><span class="device">${device}</span></div>
  <div class="topmeta"><span>Wed 17 Sep</span><span class="row" style="gap:8px;"><span class="led ${status}"></span>${statusText}</span><span>${account}</span></div>
</header>`;

const desktop = ({ active, paper, topOpts = {}, dark = false, footL = '', footR = 'Explicit saves only', extraCss = '' }) => page({
  w: 1280, h: 820, dark, extraCss, body: `<div class="frame" style="width:1280px; height:820px;">
  ${top(topOpts)}
  <div class="body">
    ${rail(active)}
    <main class="paper">
      ${paper}
      <div class="foot"><span>${footL}</span><span>${footR}</span></div>
    </main>
  </div>
</div>` });

const phone = ({ active, paper, dark = false }) => page({
  w: 390, h: 844, dark, body: `<div class="phone" style="width:390px; height:844px;">
  <div class="ptop"><span class="wordmark">satchel</span><span class="row" style="gap:8px; font:500 10px 'DM Mono',monospace; letter-spacing:.12em; color:var(--hwmuted); text-transform:uppercase;"><span class="led amber"></span>Phone</span></div>
  <main class="paper" style="flex-grow:1; min-height:0;">${paper}</main>
  <nav class="tabs" aria-label="Destinations">${[['Left off', 'PhoneLeftOff.dc.html'], ['Book', 'PhoneBook.dc.html'], ['Tasks', 'PhoneTask.dc.html'], ['More', 'PhoneConsent.dc.html']].map(([l, f]) => `<a href="${f}"${l === active ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
</div>` });

const icon = {
  arrow: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  chev: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  search: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  ext: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M9 7h8v8"/></svg>',
  more: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  plus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  github: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.7.3 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .5z"/></svg>',
};

// Scope picker: replaces the chip-per-project pattern. A search field that lists For me + projects.
const scopePicker = (label, extra = '') => `<button class="btn" style="gap:10px; padding-left:12px;"><span class="eyebrow" style="color:var(--muted);">In</span><strong style="font-weight:600;">${label}</strong>${icon.chev}</button>${extra}`;

/* ---------------- Screens ---------------- */

// Welcome
const welcome = page({ w: 1280, h: 820, body: `<div class="frame" style="width:1280px; height:820px;">
  <header class="top"><span class="wordmark">satchel</span><div class="topmeta"><span>Private pilot</span></div></header>
  <div class="body"><main class="paper" style="padding:72px 80px 40px; display:grid; grid-template-columns: minmax(0,1.1fr) minmax(0,.9fr); gap:60px; align-items:start;">
    <div class="col" style="gap:26px; max-width:560px;">
      <span class="eyebrow">Your work, with you</span>
      <h1 class="h1" style="font-size:60px;">A place for what you want to remember.</h1>
      <p style="font-size:18px; line-height:1.65; margin:0; color:var(--ink);">Keep the decisions, preferences and next steps that make a project yours. Write them once. Every connected AI app can read them.</p>
      <div class="col" style="gap:12px; align-items:flex-start;">
        <a href="LeftOffEmpty.dc.html" class="btn primary" style="min-height:48px; padding:0 22px; font-size:15px;">${icon.github} Continue with GitHub</a>
        <span class="muted fine">GitHub is only used to sign you in. Satchel never asks for repository access here.</span>
      </div>
    </div>
    <aside class="col" style="gap:14px; padding-top:26px;">
      <span class="eyebrow">What lives in a Satchel</span>
      ${[['The book', 'Preferences and decisions you chose to save. Names and short descriptions form an index agents read first.'], ['Tasks and handoffs', 'The exact next action and the evidence the last session left behind.'], ['Projects', 'One effort, its repositories and the apps allowed to see it.'], ['Apps', 'Each connected agent gets only the scopes you grant. Revoke any time.']].map(([t, d]) => `<div style="padding:14px 0; border-top:1px solid var(--line); display:grid; grid-template-columns:150px 1fr; gap:18px;"><span class="h3">${t}</span><span class="muted" style="font-size:14px;">${d}</span></div>`).join('')}
      <div class="hr"></div>
    </aside>
    <div class="foot" style="grid-column:1/-1;"><span>Satchel · Private pilot</span><span>A little less repeating yourself</span></div>
  </main></div></div>` });

// Left off, first run (nothing saved yet)
const leftOffEmpty = desktop({ active: 'Left off', topOpts: { status: 'amber', statusText: 'Nothing saved yet' }, footL: '0 in the book · 0 tasks · 0 apps', paper: `
  <div class="head"><div class="col" style="gap:8px;"><span class="eyebrow">Wednesday, 17 September</span><h1 class="h1">Welcome, Neeraj.</h1></div></div>
  <p class="lede" style="margin:14px 0 30px; max-width:620px;">Your Satchel is empty, which is the right place to start. Do any one of these three and this page turns into “Where you left off”.</p>
  <div class="steps">
    <div class="step"><span class="n">01 · TWO MINUTES</span><h2 class="h3">Write the first thing down</h2><p class="muted" style="margin:0; font-size:14px; flex-grow:1;">A preference about how you like to work. It applies everywhere, no project needed.</p><a href="BookEmpty.dc.html" class="btn primary" style="align-self:flex-start;">Open the book ${icon.arrow}</a></div>
    <div class="step"><span class="n">02 · FIVE MINUTES</span><h2 class="h3">Connect an AI app</h2><p class="muted" style="margin:0; font-size:14px; flex-grow:1;">Install the Satchel plugin in Claude Code or Codex, then sign in from its connection settings. You choose what it can read.</p><a href="AppsEmpty.dc.html" class="btn" style="align-self:flex-start;">See the steps ${icon.arrow}</a></div>
    <div class="step"><span class="n">03 · WHEN YOU HAVE ONE</span><h2 class="h3">Capture a task</h2><p class="muted" style="margin:0; font-size:14px; flex-grow:1;">A title and the next action. Later, a handoff makes it resumable from any device.</p><a href="TasksEmpty.dc.html" class="btn" style="align-self:flex-start;">Capture a task ${icon.arrow}</a></div>
  </div>
  <div class="panel" style="margin-top:28px; display:grid; grid-template-columns:auto 1fr auto; gap:18px; align-items:center;">
    <span class="led amber"></span>
    <div><strong>You have 2 projects but nothing in them yet.</strong><span class="muted"> Managed Agents and Satchel were created earlier. A project with no memories or tasks is invisible to agents until you add something.</span></div>
    <a href="Projects.dc.html" class="btn sm">View projects</a>
  </div>` });

// Left off, populated
const leftOffWith = (extraCss) => desktop({ extraCss, active: 'Left off', footL: '5 in the book · 3 tasks moving · 2 apps', paper: `
  <div class="head"><div class="col" style="gap:8px;"><span class="eyebrow">Wednesday, 17 September</span><h1 class="h1">Where you left off.</h1></div>
    <div class="row"><a href="Tasks.dc.html" class="btn quiet">All tasks</a><a href="Book.dc.html" class="btn">Write something down</a></div></div>
  <div style="display:grid; grid-template-columns:minmax(0,1.5fr) 320px; gap:48px; margin-top:26px; flex-grow:1; min-height:0;">
    <section class="col" style="gap:0;">
      <span class="eyebrow" style="margin-bottom:6px;">Next actions · actionable now</span>
      ${[
        ['Satchel', 'Personal', 'in progress', 'progress', 'Ship the skills packaging worktree and open the PR.', 'Handoff · Claude Code · MacBook · today 09:41', 'PR #41 reachable', true],
        ['Release workflow', 'Work', 'ready', 'ink', 'Open the sync PR against frontend.', 'Progress update · Codex · desktop · Fri 17:06', 'branch sync-v2 reachable', true],
        ['Reimbursements', 'Personal', 'blocked', 'blocked', 'Submit the August claim.', 'Blocked: waiting on the finance portal login · Claude · phone · Thu 11:12', 'No code attached', false],
      ].map(([p, s, st, cls, next, prov, res, ok]) => `<article class="entry" style="gap:6px;">
        <div class="between"><span class="row" style="gap:10px;"><strong style="font-size:14px;">${p}</strong><span class="eyebrow">${s}</span></span><span class="chip ${cls}">${st}</span></div>
        <h2 class="h2" style="font-size:24px;">Next: ${next}</h2>
        <div class="between"><span class="prov">${prov} · ${res}</span><a href="Task.dc.html" class="btn sm">Open task</a></div>
      </article>`).join('')}
      <a href="Tasks.dc.html" class="muted fine" style="margin-top:12px; color:var(--muted);">4 more tasks are waiting on something. See them in Tasks ${icon.arrow}</a>
    </section>
    <aside class="col" style="gap:26px;">
      <div class="col" style="gap:8px;"><span class="eyebrow">Last thing saved</span>
        <p class="serif" style="font-size:22px; line-height:1.3; margin:0;">“Satchel has no personas and no curator in the first version.”</p>
        <span class="prov">Said on your phone · Project / Satchel · today 09:18</span></div>
      <div class="col" style="gap:8px;"><span class="eyebrow">Your apps</span>
        ${[['green', 'Claude Code', 'reads and saves · verified today'], ['amber', 'Codex', 'reads only · last read Fri'], ['off', 'Claude (phone)', 'not connected']].map(([l, n, d]) => `<div class="between" style="padding:9px 0; border-bottom:1px solid var(--line);"><span class="row" style="gap:10px;"><span class="led ${l}"></span><span style="font-weight:500;">${n}</span></span><span class="prov">${d}</span></div>`).join('')}
        <a href="Apps.dc.html" class="fine" style="margin-top:4px;">Manage apps ${icon.arrow}</a></div>
    </aside>
  </div>` });
const leftOff = leftOffWith('');
const SCRIPT = `@import url('https://fonts.googleapis.com/css2?family=Caveat:wght@500;600&display=swap'); .h1 { font-family:'Caveat', cursive; font-weight:600; font-size:58px; letter-spacing:0; line-height:.95; }`;
const leftOffScript = leftOffWith(SCRIPT);

// Book: empty
const bookEmpty = desktop({ active: 'Book', topOpts: { status: 'amber', statusText: 'Nothing saved yet' }, footL: '0 in the book', paper: `
  <div class="head"><div class="col" style="gap:8px;"><span class="eyebrow">Wednesday, 17 September</span><h1 class="h1">The book.</h1></div>
    <div class="row">${scopePicker('For me')}<a href="#" class="btn icon" aria-label="Search the book">${icon.search}</a></div></div>
  <p class="lede" style="margin:12px 0 26px;">“For me” holds preferences and details that apply across all your work. Pick a project from the picker when something belongs to one effort only.</p>
  <form class="panel" style="padding:22px 24px; display:flex; flex-direction:column; gap:14px; background:var(--paper); border-color:var(--ink);">
    <div class="between"><span class="eyebrow">Write something down · saving in For me</span><span class="fine muted">Explicit saves only</span></div>
    <label class="f"><span>Name <span class="ph">· short, how an agent will find it</span></span><input class="field serif" placeholder="writing-style" value=""></label>
    <label class="f"><span>Description <span class="ph">· one or two lines. This is what agents read first</span></span><textarea class="field" rows="2" placeholder="What this covers and when to read it."></textarea></label>
    <details><summary class="fine" style="cursor:pointer; color:var(--accent); list-style:none;">Add more info (optional) ${icon.chev}</summary></details>
    <div class="between"><span class="fine muted">Name and description form the index. More info is read on demand.</span><div class="row"><button type="button" class="btn quiet">Discard</button><button type="submit" class="btn primary">Save memory</button></div></div>
  </form>
  <div class="empty" style="margin-top:44px;">
    <span class="eyebrow">Ideas for a first memory</span>
    <h2 class="h2">Start with something about you.</h2>
    <p class="muted" style="margin:0;">Things you end up repeating in every new chat make good first entries. Tap one to prefill the form above.</p>
    <div class="row" style="flex-wrap:wrap; gap:8px; margin-top:4px;">${['How I like answers written', 'Tools and languages I use', 'What to never do in my code', 'My working hours and timezone'].map(t => `<a href="#" class="btn sm">${t}</a>`).join('')}</div>
  </div>` });

// Book: populated, one entry expanded
const memoryEntry = ({ name, desc, prov, rev, expanded = false, body = '', scope = '' }) => `<article class="entry">
  <div class="between" style="align-items:flex-start;"><div class="col" style="gap:4px;"><div class="row" style="gap:10px;"><h2 class="title serif">${name}</h2>${scope ? `<span class="eyebrow">${scope}</span>` : ''}</div><p style="margin:0; font-size:15px; max-width:640px;">${desc}</p></div>
    <div class="row" style="gap:4px;"><a href="BookCorrect.dc.html" class="btn quiet sm">Correct</a><button class="btn quiet sm icon" aria-label="More actions" style="width:32px;">${icon.more}</button></div></div>
  ${expanded ? `<div class="serif" style="font-size:19px; line-height:1.5; white-space:pre-wrap; padding:10px 0 4px; max-width:680px;">${body}</div>` : ''}
  <div class="between"><span class="prov">${prov}</span><span class="row" style="gap:14px;"><a href="#" class="fine" aria-expanded="${expanded}">${expanded ? 'Hide more info' : 'Read more info'}</a>${rev > 1 ? `<a href="#" class="fine muted" style="color:var(--muted);">${rev} revisions</a>` : ''}</span></div>
</article>`;

const book = desktop({ active: 'Book', footL: '5 in the book · Project / Satchel', paper: `
  <div class="head"><div class="col" style="gap:8px;"><span class="eyebrow">Project · Satchel</span><h1 class="h1">The book.</h1></div>
    <div class="row">${scopePicker('Satchel')}<a href="#" class="btn icon" aria-label="Search the book">${icon.search}</a></div></div>
  <div class="between" style="margin:14px 0 6px;"><p class="lede" style="margin:0;">Continuity between the AI apps you already use. Decisions saved here are read by Claude Code and Codex.</p>
    <a href="Book.dc.html" class="btn">${icon.plus} Write something down</a></div>
  <div class="row" style="gap:8px; margin:12px 0 4px;"><span class="seg"><a href="#" aria-current="true">All 5</a><a href="#">Saved by me 3</a><a href="#">Saved by agents 2</a></span><span class="fine muted">Newest first</span></div>
  ${memoryEntry({ name: 'no-personas-v1', desc: 'Satchel has no personas and no curator in the first version. Read before proposing agent roles.', prov: 'Said on your phone · today 09:18 · revision 1', rev: 1 })}
  ${memoryEntry({ name: 'task-authority', desc: 'Supabase is the only authority for task state. GitHub issues are attached references, never mirrors.', prov: 'Saved by Claude Code · MacBook · Tue 16 Sep · revision 2', rev: 2, expanded: true, body: 'Every write carries a request id and the current revision. A stale revision is a conflict, not an overwrite. Attach a GitHub issue or PR as a typed HTTPS resource; do not sync its status back.\n\nDecided 16 Sep after the Issues-only direction was dropped.' })}
  ${memoryEntry({ name: 'plain-words', desc: 'Write UI copy in plain 8th-grade words. No jargon, no metaphors, no em dashes.', prov: 'Said on your MacBook · Fri 12 Sep · revision 3', rev: 3 })}
  ${memoryEntry({ name: 'memory-index-shape', desc: 'Hooks read only names and descriptions. More info is fetched by name when needed.', prov: 'Saved by Codex · desktop · Thu 11 Sep · revision 1', rev: 1 })}` });

// Book: correcting one entry + forget confirm on another
const bookCorrect = desktop({ active: 'Book', footL: '5 in the book · Project / Satchel · draft open', paper: `
  <div class="head"><div class="col" style="gap:8px;"><span class="eyebrow">Project · Satchel</span><h1 class="h1">The book.</h1></div>
    <div class="row"><button class="btn" disabled style="opacity:.55; gap:10px; padding-left:12px;"><span class="eyebrow">In</span><strong style="font-weight:600;">Satchel</strong>${icon.chev}</button><a href="#" class="btn icon" aria-label="Search the book">${icon.search}</a></div></div>
  <p class="fine muted" style="margin:10px 0 18px;">Finish or discard the correction to switch scope.</p>
  <article class="entry" style="border:1px solid var(--ink); border-radius:12px; padding:20px 22px; margin-bottom:8px; background:var(--paper);">
    <div class="between"><span class="eyebrow">Correcting · will save as revision 4</span><span class="fine muted">Revision 3 stays in history</span></div>
    <label class="f"><span>Name</span><input class="field serif" value="plain-words"></label>
    <label class="f"><span>Description</span><textarea class="field" rows="2">Write UI copy in plain 8th-grade words. No jargon, no metaphors, no em dashes. Sentences may start with But or And.</textarea></label>
    <label class="f"><span>More info <span class="ph">· optional</span></span><textarea class="field" rows="3">Hedge naturally with “I feel” or “seems to be”. Repeat a word for emphasis instead of a fancier one. Leave it slightly unpolished.</textarea></label>
    <div class="between"><span class="fine muted">Saving in Project / Satchel · 148 / 40000</span><div class="row"><button class="btn quiet">Discard changes</button><button class="btn primary">Save correction</button></div></div>
  </article>
  <article class="entry">
    <div class="between" style="align-items:flex-start;"><div class="col" style="gap:4px;"><h2 class="title serif">memory-index-shape</h2><p style="margin:0; font-size:15px; max-width:640px;">Hooks read only names and descriptions. More info is fetched by name when needed.</p></div></div>
    <div class="panel" style="border-color:var(--red); display:grid; grid-template-columns:1fr auto; gap:16px; align-items:center; margin-top:6px;">
      <div><strong>Forget this memory?</strong><span class="muted"> It leaves active retrieval right away. Copies in earlier chats, exports and Codex's own memory are not touched. Satchel can't reach those.</span></div>
      <div class="row"><button class="btn quiet sm">Keep it</button><button class="btn danger sm">Forget</button></div>
    </div>
    <div class="between"><span class="prov">Saved by Codex · desktop · Thu 11 Sep · revision 1</span></div>
  </article>
  <article class="entry" style="opacity:.6;">
    <div class="between"><div class="col" style="gap:4px;"><h2 class="title serif">task-authority</h2><p style="margin:0; font-size:15px;">Supabase is the only authority for task state. GitHub issues are attached references, never mirrors.</p></div></div>
    <div class="between"><span class="prov">Saved by Claude Code · Tue 16 Sep · revision 2</span></div>
  </article>` });

// Book: dark theme (same content as Book)
const bookDark = desktop({ dark: true, active: 'Book', footL: 'Dark theme · same tokens', paper: `
  <div class="head"><div class="col" style="gap:8px;"><span class="eyebrow">Project · Satchel</span><h1 class="h1">The book.</h1></div>
    <div class="row">${scopePicker('Satchel')}<a href="#" class="btn icon" aria-label="Search the book">${icon.search}</a></div></div>
  <div class="between" style="margin:14px 0 6px;"><p class="lede" style="margin:0;">Continuity between the AI apps you already use. Decisions saved here are read by Claude Code and Codex.</p>
    <a href="Book.dc.html" class="btn">${icon.plus} Write something down</a></div>
  <div class="row" style="gap:8px; margin:12px 0 4px;"><span class="seg"><a href="#" aria-current="true">All 5</a><a href="#">Saved by me 3</a><a href="#">Saved by agents 2</a></span></div>
  ${memoryEntry({ name: 'no-personas-v1', desc: 'Satchel has no personas and no curator in the first version. Read before proposing agent roles.', prov: 'Said on your phone · today 09:18 · revision 1', rev: 1 })}
  ${memoryEntry({ name: 'task-authority', desc: 'Supabase is the only authority for task state. GitHub issues are attached references, never mirrors.', prov: 'Saved by Claude Code · MacBook · Tue 16 Sep · revision 2', rev: 2, expanded: true, body: 'Every write carries a request id and the current revision. A stale revision is a conflict, not an overwrite.' })}
  ${memoryEntry({ name: 'plain-words', desc: 'Write UI copy in plain 8th-grade words. No jargon, no metaphors, no em dashes.', prov: 'Said on your MacBook · Fri 12 Sep · revision 3', rev: 3 })}` });

// Projects list
const projects = desktop({ active: 'Projects', footL: '3 projects', paper: `
  <div class="head"><div class="col" style="gap:8px;"><span class="eyebrow">Your efforts</span><h1 class="h1">Projects.</h1></div><a href="ProjectEmpty.dc.html" class="btn primary">${icon.plus} New project</a></div>
  <p class="lede" style="margin:12px 0 22px;">A project is an ongoing effort, not a repository. Link as many codebases as it needs, or none at all.</p>
  <div style="display:grid; grid-template-columns:minmax(0,2fr) 90px 90px 140px 120px; gap:16px; padding:8px 0; border-bottom:1px solid var(--ink);" class="eyebrow"><span>Project</span><span>Memories</span><span>Tasks</span><span>Apps with access</span><span>Last activity</span></div>
  ${[
    ['Satchel', 'Personal memory and task continuity across AI apps.', ['neerajg03/satchel'], 5, '3 moving · 1 blocked', 'Claude Code, Codex', 'today 09:41', 'Project.dc.html'],
    ['Release workflow', 'Ship the monthly release without a war room.', ['acme/backend', 'acme/frontend'], 2, '2 ready', 'Codex', 'Fri 17:06', 'Project.dc.html'],
    ['Reimbursements', 'Monthly claims and receipts. No code.', [], 1, '1 blocked', 'Claude', 'Thu 11:12', 'Project.dc.html'],
    ['Managed Agents', 'Created 12 Sep. Nothing saved here yet.', [], 0, 'none', 'none', '—', 'ProjectEmpty.dc.html'],
  ].map(([n, b, repos, m, t, a, when, href]) => `<a href="${href}" style="display:grid; grid-template-columns:minmax(0,2fr) 90px 90px 140px 120px; gap:16px; padding:18px 0; border-bottom:1px solid var(--line); color:var(--ink); align-items:start;">
      <div class="col" style="gap:4px;"><span class="h3">${n}</span><span class="muted" style="font-size:14px;">${b}</span>${repos.length ? `<span class="row" style="gap:6px; margin-top:4px; flex-wrap:wrap;">${repos.map(r => `<span class="chip" style="text-transform:none; letter-spacing:0;">${icon.github} ${r}</span>`).join('')}</span>` : `<span class="fine muted" style="margin-top:4px;">No repositories linked</span>`}</div>
      <span style="font-size:15px;">${m}</span><span style="font-size:14px;">${t}</span><span style="font-size:14px;">${a}</span><span class="prov">${when}</span>
    </a>`).join('')}` });

// Project detail
const project = desktop({ active: 'Projects', footL: 'Project / Satchel · created 10 Sep', paper: `
  <a href="Projects.dc.html" class="fine muted" style="color:var(--muted);">← Projects</a>
  <div class="head" style="margin-top:8px;"><div class="col" style="gap:8px;"><span class="eyebrow">Project</span><h1 class="h1">Satchel</h1></div>
    <div class="row"><a href="Book.dc.html" class="btn">Open its book</a><a href="Tasks.dc.html" class="btn">Open its tasks</a><button class="btn icon" aria-label="Project actions">${icon.more}</button></div></div>
  <p class="serif" style="font-size:20px; line-height:1.45; margin:14px 0 22px; max-width:680px;">Personal memory and task continuity across AI apps. <a href="#" class="fine" style="font-family:'Instrument Sans',sans-serif;">Edit brief</a></p>
  <div style="display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:36px;">
    <section class="col" style="gap:10px;"><div class="between"><span class="eyebrow">Linked codebases</span><a href="#" class="fine">Link another</a></div>
      <div class="between" style="padding:10px 0; border-bottom:1px solid var(--line);"><span class="row" style="gap:8px;">${icon.github}<span class="mono" style="font-size:13px;">neerajg03/satchel</span></span><span class="fine muted">Unlink</span></div>
      <p class="fine muted" style="margin:0;">A linked repository lets an agent pick this project for a coding chat. It does not grant access by itself.</p></section>
    <section class="col" style="gap:10px;"><div class="between"><span class="eyebrow">Apps that can see this project</span><a href="Apps.dc.html" class="fine">Manage</a></div>
      ${[['green', 'Claude Code', 'memory read/write · tasks read/write + uploads'], ['amber', 'Codex', 'memory read only · no task access']].map(([l, n, d]) => `<div class="col" style="gap:2px; padding:10px 0; border-bottom:1px solid var(--line);"><span class="row" style="gap:8px;"><span class="led ${l}"></span><strong style="font-size:14px;">${n}</strong></span><span class="prov">${d}</span></div>`).join('')}</section>
    <section class="col" style="gap:10px;"><span class="eyebrow">Activity</span>
      ${[['today 09:41', 'Handoff on “Skills packaging” by Claude Code'], ['today 09:18', 'Memory “no-personas-v1” saved from phone'], ['Tue 16 Sep', 'Memory “task-authority” corrected (rev 2)'], ['Mon 15 Sep', 'Task “Add planning graph” moved to done']].map(([w, t]) => `<div class="col" style="gap:2px; padding:8px 0; border-bottom:1px solid var(--line);"><span style="font-size:14px;">${t}</span><span class="prov">${w}</span></div>`).join('')}</section>
  </div>
  <div style="display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:36px; margin-top:30px;">
    <section class="col" style="gap:6px;"><div class="between"><span class="eyebrow">Tasks · 4</span><a href="Tasks.dc.html" class="fine">All tasks</a></div>
      ${[['Ship the skills packaging worktree', 'in progress', 'progress'], ['Write the plugin pilot design', 'ready', 'ink'], ['Decide rule events retention', 'blocked', 'blocked']].map(([t, s, c]) => `<a href="Task.dc.html" class="between" style="padding:11px 0; border-bottom:1px solid var(--line); color:var(--ink);"><span class="serif" style="font-size:18px;">${t}</span><span class="chip ${c}">${s}</span></a>`).join('')}</section>
    <section class="col" style="gap:6px;"><div class="between"><span class="eyebrow">Memories · 5</span><a href="Book.dc.html" class="fine">Open the book</a></div>
      ${['no-personas-v1', 'task-authority', 'plain-words'].map(t => `<a href="Book.dc.html" class="between" style="padding:11px 0; border-bottom:1px solid var(--line); color:var(--ink);"><span class="serif" style="font-size:18px;">${t}</span><span class="prov">${icon.arrow}</span></a>`).join('')}</section>
  </div>` });

// Project: brand new / empty
const projectEmpty = desktop({ active: 'Projects', topOpts: { status: 'amber', statusText: 'Project has nothing yet' }, footL: 'Project / Managed Agents · created 12 Sep', paper: `
  <a href="Projects.dc.html" class="fine muted" style="color:var(--muted);">← Projects</a>
  <div class="head" style="margin-top:8px;"><div class="col" style="gap:8px;"><span class="eyebrow">Project</span><h1 class="h1">Managed Agents</h1></div><button class="btn icon" aria-label="Project actions">${icon.more}</button></div>
  <div class="panel" style="margin-top:18px; padding:16px 20px; display:grid; grid-template-columns:auto 1fr; gap:14px; align-items:center;"><span class="led amber"></span><span><strong>Agents can't see this project yet.</strong><span class="muted"> It has no brief, no memories and no tasks. Fill in the brief first so an agent can tell it apart from “Satchel”.</span></span></div>
  <form class="col" style="gap:14px; margin-top:22px; max-width:640px;">
    <label class="f"><span>Brief <span class="ph">· one or two lines an agent reads to know what this effort is</span></span><textarea class="field serif" rows="2" placeholder="What is this project for, and what does “done” look like?"></textarea></label>
    <div class="row" style="gap:10px;"><button class="btn primary">Save brief</button><span class="fine muted">You can change it any time.</span></div>
  </form>
  <div class="steps" style="margin-top:34px; grid-template-columns:repeat(3, minmax(0,1fr));">
    <div class="step"><span class="n">CODEBASES</span><h2 class="h3">Link a repository</h2><p class="muted" style="margin:0; font-size:14px; flex-grow:1;">Optional. Lets a coding agent select this project when it opens that repo.</p><div class="row" style="gap:8px;"><input class="field" placeholder="owner/repository" style="flex-grow:1;"><button class="btn sm">Link</button></div></div>
    <div class="step"><span class="n">BOOK</span><h2 class="h3">Save a first decision</h2><p class="muted" style="margin:0; font-size:14px; flex-grow:1;">Something agents should know before working here.</p><a href="BookEmpty.dc.html" class="btn sm" style="align-self:flex-start;">Write in this project's book</a></div>
    <div class="step"><span class="n">TASKS</span><h2 class="h3">Capture the next thing</h2><p class="muted" style="margin:0; font-size:14px; flex-grow:1;">A title and next action is enough to start.</p><a href="TasksEmpty.dc.html" class="btn sm" style="align-self:flex-start;">Capture a task</a></div>
  </div>` });

// Tasks: empty
const tasksEmpty = desktop({ active: 'Tasks', topOpts: { status: 'amber', statusText: 'No tasks yet' }, footL: '0 tasks · For me', paper: `
  <div class="head"><div class="col" style="gap:8px;"><span class="eyebrow">For me</span><h1 class="h1">Continue.</h1></div><div class="row">${scopePicker('For me')}</div></div>
  <p class="lede" style="margin:12px 0 26px;">Tasks hold the exact next action and the evidence a session leaves behind. They don't need a repository, and they don't need a project.</p>
  <form class="panel" style="padding:22px 24px; display:flex; flex-direction:column; gap:14px; background:var(--paper); border-color:var(--ink);">
    <span class="eyebrow">Capture a task · saving in For me</span>
    <label class="f"><span>Title</span><input class="field serif" placeholder="Submit the August claim"></label>
    <div style="display:grid; grid-template-columns:minmax(0,1fr) 160px; gap:14px;">
      <label class="f"><span>Next action <span class="ph">· the one concrete thing to do first</span></span><input class="field" placeholder="Log in to the finance portal and attach receipts"></label>
      <label class="f"><span>Priority</span><button type="button" class="btn" style="justify-content:space-between;">Medium ${icon.chev}</button></label>
    </div>
    <details><summary class="fine" style="cursor:pointer; color:var(--accent); list-style:none;">Add outcome, why, and done-when ${icon.chev}</summary></details>
    <div class="between"><span class="fine muted">Starts in Inbox. Move it to Ready when it has a next action.</span><button class="btn primary">Capture task</button></div>
  </form>
  <div class="empty" style="margin-top:44px;">
    <h2 class="h2">Nothing to continue yet.</h2>
    <p class="muted" style="margin:0;">Once a task exists, agents can record progress and handoffs on it. This list then shows what is moving, what is blocked, and the next action for each.</p>
    <a href="Tasks.dc.html" class="fine">See how a filled list looks ${icon.arrow}</a>
  </div>` });

// Tasks: list
const taskRow = ({ t, next, s, cls, prov, extra = '', href = 'Task.dc.html' }) => `<a href="${href}" class="entry" style="color:var(--ink); gap:5px; padding:16px 0;">
  <div class="between"><span class="serif" style="font-size:21px; line-height:1.25;">${t}</span><span class="chip ${cls}">${s}</span></div>
  <span style="font-size:15px;">${next}</span>${extra}
  <span class="prov">${prov}</span></a>`;
const tasks = desktop({ active: 'Tasks', footL: '7 tasks · 3 actionable · Project / Satchel', paper: `
  <div class="head"><div class="col" style="gap:8px;"><span class="eyebrow">Project · Satchel</span><h1 class="h1">Continue.</h1></div>
    <div class="row">${scopePicker('Satchel')}<a href="#" class="btn">Export</a><a href="TasksEmpty.dc.html" class="btn primary">${icon.plus} Capture</a></div></div>
  <div class="between" style="margin:16px 0 4px;"><span class="seg"><a href="#" aria-current="true">Actionable 3</a><a href="#">Moving 4</a><a href="#">Blocked 1</a><a href="#">Done 2</a><a href="#">All 7</a></span>
    <label class="row" style="gap:8px; border:1px solid var(--line); border-radius:8px; padding:0 12px; height:40px; width:280px; background:var(--paper2);">${icon.search}<input class="field" placeholder="Title or next action" style="border:0; background:transparent; padding:0;"></label></div>
  ${taskRow({ t: 'Ship the skills packaging worktree', next: 'Next: open the PR from skills-packaging and request review.', s: 'in progress', cls: 'progress', prov: 'High · rev 9 · handoff by Claude Code · today 09:41 · PR #41' })}
  ${taskRow({ t: 'Write the plugin pilot design', next: 'Next: turn docs/plugin-pilot-design.md into three concrete milestones.', s: 'ready', cls: 'ink', prov: 'Medium · rev 3 · 2 children · updated Fri' })}
  ${taskRow({ t: 'Add project upsert to the agent tools', next: 'Next: verify the upsert_project tool against a fresh project.', s: 'ready', cls: 'ink', prov: 'Medium · rev 2 · child of “Plugin pilot” · updated Tue' })}
  ${taskRow({ t: 'Decide rule events retention', next: 'Waiting on “Rules table migration” to finish first.', s: 'blocked', cls: 'blocked', prov: 'Low · rev 1 · 1 dependency unfinished', extra: `<span class="row" style="gap:8px; font-size:13px; color:var(--red);"><span class="led red" style="width:7px; height:7px;"></span>Blocked: schema for rule_events not merged yet</span>` })}
  <p class="fine muted" style="margin:14px 0 0;">2 done tasks are hidden. <a href="#">Show done</a></p>` });

// Task detail
const taskDetail = desktop({ active: 'Tasks', footL: 'Task · Project / Satchel · revision 9', paper: `
  <a href="Tasks.dc.html" class="fine muted" style="color:var(--muted);">← Tasks · Satchel</a>
  <div class="head" style="margin-top:8px; align-items:flex-start;"><div class="col" style="gap:10px; max-width:720px;">
      <div class="stepper" aria-label="State"><span class="past">Inbox</span><span class="past">Ready</span><span class="on">In progress</span><span>Blocked</span><span>Done</span></div>
      <h1 class="h1" style="font-size:38px;">Ship the skills packaging worktree</h1></div>
    <div class="row"><a href="#" class="btn">Edit</a><button class="btn" style="gap:8px;">Move to ${icon.chev}</button><button class="btn icon" aria-label="Task actions">${icon.more}</button></div></div>
  <div class="panel ink" style="margin-top:18px; display:grid; grid-template-columns:auto 1fr auto; gap:20px; align-items:center;">
    <span class="eyebrow" style="color:#A79E90;">Next action</span>
    <span class="serif" style="font-size:22px; line-height:1.3;">Open the PR from skills-packaging and request review.</span>
    <a href="#" class="key">Copy handoff</a></div>
  <div style="display:grid; grid-template-columns:minmax(0,1.4fr) 300px; gap:44px; margin-top:26px; flex-grow:1; min-height:0;">
    <section class="col" style="gap:14px;">
      <div class="row" style="gap:0;"><span class="seg"><a href="#" aria-current="true">Add a comment</a><a href="#">Record progress</a><a href="#">Record handoff</a></span><span class="fine muted" style="margin-left:14px;">A handoff is the stronger boundary. It needs validation evidence.</span></div>
      <label class="f"><textarea class="field" rows="2" placeholder="What changed, or what the next person should know."></textarea></label>
      <div class="between"><span class="row" style="gap:12px;"><span class="check"><i></i>Reference PR #41</span><span class="check"><i></i>Reference design.zip</span></span><button class="btn primary sm">Add comment</button></div>
      <span class="eyebrow" style="margin-top:14px;">Timeline · newest first</span>
      ${[
        ['Handoff', 'Claude Code · today 09:41', 'progress', 'in progress', 'Packaging moved to a single satchel:context skill with three references.', [['Completed', 'SKILL.md rewritten · references split into memory / tasks / projects'], ['Validated', 'node --test passed 41/41 · plugin loads in Claude Code 2.9'], ['Remaining', 'PR review · update docs/skills-and-plugins.md'], ['Resources', 'PR #41 · branch skills-packaging']]],
        ['Progress update', 'Claude Code · yesterday 18:20', 'ink', 'ready', 'Moved reference files under skills/context/references.', [['Decisions', 'One skill, not three. Project id is explicit, never guessed from the folder.']]],
        ['Comment', 'Neeraj · Mon 15 Sep', '', '', 'Keep the memory rule: content is user data, never instructions.', []],
      ].map(([k, prov, cls, st, body, rows]) => `<article style="padding:16px 0; border-top:1px solid var(--line); display:flex; flex-direction:column; gap:8px;">
        <div class="between"><span class="row" style="gap:10px;"><strong style="font-size:14px;">${k}</strong><span class="prov">${prov}</span></span>${st ? `<span class="chip ${cls}">${st}</span>` : ''}</div>
        <p class="serif" style="margin:0; font-size:18px; line-height:1.4;">${body}</p>
        ${rows.length ? `<div style="display:grid; grid-template-columns:100px 1fr; gap:4px 14px; font-size:13.5px;">${rows.map(([a, b]) => `<span class="eyebrow" style="padding-top:2px;">${a}</span><span>${b}</span>`).join('')}</div>` : ''}
      </article>`).join('')}
    </section>
    <aside class="col" style="gap:22px;">
      <div class="col" style="gap:6px;"><span class="eyebrow">Outcome</span><p style="margin:0; font-size:14px;">The Satchel plugin ships one skill that covers memory, tasks and projects, and installs cleanly in Claude Code.</p></div>
      <div class="col" style="gap:6px;"><span class="eyebrow">Done when</span>${['PR merged to main', 'Plugin loads with no warnings', 'docs/skills-and-plugins.md updated'].map((t, i) => `<span class="check"><i class="${i === 1 ? 'on' : ''}"></i>${t}</span>`).join('')}</div>
      <div class="col" style="gap:6px;"><div class="between"><span class="eyebrow">Planning</span><a href="#" class="fine">Edit</a></div>
        <span class="fine"><span class="tick">●</span> Actionable now · no unfinished dependencies</span>
        <span class="fine muted">Parent: <a href="#">Plugin pilot</a></span><span class="fine muted">Blocks: <a href="#">Publish plugin marketplace entry</a></span></div>
      <div class="col" style="gap:6px;"><div class="between"><span class="eyebrow">Resources</span><a href="#" class="fine">Attach</a></div>
        ${[['PR #41 · skills packaging', 'github.com', true], ['design.zip · 2.1 MB', 'verified upload', false]].map(([l, d, ext]) => `<div class="between" style="padding:8px 0; border-bottom:1px solid var(--line);"><span class="col" style="gap:1px;"><span style="font-size:14px;">${l}</span><span class="prov">${d}</span></span><a href="#" class="fine">${ext ? `Open ${icon.ext}` : 'Download'}</a></div>`).join('')}</div>
      <details><summary class="fine muted" style="cursor:pointer;">Technical history · 14 events</summary></details>
    </aside>
  </div>` });

// Apps: empty
const appsEmpty = desktop({ active: 'Apps', topOpts: { status: 'off', statusText: 'No apps connected' }, footL: '0 apps connected', paper: `
  <div class="head"><div class="col" style="gap:8px;"><span class="eyebrow">Your connections</span><h1 class="h1">Apps.</h1></div></div>
  <p class="lede" style="margin:12px 0 26px;">Nothing is connected yet. An app gets only the memory and task scopes you grant when it first asks. You can revoke later.</p>
  <div class="steps">
    <div class="step"><span class="n">01 · IN THE APP</span><h2 class="h3">Install the Satchel plugin</h2><p class="muted" style="margin:0; font-size:14px; flex-grow:1;">In Claude Code, add the plugin from its marketplace. In Codex, add the MCP server.</p><code class="mono fine" style="background:var(--paper2); border:1px solid var(--line); border-radius:6px; padding:8px 10px; display:block;">https://satchel-pi.vercel.app/api/mcp</code></div>
    <div class="step"><span class="n">02 · IN THE APP</span><h2 class="h3">Sign in from its connection settings</h2><p class="muted" style="margin:0; font-size:14px; flex-grow:1;">The app opens Satchel in your browser with a consent page. Nothing is granted until you allow it.</p><a href="Consent.dc.html" class="fine">Preview the consent page ${icon.arrow}</a></div>
    <div class="step"><span class="n">03 · BACK HERE</span><h2 class="h3">See it verified</h2><p class="muted" style="margin:0; font-size:14px; flex-grow:1;">The app appears in this list with a green light after its first real read.</p><span class="row" style="gap:8px;"><span class="led off"></span><span class="fine muted">Waiting for the first connection</span></span></div>
  </div>
  <div class="panel" style="margin-top:28px;"><strong>What a connected app can never do:</strong><span class="muted"> read scopes you didn't grant, save without both write permission and your explicit ask, or see More info in bulk. Hooks read names and descriptions only.</span></div>` });

// Apps: populated
const apps = desktop({ active: 'Apps', footL: '2 apps connected · 1 revoked', paper: `
  <div class="head"><div class="col" style="gap:8px;"><span class="eyebrow">Your connections</span><h1 class="h1">Apps.</h1></div><a href="AppsEmpty.dc.html" class="btn">How to connect another</a></div>
  <p class="lede" style="margin:12px 0 22px;">Each app gets only the scopes you chose. A permission here applies to every installation using that app identity.</p>
  ${[
    ['green', 'Claude Code', 'Verified · read 4 min ago', [['Memory', 'For me, Satchel, Release workflow', 'read and save'], ['Tasks', 'For me, Satchel', 'read, write and upload']], 'Revoke access', 'Apps.dc.html'],
    ['amber', 'Codex', 'Connected · last read Fri 17:06 · no writes granted', [['Memory', 'Release workflow', 'read only'], ['Tasks', 'none', '—']], 'Revoke access', 'Apps.dc.html'],
    ['off', 'Claude (iPhone)', 'Revoked 3 Sep · earlier retrieved content stays in that app', [['Memory', 'was: For me', 'read only']], 'Reconnect from the app', ''],
  ].map(([l, n, st, rows, act]) => `<article style="display:grid; grid-template-columns:220px 1fr auto; gap:24px; padding:20px 0; border-top:1px solid var(--line); align-items:start;">
    <div class="col" style="gap:4px;"><span class="row" style="gap:10px;"><span class="led ${l}"></span><h2 class="h3">${n}</h2></span><span class="prov">${st}</span></div>
    <div style="display:grid; grid-template-columns:70px 1fr 140px; gap:6px 14px; font-size:14px;">${rows.map(([a, b, c]) => `<span class="eyebrow" style="padding-top:3px;">${a}</span><span>${b}</span><span class="muted">${c}</span>`).join('')}</div>
    <div class="col" style="gap:6px; align-items:flex-end;"><button class="btn sm">${act}</button>${l !== 'off' ? `<a href="#" class="fine">Edit scopes</a>` : ''}</div>
  </article>`).join('')}` });

// Consent page (agent asks for access)
const consent = page({ w: 1280, h: 820, body: `<div class="frame" style="width:1280px; height:820px;">
  <header class="top"><span class="wordmark">satchel</span><div class="topmeta"><span>Connection request</span><span>neerajg03</span></div></header>
  <div class="body"><main class="paper" style="padding:40px 80px 30px; display:grid; grid-template-columns:minmax(0,1fr) 360px; gap:60px; align-content:start;">
    <div class="col" style="gap:18px;">
      <span class="eyebrow">An app wants to connect</span>
      <h1 class="h1" style="font-size:40px;">Codex wants to read your Satchel.</h1>
      <p class="muted" style="margin:0;">Name supplied by the app · will return to <span class="mono" style="font-size:13px;">http://localhost:1455/callback</span></p>
      <div class="row" style="gap:8px; margin-top:4px;"><span class="fine muted">Quick start:</span><button class="btn sm">Read everything</button><button class="btn sm">Read and save everything</button><button class="btn sm quiet">Clear all</button></div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-top:6px;">
      <fieldset style="border:1px solid var(--line); border-radius:12px; padding:16px 18px; display:flex; flex-direction:column; gap:11px; margin:0;">
        <legend class="eyebrow" style="padding:0 6px;">Memory</legend>
        <div class="between"><span class="fine" style="font-weight:600;">Scopes it can read · 2 of 4</span><span class="row" style="gap:10px;"><a href="#" class="fine">Select all</a><a href="#" class="fine muted" style="color:var(--muted);">None</a></span></div>
        <span class="check"><i class="on"></i>For me · personal memories</span><span class="check"><i class="on"></i>Satchel</span><span class="check"><i></i>Release workflow</span><span class="check"><i></i>Reimbursements</span>
        <div class="hr"></div>
        <span class="check"><i></i><span>Also allow saves, corrections and forgets<br><span class="fine muted">Only when you ask it to, in that chat.</span></span></span>
      </fieldset>
      <fieldset style="border:1px solid var(--line); border-radius:12px; padding:16px 18px; display:flex; flex-direction:column; gap:11px; margin:0;">
        <legend class="eyebrow" style="padding:0 6px;">Tasks</legend>
        <div class="between"><span class="fine" style="font-weight:600;">Scopes it can read · 1 of 4</span><span class="row" style="gap:10px;"><a href="#" class="fine">Select all</a><a href="#" class="fine muted" style="color:var(--muted);">None</a></span></div>
        <span class="check"><i></i>For me · personal tasks</span><span class="check"><i class="on"></i>Satchel</span><span class="check"><i></i>Release workflow</span><span class="check"><i></i>Reimbursements</span>
        <div class="hr"></div>
        <span class="check"><i class="on"></i>Also allow creating tasks, updates, moves and handoffs</span><span class="check"><i></i>Also allow file uploads to task storage</span>
      </fieldset>
      </div>
      <span class="fine muted">Projects you create later are not included. Add them from Apps.</span>
      <div class="row" style="gap:10px; margin-top:6px;"><a href="ConnectedCodex.dc.html" class="btn primary" style="min-height:46px; padding:0 22px;">Allow this access</a><button class="btn" style="min-height:46px;">Deny</button><span class="fine muted" style="margin-left:8px;">You can change or revoke this later in Apps.</span></div>
    </div>
    <aside class="col" style="gap:14px; padding-top:44px;">
      <div class="panel col" style="gap:8px;"><span class="eyebrow">What this means</span>
        <p style="margin:0; font-size:14px;">Reading means the app's hooks get the <strong>names and descriptions</strong> of memories in these scopes. It fetches More info by name only when it needs it.</p>
        <p style="margin:0; font-size:14px;">Writing still needs your explicit ask inside the chat. The app cannot save on its own.</p></div>
      <div class="col" style="gap:4px;"><span class="eyebrow">Summary</span><span style="font-size:14px;">Memory: <strong>For me, Satchel</strong> · read only</span><span style="font-size:14px;">Tasks: <strong>Satchel</strong> · read and write, no uploads</span></div>
    </aside>
    <div class="foot" style="grid-column:1/-1;"><span>Satchel · Private pilot</span><span>Deny closes this and sends the app back</span></div>
  </main></div></div>` });

// Settings
const settings = desktop({ active: 'Settings', footL: 'Account · neerajg03 · GitHub sign-in', paper: `
  <div class="head"><div class="col" style="gap:8px;"><span class="eyebrow">Account and preferences</span><h1 class="h1">Settings.</h1></div></div>
  <div style="display:grid; grid-template-columns:200px 1fr; gap:10px 40px; margin-top:26px; max-width:900px; align-items:start;">
    ${[
      ['Account', `<div class="between" style="max-width:560px;"><span class="row" style="gap:10px;">${icon.github}<span><strong>neerajg03</strong> <span class="muted">· neeraj@different.ai</span></span></span><button class="btn sm">Sign out</button></div><span class="fine muted">GitHub is used only to sign you in.</span>`],
      ['Take it with you', `<div class="col" style="gap:10px; max-width:560px;"><p style="margin:0; font-size:14px;">Export everything as a portable manifest plus your verified task files. No credentials are included. Identifiers, sources and revision history are kept.</p><div class="row"><button class="btn">Export all</button><button class="btn quiet">Export one project…</button></div></div>`],
      ['Forgetting', `<div class="col" style="gap:6px; max-width:560px;"><p style="margin:0; font-size:14px;">Forget removes a record from active retrieval right away. Satchel cannot delete copies from earlier chats, exports, or an app's own memory.</p><a href="#" class="fine">Read how retention works ${icon.arrow}</a></div>`],
    ].map(([k, v]) => `<span class="h3" style="padding:18px 0; border-top:1px solid var(--line);">${k}</span><div style="padding:18px 0; border-top:1px solid var(--line);">${v}</div>`).join('')}
  </div>` });

/* ---------------- Phone ---------------- */
const phoneLeftOff = phone({ active: 'Left off', paper: `
  <span class="eyebrow">Wednesday, 17 Sep</span><h1 class="h1" style="font-size:34px; margin:6px 0 16px;">Where you left off.</h1>
  ${[['Satchel', 'in progress', 'progress', 'Open the PR from skills-packaging.', 'Claude Code · MacBook · 09:41', true], ['Release workflow', 'ready', 'ink', 'Open the sync PR.', 'Codex · desktop · Fri', true], ['Reimbursements', 'blocked', 'blocked', 'Submit the August claim.', 'Blocked · finance login', false]].map(([p, s, c, n, prov, ok]) => `<article class="entry" style="gap:6px; padding:14px 0;">
    <div class="between"><strong style="font-size:13px;">${p}</strong><span class="chip ${c}">${s}</span></div>
    <span class="serif" style="font-size:20px; line-height:1.3;">Next: ${n}</span>
    <div class="between"><span class="prov">${prov}</span><a href="PhoneTask.dc.html" class="btn sm ${ok ? 'primary' : ''}">Open</a></div></article>`).join('')}
  <p class="fine muted" style="margin:10px 0 0;">Satchel holds the context. Open a task to read or copy its latest handoff.</p>
  <div class="col" style="gap:6px; margin-top:auto; padding-top:14px;"><span class="eyebrow">Your apps</span>
    <div class="between"><span class="row" style="gap:8px;"><span class="led green"></span>Claude Code</span><span class="prov">reads and saves</span></div>
    <div class="between"><span class="row" style="gap:8px;"><span class="led amber"></span>This phone</span><span class="prov">reads · <a href="PhoneConsent.dc.html">allow saves</a></span></div></div>` });

const phoneBook = phone({ active: 'Book', paper: `
  <div class="between"><span class="eyebrow">Wednesday, 17 Sep</span>${scopePicker('Satchel')}</div>
  <h1 class="h1" style="font-size:34px; margin:6px 0 14px;">The book.</h1>
  <div class="row" style="gap:8px; padding:6px 0 12px; border-bottom:1px solid var(--line);"><input class="field serif" placeholder="Write something down…" style="flex-grow:1; border:0; background:transparent; padding:8px 0; font-size:19px;"><a href="#" class="btn sm">Save</a></div>
  <p class="fine muted" style="margin:8px 0 6px;">Type a sentence. Satchel suggests a name from it, and you can change it before saving.</p>
  ${[['no-personas-v1', 'Satchel has no personas and no curator in the first version.', 'Said on your phone · 09:18'], ['task-authority', 'Supabase is the only authority for task state.', 'Claude Code · Tue · rev 2'], ['plain-words', 'Write UI copy in plain 8th-grade words.', 'Said on your MacBook · Fri · rev 3'], ['memory-index-shape', 'Hooks read only names and descriptions.', 'Codex · Thu']].map(([n, d, p]) => `<a href="#" class="entry" style="gap:3px; padding:14px 0; color:var(--ink);"><span class="serif" style="font-size:19px;">${n}</span><span style="font-size:14px;">${d}</span><span class="prov">${p}</span></a>`).join('')}` });

const phoneTask = phone({ active: 'Tasks', paper: `
  <a href="PhoneLeftOff.dc.html" class="fine muted" style="color:var(--muted);">← Left off</a>
  <div class="stepper" style="margin:10px 0 8px;"><span class="past">Inbox</span><span class="past">Ready</span><span class="on">In prog.</span><span>Blocked</span><span>Done</span></div>
  <h1 class="h1" style="font-size:28px;">Ship the skills packaging worktree</h1>
  <div class="panel ink" style="margin-top:14px; display:flex; flex-direction:column; gap:8px;"><span class="eyebrow" style="color:#A79E90;">Next action</span><span class="serif" style="font-size:19px; line-height:1.3;">Open the PR from skills-packaging and request review.</span>
    <div class="row" style="gap:8px; margin-top:4px;"><a href="#" class="key" style="background:#3E3831;">Copy handoff</a></div></div>
  <span class="eyebrow" style="margin:18px 0 6px;">Latest handoff · Claude Code · 09:41</span>
  <p class="serif" style="margin:0; font-size:17px; line-height:1.4;">Packaging moved to a single satchel:context skill with three references.</p>
  <div style="display:grid; grid-template-columns:82px 1fr; gap:4px 10px; font-size:13px; margin-top:8px;"><span class="eyebrow">Validated</span><span>41/41 tests · plugin loads</span><span class="eyebrow">Remaining</span><span>PR review · docs update</span><span class="eyebrow">Resources</span><span><a href="#">PR #41 ${icon.ext}</a></span></div>
  <div class="row" style="gap:8px; margin-top:auto; padding-top:16px;"><input class="field" placeholder="Add a comment…" style="flex-grow:1;"><button class="btn sm primary">Add</button></div>` });

const phoneConsent = phone({ active: 'More', paper: `
  <span class="eyebrow">This phone</span><h1 class="h1" style="font-size:30px; margin:6px 0 10px;">Reads the book, can't write in it yet.</h1>
  <p class="muted" style="margin:0 0 16px; font-size:14px;">Your own session on this phone is separate from what Claude is allowed to do. Allowing saves here does not change any agent's access.</p>
  <div class="panel col" style="gap:12px;"><span class="eyebrow">Allow saves from this phone</span>
    <span class="check"><i class="on"></i>For me</span><span class="check"><i class="on"></i>Satchel</span><span class="check"><i></i>Release workflow</span><span class="check"><i></i>Reimbursements</span>
    <button class="btn primary" style="margin-top:4px;">Allow saves</button></div>
  <span class="eyebrow" style="margin:22px 0 6px;">More</span>
  ${[['Projects', 'PhoneBook.dc.html'], ['Apps', 'PhoneLeftOff.dc.html'], ['Settings', 'PhoneLeftOff.dc.html']].map(([l, h]) => `<a href="${h}" class="between" style="padding:14px 0; border-bottom:1px solid var(--line); color:var(--ink); font-size:16px; font-weight:500;">${l}${icon.arrow}</a>`).join('')}` });

/* ---------------- Direction board ---------------- */
const direction = page({ w: 1280, h: 820, body: `<div style="width:1280px; height:820px; background:#F4F0E7; color:#1F1B17; padding:44px 52px; display:grid; grid-template-columns:repeat(12, minmax(0,1fr)); gap:26px; align-content:start; box-sizing:border-box;">
  <div style="grid-column:1/-1; display:flex; justify-content:space-between; align-items:flex-end;"><div class="col" style="gap:8px;"><span class="eyebrow">Design system · notebook with physical controls</span><h1 class="h1" style="font-size:40px;">Paper for what you wrote. Hardware for what apps may do.</h1></div><span class="prov">Serif book pairing · 17 Sep 2026</span></div>
  <section style="grid-column:span 5;" class="col"><span class="eyebrow" style="margin-bottom:10px;">Colour</span>
    <div style="display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:10px;">
      ${[['#F4F0E7', 'Paper', 'reading surface'], ['#EDE7DB', 'Paper 2', 'fields, panels'], ['#1F1B17', 'Ink', 'text, primary key'], ['#6B6257', 'Muted', '5.2:1 on paper'], ['#26231F', 'Hardware', 'frame, rail'], ['#332E28', 'Key', 'raised control'], ['#E4571E', 'Orange', 'selected control on hardware'], ['#B8451A', 'Accent text', '4.6:1 on paper'], ['#3E9E62', 'LED green', 'verified, always with text'], ['#E2A11E', 'LED amber', 'limited or waiting'], ['#C8442E', 'LED red', 'blocked, revoked'], ['#A82720', 'Red text', 'destructive, blocked']].map(([c, n, u]) => `<div class="col" style="gap:5px;"><span style="height:44px; border-radius:8px; background:${c}; border:1px solid #0001;"></span><strong style="font-size:12px;">${n}</strong><span class="prov" style="font-size:10.5px;">${c} · ${u}</span></div>`).join('')}
    </div>
    <p class="fine muted" style="margin:14px 0 0;">Dark theme swaps only paper, ink, muted and line tokens. The hardware stays as it is. The dark frame around light paper is the composition, not a dark mode.</p>
  </section>
  <section style="grid-column:span 4;" class="col"><span class="eyebrow" style="margin-bottom:10px;">Type</span>
    <span class="serif" style="font-size:34px; line-height:1.1;">Newsreader</span><span class="prov">Content you wrote: memory names, task titles, quotes. 400 and 500 only.</span>
    <span style="font-size:18px; font-weight:500; margin-top:14px;">Instrument Sans</span><span class="prov">Interface: labels, buttons, descriptions. 14 to 15 px body.</span>
    <span class="mono" style="font-size:14px; margin-top:14px;">DM Mono · SAID ON YOUR PHONE · 09:18</span><span class="prov">Readouts only: provenance, eyebrows, counts. Never for actions or critical state.</span>
    <span style="font:600 30px/1 'Caveat',cursive; margin-top:14px;">satchel</span><span class="prov">Caveat, wordmark only. Handwriting lives in one place, on the hardware. Decided 17 Sep after the Headings board.</span>
    <div class="hr" style="margin:16px 0 12px;"></div>
    <span class="eyebrow" style="margin-bottom:8px;">Voice</span><span style="font-size:14px;">Address the user. Say the source, the audience and what happens next. “Said on your phone.” “Reads only.” “Forget removes it from retrieval; copies in old chats stay.” No slogans inside working screens.</span>
  </section>
  <section class="col" style="grid-column:span 3; gap:10px;"><span class="eyebrow" style="margin-bottom:10px;">Controls</span>
    <div style="background:#26231F; border-radius:12px; padding:14px; display:flex; flex-direction:column; gap:8px;"><a href="#" class="key on">Selected key</a><a href="#" class="key">Hardware key</a><div class="row" style="gap:10px; color:#EEE7DB; font-size:13px; padding:4px 2px;"><span class="led green"></span>Verified<span class="led amber"></span>Limited<span class="led off"></span>Off</div></div>
    <div class="row" style="gap:8px; margin-top:10px; flex-wrap:wrap;"><a href="#" class="btn primary">Primary on paper</a><a href="#" class="btn">Secondary</a><a href="#" class="btn quiet">Quiet</a></div>
    <div class="row" style="gap:6px; margin-top:10px; flex-wrap:wrap;"><span class="chip ink">ready</span><span class="chip progress">in progress</span><span class="chip blocked">blocked</span><span class="chip done">done</span></div>
    <div class="stepper" style="margin-top:10px;"><span class="past">Inbox</span><span class="on">Ready</span><span>Done</span></div>
  </section>
  <section style="grid-column:1/-1; display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:26px; border-top:1px solid #D9D1C4; padding-top:18px;">
    ${[['Every empty state answers three things', 'What this place is for, the one action that fills it, and a way to see what it looks like full. Never a lonely sentence.'], ['Provenance on every record', 'Who saved it, from where, when, and its revision. History is disclosed on demand, not struck through in the list.'], ['Scope is a picker, not chips', 'For me plus a searchable project list. Works for 3 projects and for 40. Locked while a draft is open, with the reason shown.'], ['Lights always come with words', 'An LED never stands alone. Green “verified today”, amber “reads only”, off “not connected”.']].map(([t, d]) => `<div class="col" style="gap:6px;"><strong style="font-size:15px;">${t}</strong><span class="muted" style="font-size:13.5px;">${d}</span></div>`).join('')}
  </section>
</div>` });

/* ---------------- Connected: Satchel × partner. A simple acknowledgement, split down the middle. ---------------- */
// Left half is Satchel as it is everywhere else. Right half follows the partner's own visual language.
const connected = ({ partner, app, rightBg, rightInk, rightMuted, rightAccent, rightFont, rightMark, note }) => page({ w: 1280, h: 820, body: `<div style="width:1280px; height:820px; display:flex; position:relative; overflow:hidden; border-radius:22px;">
  <section class="frame" style="width:640px; flex:none; border-radius:0; padding:14px; box-shadow:none;">
    <main class="paper" style="flex-grow:1; padding:52px 60px 40px; justify-content:space-between;">
      <span class="wordmark" style="color:var(--ink); font-size:40px;">satchel</span>
      <div class="col" style="gap:16px;">
        <span class="row" style="gap:10px;"><span class="led green"></span><span class="eyebrow" style="color:var(--green);">Connected</span></span>
        <h1 class="h1" style="font-size:52px;">${app} can now read your Satchel.</h1>
        <p class="muted" style="margin:0; font-size:16px; max-width:420px;">Only what you just allowed. Change or revoke it any time in Apps.</p>
      </div>
      <div class="between"><a href="Apps.dc.html" class="btn primary">Back to Apps</a><span class="prov">neerajg03 · 17 Sep</span></div>
    </main>
  </section>
  <section style="width:640px; flex:none; position:relative; overflow:hidden; background:${rightBg}; color:${rightInk}; font-family:${rightFont}; padding:66px 74px 54px; display:flex; flex-direction:column; justify-content:space-between;">
    ${rightMark}
    <div style="display:flex; flex-direction:column; gap:16px; position:relative;">
      <span style="font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:${rightMuted};">Next</span>
      <h2 style="font-family:${rightFont}; font-size:44px; line-height:1.1; font-weight:400; letter-spacing:-.02em; margin:0; color:${rightInk};">Go back to ${app}.</h2>
      <p style="margin:0; font-size:16px; line-height:1.55; color:${rightMuted}; max-width:420px;">Your next chat starts with your memory index already loaded. You can close this tab.</p>
    </div>
    <div style="display:flex; justify-content:space-between; align-items:center;"><a href="#" style="display:inline-flex; align-items:center; min-height:44px; padding:0 20px; border-radius:999px; background:${rightAccent}; color:${rightAccent === '#FFFFFF' ? '#000000' : '#FFFFFF'}; font-weight:500; position:relative; font-size:14px; text-decoration:none;">Return to ${app}</a><span style="font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:${rightMuted};">${note}</span></div>
  </section>
  <div style="position:absolute; left:640px; top:50%; transform:translate(-50%,-50%); width:64px; height:64px; border-radius:50%; background:var(--hw); color:var(--hwtext); display:flex; align-items:center; justify-content:center; font:400 30px 'Newsreader',serif; box-shadow:0 0 0 6px #F4F0E7, 0 0 0 7px #0002;">×</div>
</div>` });

// Marks are approximations built from simple shapes, the same ones the app draws. Faint, behind the text.
const claudeMark = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor" style="position:absolute; right:-24px; bottom:-60px; width:420px; height:420px; opacity:.16; color:#FFFFFF; pointer-events:none;"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>`;
const openaiMark = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" style="position:absolute; right:-24px; bottom:-60px; width:420px; height:420px; opacity:.1; color:#FFFFFF; pointer-events:none;"><path d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"/></svg>`;

const connectedClaude = connected({ partner: 'Claude', app: 'Claude Code', rightBg: '#D97757', rightInk: '#FFFFFF', rightMuted: '#FBE9E0', rightAccent: '#141413', rightFont: "'Newsreader', Georgia, serif", note: 'Claude clay · white mark behind',
  rightMark: `${claudeMark}<span style="position:relative; display:inline-flex; align-items:center; gap:12px; font-family:'Newsreader',Georgia,serif; font-weight:500; font-size:40px; line-height:1; letter-spacing:-.02em; color:#FFFFFF;">${claudeMark.replace(/ style="[^"]*"/, ' style="width:32px; height:32px; display:block;"')}Claude</span>` });

const connectedCodex = connected({ partner: 'Codex', app: 'Codex', rightBg: '#000000', rightInk: '#FFFFFF', rightMuted: '#9A9A9A', rightAccent: '#FFFFFF', rightFont: "'Instrument Sans', system-ui, sans-serif", note: 'Black · grey mark behind',
  rightMark: `${openaiMark}<span style="position:relative; display:inline-flex; align-items:center; gap:12px; font-family:'Instrument Sans',sans-serif; font-weight:600; font-size:34px; line-height:1; letter-spacing:-.02em; color:#FFFFFF;">${openaiMark.replace(/ style="[^"]*"/, ' style="width:28px; height:28px; display:block;"')}Codex</span>` });

/* ---------------- Corners: the leak and the fix ---------------- */
const corners = page({ w: 1280, h: 560, body: `<div style="width:1280px; height:560px; background:#DED8CC; padding:40px 52px; display:grid; grid-template-columns:1fr 1fr 1fr; gap:36px; box-sizing:border-box; align-content:start;">
  <div style="grid-column:1/-1; display:flex; justify-content:space-between; align-items:flex-end;"><div class="col" style="gap:8px;"><span class="eyebrow">Rounded corners · why the paper leaks</span><h1 class="h1" style="font-size:34px;">The shell paints paper under its own dark border.</h1></div><span class="prov">src/style.css · .shell</span></div>
  <div class="col" style="gap:12px;"><span class="eyebrow" style="color:var(--red);">Today</span>
    <div style="border:12px solid #26231F; border-radius:20px; overflow:hidden; background:#F4F0E7; height:190px; position:relative;"><div style="background:#26231F; height:64px;"></div></div>
    <p style="margin:0; font-size:14px;">One box: 12 px dark border, radius 20, <span class="mono fine">overflow:hidden</span>, background paper. The header is clipped to the inner radius, but the paper background still paints under the border. The wedge in between shows as a light corner.</p></div>
  <div class="col" style="gap:12px;"><span class="eyebrow" style="color:var(--green);">Smallest fix · one line</span>
    <div style="border:12px solid #26231F; border-radius:20px; overflow:hidden; background:#F4F0E7; background-clip:padding-box; height:190px;"><div style="background:#26231F; height:64px;"></div></div>
    <p style="margin:0; font-size:14px;">Add <span class="mono fine">background-clip: padding-box</span> to <span class="mono fine">.shell</span>. Paper stops under the border, so the corner is dark all the way round. Nothing else moves.</p></div>
  <div class="col" style="gap:12px;"><span class="eyebrow" style="color:var(--green);">What the mockups do · structure</span>
    <div style="background:#26231F; border-radius:20px; padding:14px; height:190px; display:flex; flex-direction:column;"><div style="height:36px;"></div><div style="background:#F4F0E7; border-radius:12px; flex-grow:1;"></div></div>
    <p style="margin:0; font-size:14px;">Hardware is the outer box and paints everything. Paper is an inset panel with its own smaller radius. The header sits on hardware, so there is no corner to fight over. Same look, no border trick.</p></div>
</div>` });

/* ---------------- Motion ---------------- */
const motion = page({ w: 1280, h: 820, body: `<div style="width:1280px; height:820px; background:#F4F0E7; color:#1F1B17; padding:44px 52px; display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:26px 36px; align-content:start; box-sizing:border-box;">
  <style>
    @keyframes demoPress { 0%,40% { transform:none; box-shadow:inset 0 1px 0 #fff1, 0 1px 0 #0008; } 50%,60% { transform:translateY(1px); box-shadow:inset 0 1px 0 #fff1, 0 0 0 #0000; background:#E4571E; color:#1F1B17; } 70%,100% { background:#E4571E; color:#1F1B17; } }
    @keyframes demoLed { 0%,30% { background:#E2A11E; box-shadow:0 0 0 3px #E2A11E33; } 45% { background:#3E9E62; box-shadow:0 0 0 9px #3E9E6200; } 60%,100% { background:#3E9E62; box-shadow:0 0 0 3px #3E9E6233; } }
    @keyframes demoSettle { 0%,20% { opacity:0; transform:translateY(8px); } 45%,100% { opacity:1; transform:none; } }
    @keyframes demoRail { 0%,30% { transform:translateY(0); } 50%,100% { transform:translateY(50px); } }
    @keyframes demoStep { 0%,35% { width:33%; } 55%,100% { width:66%; } }
    @keyframes demoForget { 0%,30% { opacity:1; max-height:60px; } 50% { opacity:0; max-height:60px; } 70%,100% { opacity:0; max-height:0; } }
    @keyframes demoCompose { 0%,30% { height:44px; } 50%,100% { height:120px; } }
    @keyframes demoInk { 0%,45% { width:0; } 65%,100% { width:100%; } }
    .demo > * { animation-duration:3.2s; animation-iteration-count:infinite; animation-timing-function:cubic-bezier(.2,.7,.2,1); }
  </style>
  <div style="grid-column:1/-1; display:flex; justify-content:space-between; align-items:flex-end;"><div class="col" style="gap:8px;"><span class="eyebrow">Motion · everything on one clock</span><h1 class="h1" style="font-size:38px;">Things settle onto paper. Keys press. Lights confirm.</h1></div><span class="prov">120 ms taps · 180 ms hovers · 320 ms settles · one curve: cubic-bezier(.2,.7,.2,1)</span></div>
  ${[
    ['01 · Key press', 'Any hardware key drops 1 px and loses its bottom shadow for 120 ms. Selecting a rail item also turns it orange. Feels like a real key, no bounce.', `<div class="demo" style="background:#26231F; border-radius:12px; padding:16px; display:flex; gap:10px;"><a href="#" class="key" style="animation-name:demoPress;">Allow saves</a><a href="#" class="key">Deny</a></div>`],
    ['02 · Verify light', 'When a connection is checked, the LED goes amber, then a ring expands once and it settles green. 900 ms. Never loops. Always next to a word.', `<div class="demo" style="background:#26231F; border-radius:12px; padding:22px 16px; display:flex; gap:12px; align-items:center; color:#EEE7DB; font-size:14px;"><span class="led" style="animation-name:demoLed;"></span>Claude Code · verifying…</div>`],
    ['03 · Settle in', 'New list entries rise 6 px and fade in over 320 ms, staggered 40 ms each. Used when a scope changes or a save lands. Nothing slides in from the side.', `<div class="demo col" style="gap:8px;">${[0, .08, .16].map(d => `<div style="border-bottom:1px solid #D9D1C4; padding:8px 0; animation-name:demoSettle; animation-delay:${d}s;"><span class="serif" style="font-size:17px;">memory-name</span><br><span class="prov">Said on your phone · 09:18</span></div>`).join('')}</div>`],
    ['04 · Rail selection', 'The paper-coloured pill moves to the clicked destination in 180 ms instead of popping. The paper area cross-fades its content underneath in the same time.', `<div class="demo" style="background:#26231F; border-radius:12px; padding:12px; position:relative; height:126px;"><div style="position:absolute; left:12px; right:12px; top:12px; height:44px; background:#F4F0E7; border-radius:9px; animation-name:demoRail;"></div><div style="position:relative; display:flex; flex-direction:column; gap:6px; color:#EEE7DB; font-weight:500; font-size:14px;"><span style="height:44px; display:flex; align-items:center; padding:0 14px; mix-blend-mode:difference;">Left off</span><span style="height:44px; display:flex; align-items:center; padding:0 14px; mix-blend-mode:difference;">Book</span></div></div>`],
    ['05 · State move', 'Moving a task fills the stepper to the next stop over 320 ms. The chip on the list row swaps text with a 180 ms cross-fade. Blocked shows the red dot after, not during.', `<div class="demo col" style="gap:10px;"><div style="height:8px; background:#EDE7DB; border-radius:999px; overflow:hidden; border:1px solid #D9D1C4;"><div style="height:100%; background:#1F1B17; animation-name:demoStep;"></div></div><div class="row" style="justify-content:space-between;" ><span class="eyebrow">Inbox</span><span class="eyebrow">Ready</span><span class="eyebrow" style="color:#1F1B17;">In progress</span></div></div>`],
    ['06 · Forget', 'A forgotten entry fades out in 180 ms, then the space closes in 200 ms so the list below moves once, not twice. The confirmation panel never animates in; it just appears.', `<div class="demo col" style="gap:0;"><div style="overflow:hidden; animation-name:demoForget; border-bottom:1px solid #D9D1C4;"><div style="padding:8px 0;"><span class="serif" style="font-size:17px;">memory-index-shape</span><br><span class="prov">Codex · Thu</span></div></div><div style="padding:8px 0; border-bottom:1px solid #D9D1C4;"><span class="serif" style="font-size:17px;">plain-words</span><br><span class="prov">MacBook · Fri</span></div></div>`],
    ['07 · Composer opens', 'The one-line “Write something down…” grows into name, description and more info on focus. Height animates 320 ms, the extra fields fade in after 120 ms.', `<div class="demo"><div style="border:1px solid #1F1B17; border-radius:10px; background:#F4F0E7; overflow:hidden; animation-name:demoCompose; padding:10px 12px;"><span class="serif" style="font-size:18px; color:#6B6257;">Write something down…</span><div style="margin-top:12px; display:flex; flex-direction:column; gap:6px;"><span style="height:26px; border-radius:6px; background:#EDE7DB;"></span><span style="height:26px; border-radius:6px; background:#EDE7DB;"></span></div></div></div>`],
    ['08 · Saved', 'On save, a thin ink line draws under the new entry left to right in 320 ms, then fades. The status text “Saved to your book” appears in the footer readout, not a toast.', `<div class="demo col" style="gap:6px;"><div style="padding:8px 0;"><span class="serif" style="font-size:17px;">no-personas-v1</span><br><span class="prov">Said on your phone · just now</span></div><div style="height:2px; background:#1F1B17; animation-name:demoInk;"></div></div>`],
    ['09 · What never moves', 'Errors, delete confirmations and the consent page appear instantly. Nothing loops except the verify light once. Reduced motion turns everything into a plain swap.', `<div class="panel" style="border-color:var(--red); font-size:14px;"><strong>Could not save.</strong> <span class="muted">The revision changed under you. Reload to see the newer version.</span></div>`],
  ].map(([t, d, demo]) => `<div class="col" style="gap:10px; border-top:1px solid #D9D1C4; padding-top:14px;"><span class="eyebrow">${t}</span>${demo}<span class="muted" style="font-size:13px; line-height:1.5;">${d}</span></div>`).join('')}
</div>` });


/* ---------------- Headings: serif vs handwriting ---------------- */
const HANDS = 'https://fonts.googleapis.com/css2?family=Caveat:wght@500;600&family=Kalam:wght@400;700&family=Reenie+Beanie&family=Homemade+Apple&family=Nothing+You+Could+Do&display=swap';
const headings = page({ w: 1280, h: 820, extraCss: `@import url('${HANDS}');`, body: `<div style="width:1280px; height:820px; background:#DED8CC; padding:40px 52px; display:grid; grid-template-columns:repeat(5, minmax(0,1fr)); gap:18px; box-sizing:border-box; align-content:start;">
  <div style="grid-column:1/-1; display:flex; justify-content:space-between; align-items:flex-end;"><div class="col" style="gap:8px;"><span class="eyebrow">Headings · what a handwritten face does to the page</span><h1 class="h1" style="font-size:34px;">Same heading, five hands.</h1></div><span class="prov">Only the H1 changes. Content titles stay Newsreader, labels stay Instrument Sans.</span></div>
  ${[
    ['Newsreader · today', "font-family:'Newsreader',Georgia,serif; font-weight:400; font-size:38px; letter-spacing:-.02em; line-height:1.05;", 'Printed book. Calm, reads at any size, matches the memory titles below it. The safe one.', 'ink', 'Keep'],
    ['Caveat 600', "font-family:'Caveat',cursive; font-weight:600; font-size:50px; line-height:.95;", 'Marker on paper. Clear letterforms, still fast to read. The only script here that survives long headings.', 'green', 'Best script'],
    ['Kalam 700', "font-family:'Kalam',cursive; font-weight:700; font-size:40px; line-height:1.1;", 'Rounded ballpoint. Friendly but heavy. Starts to feel like a classroom or a kids app.', 'amber', 'Maybe'],
    ['Reenie Beanie', "font-family:'Reenie Beanie',cursive; font-size:50px; line-height:.95;", 'Quick pen scrawl. Charming at one word, tiring at a sentence. Thin strokes vanish on dark paper.', 'amber', 'Wordmark only'],
    ['Homemade Apple', "font-family:'Homemade Apple',cursive; font-size:30px; line-height:1.4;", 'Fountain pen cursive. Looks like a letter, not an interface. Fails 3:1 contrast at this stroke weight.', 'red', 'No'],
  ].map(([name, css, note, led, verdict]) => `<div class="col" style="gap:10px;">
    <div style="background:#F4F0E7; border-radius:12px; padding:22px 20px 18px; height:300px; display:flex; flex-direction:column; gap:10px; box-shadow:inset 0 0 0 1px #0000000d;">
      <span class="eyebrow">Wednesday, 17 Sep</span>
      <h2 style="${css} margin:0; flex-grow:1;">Where you left off.</h2>
      <div style="border-top:1px solid #D9D1C4; padding-top:10px; display:flex; flex-direction:column; gap:3px;"><span class="serif" style="font-size:17px;">Next: open the sync PR.</span><span class="prov">Codex · desktop · Fri</span></div>
    </div>
    <div class="row" style="gap:8px;"><span class="led ${led}" style="animation:none;"></span><strong style="font-size:13px;">${name}</strong><span class="chip" style="margin-left:auto;">${verdict}</span></div>
    <span class="muted" style="font-size:12.5px; line-height:1.5;">${note}</span></div>`).join('')}
  <div style="grid-column:1/-1; display:grid; grid-template-columns:1fr 1fr 1fr; gap:18px; border-top:1px solid #C9C1B3; padding-top:18px; margin-top:6px;">
    <div class="col" style="gap:8px;"><span class="eyebrow">Option A · script H1 everywhere · rejected</span>
      <div style="background:#F4F0E7; border-radius:10px; padding:16px 18px; display:flex; flex-direction:column; gap:6px;"><span class="eyebrow">Project · Satchel</span><span style="font-family:'Caveat',cursive; font-weight:600; font-size:44px; line-height:.95;">The book.</span><span style="font-family:'Caveat',cursive; font-weight:600; font-size:44px; line-height:.95;">Continue.</span><span style="font-family:'Caveat',cursive; font-weight:600; font-size:44px; line-height:.95;">Codex wants to read your Satchel.</span></div>
      <span class="muted" style="font-size:12.5px;">Works on one-word pages. The consent heading is where it starts to feel wrong: a permission request written in marker. </span></div>
    <div class="col" style="gap:8px;"><span class="eyebrow">Option B · handwriting as the margin note · considered</span>
      <div style="background:#F4F0E7; border-radius:10px; padding:16px 18px; display:flex; flex-direction:column; gap:4px;"><span style="font-family:'Caveat',cursive; font-weight:500; font-size:22px; color:#B8451A; line-height:1;">Wednesday, 17 Sep</span><span class="serif" style="font-size:38px; letter-spacing:-.02em; line-height:1.05;">Where you left off.</span><span style="font-family:'Caveat',cursive; font-weight:500; font-size:20px; color:#6B6257; margin-top:8px;">said on your phone, 09:18</span></div>
      <span class="muted" style="font-size:12.5px;">Keep Newsreader for the heading. Let the date and “said on your phone” lines be the handwriting, in accent orange. It reads like a diary entry: the printed page, and your pen in the margin. This is the one I would pick.</span></div>
    <div class="col" style="gap:8px;"><span class="eyebrow" style="color:var(--green);">Option C · wordmark only · chosen 17 Sep</span>
      <div style="background:#26231F; border-radius:10px; padding:16px 18px; display:flex; align-items:center; gap:24px; height:88px;"><span style="font-family:'Reenie Beanie',cursive; font-size:40px; color:#EEE7DB;">satchel</span><span style="font-family:'Caveat',cursive; font-weight:600; font-size:36px; color:#EEE7DB;">satchel</span><span class="wordmark">satchel</span></div>
      <span class="muted" style="font-size:12.5px;">Handwriting in one place, on the hardware. Everything on paper stays printed. Caveat 600 is the pick: it keeps its weight on dark hardware where the thin scripts fade.</span></div>
  </div>
</div>` });

/* ---------------- v1 details: overlays and states on the real pages ---------------- */
// Inject an overlay (sheet, dropdown, notice) into a finished page just before its footer readout.
const overlay = (html, extra) => html.replace('<div class="foot">', extra + '\n      <div class="foot">');
const swapFoot = (html, text) => html.replace(/<div class="foot"><span>[^<]*<\/span>/, `<div class="foot"><span>${text}</span>`);

// 1. Scope picker, open, on the Book
const scopePickerOpen = overlay(book.replace(scopePicker('Satchel'), `<button class="btn focus" style="gap:10px; padding-left:12px; background:var(--paper3);" aria-expanded="true"><span class="eyebrow" style="color:var(--muted);">In</span><strong style="font-weight:600;">Satchel</strong>${icon.chev}</button>`), `
      <div class="drop" role="listbox" aria-label="Choose a scope">
        <label class="row" style="gap:8px; border:1px solid var(--line); border-radius:8px; padding:0 12px; height:40px; background:var(--paper2); margin-bottom:6px;">${icon.search}<input class="field" placeholder="Find a project" style="border:0; background:transparent; padding:0;"></label>
        <a href="BookEmpty.dc.html"><span>For me</span><span class="prov">applies everywhere</span></a>
        <span class="eyebrow" style="padding:10px 12px 4px;">Projects · 4</span>
        <a href="Book.dc.html" aria-current="true"><span>Satchel</span><span class="prov">5 memories</span></a>
        <a href="#"><span>Release workflow</span><span class="prov">2 memories</span></a>
        <a href="#"><span>Reimbursements</span><span class="prov">1 memory</span></a>
        <a href="#"><span>Managed Agents</span><span class="prov" style="color:var(--amber);">empty</span></a>
        <div class="hr" style="margin:6px 0;"></div>
        <a href="ProjectNew.dc.html" style="color:var(--accent);"><span class="row" style="gap:8px;">${icon.plus} New project</span></a>
      </div>`);

// 2. Move to Blocked sheet, on the task page
const taskBlocked = overlay(taskDetail, `
      <div class="scrim"><form class="sheet">
        <div class="col" style="gap:6px;"><span class="eyebrow">Move to Blocked</span><h2 class="h2">What is in the way?</h2>
          <p class="muted" style="margin:0; font-size:14px;">The reason shows on Left off and on the task list, so the next session knows what to clear first.</p></div>
        <label class="f"><span>Blocker</span><textarea class="field focus" rows="3" placeholder="Waiting on review from…">Waiting on PR #41 review. Nothing else to do until it lands.</textarea></label>
        <span class="fine muted">This is recorded as a progress update with the reason as its body, so the timeline always shows why. One write, one revision.</span>
        <div class="between"><span class="fine muted">In progress to Blocked · revision 10</span><div class="row"><button type="button" class="btn quiet">Cancel</button><button class="btn primary" style="background:var(--red); border-color:var(--red);">Move to Blocked</button></div></div>
      </form></div>`);

// 3. Task edit: fields swap into the left column
const taskEdit = desktop({ active: 'Tasks', footL: 'Editing · revision 9 · save writes revision 10', paper: `
  <a href="Task.dc.html" class="fine muted" style="color:var(--muted);">← Back to task</a>
  <div class="head" style="margin-top:8px; align-items:flex-start;"><div class="col" style="gap:10px;">
      <div class="stepper" aria-label="State"><span class="past">Inbox</span><span class="past">Ready</span><span class="on">In progress</span><span>Blocked</span><span>Done</span></div>
      <span class="eyebrow">Editing task · state does not change here</span></div>
    <div class="row"><a href="Task.dc.html" class="btn quiet">Discard</a><a href="Task.dc.html" class="btn primary">Save task</a></div></div>
  <div style="display:grid; grid-template-columns:minmax(0,1.4fr) 300px; gap:44px; margin-top:20px; flex-grow:1; min-height:0;">
    <form class="col" style="gap:14px;">
      <label class="f"><span>Title</span><input class="field serif focus" value="Ship the skills packaging worktree" style="font-size:26px;"></label>
      <label class="f"><span>Next action <span class="ph">· the one concrete thing to do first</span></span><input class="field" value="Open the PR from skills-packaging and request review."></label>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px;">
        <label class="f"><span>Outcome <span class="ph">· what is true when this is done</span></span><textarea class="field" rows="3">The Satchel plugin ships one skill that covers memory, tasks and projects, and installs cleanly in Claude Code.</textarea></label>
        <label class="f"><span>Why <span class="ph">· the reason it matters</span></span><textarea class="field" rows="3">Three separate skills confused the router and doubled the docs. One skill with references is easier to keep honest.</textarea></label>
      </div>
      <label class="f"><span>Done when <span class="ph">· one per line, each becomes a checkbox</span></span><textarea class="field" rows="3">PR merged to main
Plugin loads with no warnings
docs/skills-and-plugins.md updated</textarea></label>
      <div style="display:grid; grid-template-columns:200px 1fr; gap:14px; align-items:end;">
        <label class="f"><span>Priority</span><button type="button" class="btn" style="justify-content:space-between;">High ${icon.chev}</button></label>
        <span class="fine muted" style="padding-bottom:10px;">Parent, dependencies and resources are edited on the task page, not here.</span></div>
    </form>
    <aside class="col" style="gap:14px;">
      <div class="panel col" style="gap:8px;"><span class="eyebrow">What this write does</span>
        <p style="margin:0; font-size:14px;">Saves with the current revision. If an agent changed the task since you opened it, you get a conflict, not an overwrite.</p>
        <p style="margin:0; font-size:14px;" class="muted">Last change: Claude Code · handoff · today 09:41</p></div>
      <div class="col" style="gap:6px; opacity:.55;"><span class="eyebrow">Planning · unchanged</span><span class="fine">Parent: Plugin pilot</span><span class="fine">Blocks: Publish plugin marketplace entry</span></div>
      <div class="col" style="gap:6px; opacity:.55;"><span class="eyebrow">Resources · unchanged</span><span class="fine">PR #41 · design.zip</span></div>
    </aside>
  </div>` });

// 4. New project sheet, on Projects
const projectNew = overlay(projects, `
      <div class="scrim"><form class="sheet">
        <div class="col" style="gap:6px;"><span class="eyebrow">New project</span><h2 class="h2">Name the effort, not the repo.</h2>
          <p class="muted" style="margin:0; font-size:14px;">A project can hold many repositories or none. You can link codebases on the next page.</p></div>
        <label class="f"><span>Name</span><input class="field serif focus" placeholder="Release workflow" value="Rules engine"></label>
        <label class="f"><span>Brief <span class="ph">· one or two lines an agent reads to tell this apart from your other projects</span></span><textarea class="field" rows="2" placeholder="What is this for, and what does done look like?">Declarative constraints Satchel enforces on agents, with an event log of what was blocked or overridden.</textarea></label>
        <span class="fine muted">A project with the same name already exists? Satchel will ask before creating a second one.</span>
        <div class="between"><span class="fine muted">Opens the new project page</span><div class="row"><button type="button" class="btn quiet">Cancel</button><a href="ProjectEmpty.dc.html" class="btn primary">Create project</a></div></div>
      </form></div>`);

// 5. Book search results
const bookSearch = desktop({ active: 'Book', footL: '2 of 5 match “authority” · Project / Satchel', paper: `
  <div class="head"><div class="col" style="gap:8px;"><span class="eyebrow">Project · Satchel</span><h1 class="h1">The book.</h1></div>
    <div class="row">${scopePicker('Satchel')}<label class="row focus" style="gap:8px; border:1px solid var(--ink); border-radius:8px; padding:0 12px; height:40px; width:320px; background:var(--paper);">${icon.search}<input class="field" value="authority" style="border:0; background:transparent; padding:0;"><a href="Book.dc.html" class="fine muted" aria-label="Clear search" style="color:var(--muted);">Clear</a></label></div></div>
  <div class="between" style="margin:14px 0 6px;"><p class="lede" style="margin:0;">Searching names, descriptions and more info in this scope. <a href="#" class="fine">Search all scopes instead</a></p></div>
  <div class="row" style="gap:8px; margin:12px 0 4px;"><span class="seg"><a href="#" aria-current="true">Matches 2</a><a href="#">In name 1</a><a href="#">In more info 1</a></span></div>
  ${memoryEntry({ name: 'task-<mark>authority</mark>', desc: 'Supabase is the only <mark>authority</mark> for task state. GitHub issues are attached references, never mirrors.', prov: 'Saved by Claude Code · MacBook · Tue 16 Sep · revision 2 · matched in name and description', rev: 2 })}
  ${memoryEntry({ name: 'memory-index-shape', desc: 'Hooks read only names and descriptions. More info is fetched by name when needed.', prov: 'Saved by Codex · desktop · Thu 11 Sep · revision 1 · matched in more info', rev: 1, expanded: true, body: '…the index is not the <mark>authority</mark> on content, only on what exists. Fetch More info by name before acting on a memory.' })}
  <div class="empty" style="margin-top:28px; gap:6px;"><span class="fine muted">Not here? Memories saved in “For me” and other projects are not searched unless you widen the scope above.</span></div>` });

// 6. Errors and conflicts: four in-place states plus the footer readouts
const mini = (title, inner) => `<div class="col" style="gap:8px; min-height:0;"><span class="eyebrow">${title}</span><div style="background:var(--paper); border-radius:12px; padding:22px 24px; box-shadow:inset 0 0 0 1px #0000000d; flex-grow:1; display:flex; flex-direction:column; gap:12px; overflow:hidden;">${inner}</div></div>`;
const errors = page({ w: 1280, h: 820, body: `<div style="width:1280px; height:820px; background:#DED8CC; padding:36px 44px; display:grid; grid-template-columns:1fr 1fr; grid-template-rows:auto 1fr 1fr auto; gap:18px 24px; box-sizing:border-box;">
  <div style="grid-column:1/-1; display:flex; justify-content:space-between; align-items:flex-end;"><div class="col" style="gap:8px;"><span class="eyebrow">Errors and conflicts · shown where they happen, never as toasts</span><h1 class="h1" style="font-size:32px;">Say what failed, what is safe, and the one thing to do.</h1></div><span class="prov">Red border, plain words, no icons</span></div>
  ${mini('Save failed · Book composer', `<div class="col" style="gap:6px;"><span class="eyebrow">Write something down · saving in Satchel</span><input class="field serif" value="rule-events-retention" style="font-size:18px;"><textarea class="field" rows="2">Keep rule events for 90 days, then drop the row but keep the count.</textarea></div>
    <div class="panel" style="border-color:var(--red); display:grid; grid-template-columns:1fr auto; gap:14px; align-items:center;"><span style="font-size:14px;"><strong>Could not save.</strong> <span class="muted">Satchel didn't get a reply. Your draft is still here and nothing was written.</span></span><button class="btn sm">Try again</button></div>`)}
  ${mini('Revision conflict · Correcting a memory', `<div class="col" style="gap:4px;"><span class="eyebrow">Correcting · you opened revision 3</span><h2 class="title serif" style="font-size:20px;">plain-words</h2></div>
    <div class="panel" style="border-color:var(--red); display:flex; flex-direction:column; gap:10px;"><span style="font-size:14px;"><strong>This memory changed while you were editing.</strong> <span class="muted">Claude Code saved revision 4 at 10:02. Your text was not saved and nothing was overwritten.</span></span>
      <div class="row" style="gap:8px;"><button class="btn sm primary">Show revision 4</button><button class="btn sm">Keep my text as a new draft</button><button class="btn sm quiet">Discard mine</button></div></div>`)}
  ${mini('Sign-in failed · Welcome', `<span class="eyebrow">Your work, with you</span><h2 class="h1" style="font-size:30px;">A place for what you want to remember.</h2>
    <div class="col" style="gap:8px; align-items:flex-start;"><a href="#" class="btn primary">${icon.github} Continue with GitHub</a>
      <div class="panel" style="border-color:var(--red); font-size:14px;"><strong>GitHub sign-in didn't finish.</strong> <span class="muted">It was cancelled or timed out. Nothing was created. Try again, or check that pop-ups are allowed.</span></div></div>`)}
  ${mini('Load failed · Left off', `<span class="eyebrow">Wednesday, 17 September</span><h2 class="h1" style="font-size:30px;">Where you left off.</h2>
    <div class="panel" style="border-color:var(--red); display:grid; grid-template-columns:1fr auto; gap:14px; align-items:center;"><span style="font-size:14px;"><strong>Couldn't reach your Satchel.</strong> <span class="muted">Tasks and the last saved memory didn't load. Nothing is lost. Your apps keep whatever they already read.</span></span><button class="btn sm">Reload</button></div>
    <div class="col" style="gap:6px; opacity:.4;"><span class="eyebrow">Next actions</span><span style="height:14px; background:var(--paper3); border-radius:4px; width:70%;"></span><span style="height:14px; background:var(--paper3); border-radius:4px; width:55%;"></span></div>`)}
  <div style="grid-column:1/-1; display:grid; grid-template-columns:1fr 1fr 1fr; gap:24px;">
    ${[['Success readouts live in the footer', '<div class="foot" style="margin:0; padding:10px 14px; background:var(--paper); border-radius:8px;"><span style="color:var(--green);">Saved to your book · revision 4</span><span>Explicit saves only</span></div>'], ['Export result · same place', '<div class="foot" style="margin:0; padding:10px 14px; background:var(--paper); border-radius:8px;"><span style="color:var(--green);">Exported satchel-2026-09-17.json + 3 files</span><span>No credentials included</span></div>'], ['Revoke · same place', '<div class="foot" style="margin:0; padding:10px 14px; background:var(--paper); border-radius:8px;"><span style="color:var(--green);">Codex access revoked</span><span>Earlier reads stay in that app</span></div>']].map(([t, d]) => `<div class="col" style="gap:8px;"><span class="eyebrow">${t}</span>${d}</div>`).join('')}
  </div>
</div>` });

// 7. Components: focus rings and long content
const components = page({ w: 1280, h: 820, body: `<div style="width:1280px; height:820px; background:#DED8CC; padding:36px 44px; display:grid; grid-template-columns:1fr 1fr 1fr; grid-template-rows:auto 1fr; gap:18px 24px; box-sizing:border-box;">
  <div style="grid-column:1/-1; display:flex; justify-content:space-between; align-items:flex-end;"><div class="col" style="gap:8px;"><span class="eyebrow">Components · keyboard focus and long content</span><h1 class="h1" style="font-size:32px;">Every control has a ring. Every string has a limit.</h1></div><span class="prov">Ring: 3 px accent, 3 px offset · Truncation: one line + title on hover</span></div>
  ${mini('Focus rings · one rule for everything', `<div style="background:#26231F; border-radius:12px; padding:14px; display:flex; flex-direction:column; gap:10px;"><a href="#" class="key" style="outline:3px solid #E4571E; outline-offset:3px; align-self:flex-start;">Hardware key</a><nav class="rail" style="width:auto; padding:0;"><a href="#" style="outline:3px solid #E4571E; outline-offset:3px;"><span class="dot"></span>Book</a></nav></div>
    <div class="row" style="gap:12px; flex-wrap:wrap;"><a href="#" class="btn primary focus">Primary</a><a href="#" class="btn focus">Secondary</a><a href="#" class="btn quiet focus">Quiet</a><span class="chip ink focus">chip</span></div>
    <input class="field focus" value="Field, focused">
    <div class="row" style="gap:16px;"><span class="check"><i class="focus" style="outline-offset:2px;"></i>Checkbox</span><a href="#" class="fine focus" style="outline-offset:2px;">Text link</a><span class="seg"><a href="#" aria-current="true" class="focus" style="outline-offset:-3px;">Segment</a><a href="#">Other</a></span></div>
    <span class="fine muted">On hardware the ring is orange. On paper it is accent red-orange. Never a blue browser default. Never removed.</span>`)}
  ${mini('Long names · rail and picker', `<div style="background:#26231F; border-radius:12px; padding:12px; display:flex; gap:12px;"><nav class="rail" style="width:154px; padding:0;"><a href="#" aria-current="page"><span class="dot"></span>Left off</a><a href="#"><span class="dot"></span>Book</a><a href="#" title="Tasks · 7 moving"><span class="dot"></span><span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">Tasks · 7 moving</span></a></nav>
      <div class="col" style="gap:4px; color:#EEE7DB; font-size:12.5px; padding-top:4px;"><span>The rail never shows project names. Six fixed destinations, so nothing there can grow.</span></div></div>
    <div class="drop" style="position:static; width:auto; max-height:220px; overflow:hidden; box-shadow:none;"><label class="row" style="gap:8px; border:1px solid var(--line); border-radius:8px; padding:0 12px; height:36px; background:var(--paper2);">${icon.search}<input class="field" value="re" style="border:0; background:transparent; padding:0;"></label>
      <span class="eyebrow" style="padding:8px 12px 2px;">Projects · 3 of 41 match</span>
      <a href="#"><span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">Release workflow</span><span class="prov">2</span></a><a href="#"><span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">Reimbursements for the Bengaluru office move, FY26 and the two vendor…</span><span class="prov">1</span></a><a href="#"><span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">Rules engine</span><span class="prov" style="color:var(--amber);">empty</span></a></div>
    <span class="fine muted">Picker rows truncate to one line with the full name on hover. Search filters as you type. Forty projects is a list, not a wall of chips.</span>`)}
  ${mini('Long titles · wrap, never clip', `<a href="#" class="entry" style="color:var(--ink); gap:5px; padding:12px 0;"><div class="between" style="align-items:flex-start;"><span class="serif" style="font-size:21px; line-height:1.25; max-width:360px;">Migrate every rule_events consumer off the nightly export and onto the streaming view before the retention change lands in October</span><span class="chip ink">ready</span></div><span style="font-size:14px;">Next: list the consumers in a comment on this task.</span><span class="prov">Medium · rev 1 · title 132 / 200</span></a>
    <article class="entry" style="padding:12px 0;"><h2 class="title serif" style="font-size:20px; overflow-wrap:anywhere;">how-i-want-answers-written-when-the-question-is-about-code-review-and-not-about-architecture</h2><p style="margin:0; font-size:14px;">Memory names wrap on hyphens. Field limit 120, shown as a counter while typing.</p><span class="prov">Name 92 / 120</span></article>
    <span class="fine muted">Chips and readouts stay on one line and never wrap. Titles and descriptions wrap as far as they need. Over-tall beats clipped.</span>`)}
</div>` });


/* ---------------- Mark: the logo ---------------- */
// Built on a 180 grid. Frame radius 22, paper inset 14 with radius 14, header 22 tall, LED r6 at (150,25), Caveat "s" in ink.
const markSvg = (size, { light = false, glyph = true } = {}) => `<svg width="${size}" height="${size}" viewBox="0 0 180 180" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Satchel"><rect width="180" height="180" rx="22" fill="#26231F"/><rect x="14" y="14" width="152" height="152" rx="14" fill="#F4F0E7"/><path d="M14 28a14 14 0 0 1 14-14h124a14 14 0 0 1 14 14v8H14z" fill="#26231F"/><circle cx="150" cy="25" r="6" fill="#E4571E"/>${glyph ? `<text x="90" y="118" text-anchor="middle" font-family="Caveat, cursive" font-weight="600" font-size="88" fill="#1F1B17">s</text>` : ''}</svg>`;
const lockup = (h) => `<div style="display:inline-flex; align-items:center; gap:${Math.round(h*.42)}px; background:#26231F; border-radius:${Math.round(h*.35)}px; padding:${Math.round(h*.35)}px ${Math.round(h*.6)}px ${Math.round(h*.35)}px ${Math.round(h*.35)}px;">${markSvg(h)}<span style="font:600 ${Math.round(h*.95)}px/1 'Caveat',cursive; color:#EEE7DB; position:relative; top:-${Math.round(h*.05)}px;">satchel</span></div>`;
const mark = page({ w: 1280, h: 820, body: `<div style="width:1280px; height:820px; background:#DED8CC; padding:40px 52px; display:grid; grid-template-columns:1.1fr 1fr 1fr; grid-template-rows:auto auto auto; gap:26px 36px; box-sizing:border-box; align-content:start;">
  <div style="grid-column:1/-1; display:flex; justify-content:space-between; align-items:flex-end;"><div class="col" style="gap:8px;"><span class="eyebrow">Mark · the app's own shell, shrunk</span><h1 class="h1" style="font-size:38px;">One mark, one wordmark, one family.</h1></div><span class="prov">Decided 18 Sep · option A mark + option E wordmark</span></div>

  <div class="col" style="gap:12px;"><span class="eyebrow">The mark</span>
    <div style="display:flex; gap:24px; align-items:flex-end; background:#F4F0E7; border-radius:14px; padding:24px;">${markSvg(160)}<div class="col" style="gap:14px; align-items:flex-start;">${markSvg(64)}${markSvg(32)}${markSvg(16, { glyph: false })}<span class="prov">160 · 64 · 32 · 16</span></div></div>
    <p style="margin:0; font-size:14px; line-height:1.5;">Dark frame, paper inset, one orange light. It is the shell from every page. At 16 px the "s" goes and the light stays; three shapes still read.</p></div>

  <div class="col" style="gap:12px;"><span class="eyebrow">Construction · 180 grid</span>
    <div style="background:#F4F0E7; border-radius:14px; padding:24px; display:flex; justify-content:center;"><svg width="220" height="220" viewBox="-20 -20 220 220" xmlns="http://www.w3.org/2000/svg"><g opacity=".55">${markSvg(180).replace(/<svg[^>]*>|<\/svg>/g,'')}</g><g fill="none" stroke="#B8451A" stroke-width="1" stroke-dasharray="3 3"><rect x="0" y="0" width="180" height="180" rx="22"/><rect x="14" y="14" width="152" height="152" rx="14"/><line x1="14" y1="36" x2="166" y2="36"/><circle cx="150" cy="25" r="6"/><line x1="90" y1="-14" x2="90" y2="194"/><line x1="-14" y1="90" x2="194" y2="90"/></g><g font-family="DM Mono, monospace" font-size="9" fill="#B8451A"><text x="2" y="-6">r22</text><text x="18" y="12">inset 14 · r14</text><text x="120" y="52">header 22</text><text x="128" y="14">led r6</text></g></svg></div>
    <p style="margin:0; font-size:14px; line-height:1.5;">Frame radius is 12% of the side. Paper inset is 8%. Header is 12%. LED is centred in the header band, 17% in from the right, 7% wide. Scale the grid, never redraw.</p></div>

  <div class="col" style="gap:12px;"><span class="eyebrow">Rules</span>
    <div class="col" style="gap:8px; font-size:14px; line-height:1.5; background:#F4F0E7; border-radius:14px; padding:20px 22px;">
      <span><strong>Always</strong> three parts: frame, paper, light. Nothing else goes inside.</span>
      <span><strong>Light</strong> is orange, top right, and never turns green or red in the logo. State lives in the app, not the mark.</span>
      <span><strong>Wordmark</strong> is Caveat 600 in paper ink on hardware. Never on paper, never in another face.</span>
      <span><strong>Clear space</strong> around the mark equals the paper inset. Never crop the frame.</span>
      <span><strong>On light</strong> backgrounds the frame is the edge. On dark ones add a 1 px paper ring so the frame does not sink.</span>
    </div></div>

  <div style="grid-column:1/-1; display:grid; grid-template-columns:1.1fr 1fr 1fr; gap:36px;">
    <div class="col" style="gap:12px;"><span class="eyebrow">Lockup · mark + wordmark</span>
      <div style="display:flex; flex-direction:column; gap:16px; align-items:flex-start; background:#F4F0E7; border-radius:14px; padding:24px;">${lockup(40)}${lockup(26)}<div style="display:flex; align-items:center; gap:14px; background:#26231F; border-radius:10px; padding:10px 18px 10px 12px; width:100%; box-sizing:border-box;">${markSvg(26)}<span style="font:600 26px/1 'Caveat',cursive; color:#EEE7DB;">satchel</span><span class="prov" style="margin-left:auto; color:#A79E90;">Wed 18 Sep</span><span class="led green"></span><span style="font-size:12px; color:#EEE7DB;">Synced</span></div></div>
      <p style="margin:0; font-size:14px; line-height:1.5;">Gap between mark and word is 42% of the mark's height. In the header, the mark sits where the wordmark alone sat today.</p></div>
    <div class="col" style="gap:12px;"><span class="eyebrow">Where it goes</span>
      <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:14px; background:#F4F0E7; border-radius:14px; padding:20px;">
        ${[['Browser tab', markSvg(16,{glyph:false}), '#FFFFFF'], ['Dark tab', `<div style="border-radius:3px; box-shadow:0 0 0 1px #F4F0E7;">${markSvg(16,{glyph:false})}</div>`, '#1F1B17'], ['Plugin icon', markSvg(48), '#FFFFFF'], ['Android launcher', `<div style="border-radius:50%; overflow:hidden; width:56px; height:56px; background:#26231F; display:flex; align-items:center; justify-content:center;">${markSvg(44)}</div>`, '#E9E4DA'], ['Consent header', lockup(20), '#FFFFFF'], ['Export cover', markSvg(56), '#F4F0E7']].map(([l, m, bg]) => `<div class="col" style="gap:8px; align-items:center;"><div style="width:100%; height:72px; background:${bg}; border:1px solid #D9D1C4; border-radius:8px; display:flex; align-items:center; justify-content:center;">${m}</div><span class="prov">${l}</span></div>`).join('')}
      </div></div>
    <div class="col" style="gap:12px;"><span class="eyebrow">Files</span>
      <div class="col" style="gap:8px; font-size:14px; line-height:1.5; background:#F4F0E7; border-radius:14px; padding:20px 22px;">
        <span class="mono fine">design/mark/mark.svg</span><span class="muted" style="font-size:13px;">Full mark with the s. Use at 32 px and up.</span>
        <span class="mono fine">design/mark/mark-small.svg</span><span class="muted" style="font-size:13px;">No glyph. Favicon, 16 and 24 px.</span>
        <span class="mono fine">design/mark/lockup.svg</span><span class="muted" style="font-size:13px;">Mark + wordmark on hardware. Loads Caveat from Google Fonts, so it is for the web. For print, outline the text first.</span>
      </div></div>
  </div>
</div>` });

/* ---------------- Write everything ---------------- */
const files = {
  'Direction.dc.html': direction, 'Mark.dc.html': mark, 'Motion.dc.html': motion, 'Headings.dc.html': headings, 'Corners.dc.html': corners, 'ConnectedClaude.dc.html': connectedClaude, 'ConnectedCodex.dc.html': connectedCodex,
  'Welcome.dc.html': welcome, 'LeftOffEmpty.dc.html': leftOffEmpty, 'Main.dc.html': leftOff,
  'BookEmpty.dc.html': bookEmpty, 'Book.dc.html': book, 'BookCorrect.dc.html': bookCorrect, 'BookDark.dc.html': bookDark,
  'Projects.dc.html': projects, 'Project.dc.html': project, 'ProjectEmpty.dc.html': projectEmpty,
  'TasksEmpty.dc.html': tasksEmpty, 'Tasks.dc.html': tasks, 'Task.dc.html': taskDetail,
  'AppsEmpty.dc.html': appsEmpty, 'Apps.dc.html': apps, 'Consent.dc.html': consent, 'Settings.dc.html': settings,
  'ScopePicker.dc.html': scopePickerOpen, 'TaskBlocked.dc.html': taskBlocked, 'TaskEdit.dc.html': taskEdit, 'ProjectNew.dc.html': projectNew, 'BookSearch.dc.html': bookSearch, 'Errors.dc.html': errors, 'Components.dc.html': components,
  'PhoneLeftOff.dc.html': phoneLeftOff, 'PhoneBook.dc.html': phoneBook, 'PhoneTask.dc.html': phoneTask, 'PhoneConsent.dc.html': phoneConsent,
};
for (const [name, html] of Object.entries(files)) writeFileSync(out + name, html);

// Canvas layout: rows of desktop boards (1280x820), 80 px between, title notes 240 px above each row.
const W = 1280, H = 820, GX = 80, ROW = 1200;
const rows = [
  ['Design system, the mark, motion, the corner fix, and the heading font question', ['Direction.dc.html', 'Mark.dc.html', 'Motion.dc.html', 'Corners.dc.html', 'Headings.dc.html']],
  ['Arrive: sign in, first run, then where you left off', ['Welcome.dc.html', 'LeftOffEmpty.dc.html', 'Main.dc.html']],
  ['The book: empty, filled, correcting and forgetting, dark theme', ['BookEmpty.dc.html', 'Book.dc.html', 'BookCorrect.dc.html', 'BookDark.dc.html']],
  ['Projects: list, a full project, a brand new one', ['Projects.dc.html', 'Project.dc.html', 'ProjectEmpty.dc.html']],
  ['Tasks: empty, list, task detail with timeline', ['TasksEmpty.dc.html', 'Tasks.dc.html', 'Task.dc.html']],
  ['v1 details: the picker open, sheets, edit, search, errors, and component states', ['ScopePicker.dc.html', 'BookSearch.dc.html', 'ProjectNew.dc.html', 'TaskEdit.dc.html', 'TaskBlocked.dc.html', 'Errors.dc.html', 'Components.dc.html']],
  ['Apps and settings: empty, connected, consent request, settings', ['AppsEmpty.dc.html', 'Apps.dc.html', 'Consent.dc.html', 'ConnectedClaude.dc.html', 'ConnectedCodex.dc.html', 'Settings.dc.html']],
];
const titles = { 'Direction.dc.html': 'Direction', 'Mark.dc.html': 'Mark · logo and wordmark', 'Welcome.dc.html': 'Welcome (signed out)', 'LeftOffEmpty.dc.html': 'Left off · first run', 'Main.dc.html': 'Left off', 'BookEmpty.dc.html': 'Book · empty', 'Book.dc.html': 'Book', 'BookCorrect.dc.html': 'Book · correcting + forget', 'BookDark.dc.html': 'Book · dark theme', 'Projects.dc.html': 'Projects', 'Project.dc.html': 'Project', 'ProjectEmpty.dc.html': 'Project · new and empty', 'TasksEmpty.dc.html': 'Tasks · empty', 'Tasks.dc.html': 'Tasks', 'Task.dc.html': 'Task detail', 'AppsEmpty.dc.html': 'Apps · none connected', 'Apps.dc.html': 'Apps', 'Consent.dc.html': 'Consent request', 'Settings.dc.html': 'Settings', 'ScopePicker.dc.html': 'Scope picker · open', 'BookSearch.dc.html': 'Book · search results', 'ProjectNew.dc.html': 'New project sheet', 'TaskEdit.dc.html': 'Task · editing', 'TaskBlocked.dc.html': 'Task · move to Blocked', 'Errors.dc.html': 'Errors and conflicts', 'Components.dc.html': 'Components · focus and long content', 'Motion.dc.html': 'Motion', 'Headings.dc.html': 'Headings · serif vs handwriting', 'MainScript.dc.html': 'Left off · Caveat heading (option A)', 'Corners.dc.html': 'Corners · leak and fix', 'ConnectedClaude.dc.html': 'Satchel × Claude', 'ConnectedCodex.dc.html': 'Satchel × OpenAI', 'BookDark.dc.html': 'Book · dark theme (v2 reference)', 'PhoneLeftOff.dc.html': 'v2 Android ref · Left off', 'PhoneBook.dc.html': 'v2 Android ref · Book', 'PhoneTask.dc.html': 'v2 Android ref · Task', 'PhoneConsent.dc.html': 'v2 Android ref · More' };
const boards = {}, order = [], notes = {};
rows.forEach(([title, list], r) => {
  const y = r * ROW;
  notes[`row${r}`] = { x: 0, y: y - 240, text: title, kind: 'title1', maxW: list.length * (W + GX) - GX };
  list.forEach((f, i) => { boards[f] = { x: i * (W + GX), y, w: W, h: H, title: titles[f], is_interactive: true }; order.push(f); });
});
boards['Corners.dc.html'].h = 560;
const py = rows.length * ROW;
notes.rowPhone = { x: 0, y: py - 240, text: 'v2 reference only: phone becomes a native Android app with app intents', kind: 'title1', maxW: 4 * (390 + GX) - GX + 800 };
['PhoneLeftOff.dc.html', 'PhoneBook.dc.html', 'PhoneTask.dc.html', 'PhoneConsent.dc.html'].forEach((f, i) => { boards[f] = { x: i * (390 + GX), y: py, w: 390, h: 844, title: titles[f], is_interactive: true }; order.push(f); });
notes.stickyEmpty = { x: 3 * (W + GX) + 40, y: 1 * ROW, w: 420, text: 'Empty states follow one rule: say what the place is for, give the single action that fills it, and offer a look at the full version. The first-run Left off page is the strongest example.', color: 'orange', size: 'm' };
notes.stickyScope = { x: 4 * (W + GX) + 40, y: 2 * ROW, w: 420, text: 'Scope picker replaces the project chips and the sidebar list. Same control on Book and Tasks. It locks while a draft is open and says why.', color: 'orange', size: 'm' };
notes.stickyTask = { x: 3 * (W + GX) + 40, y: 4 * ROW, w: 420, text: 'The task page puts the next action first, then one composer with three modes (comment, progress, handoff) instead of three long forms. Everything else moves to the right column.', color: 'orange', size: 'm' };

const canvas = { v: 3, attachments: {}, createdOnFiles: { v: 1, at: '2026-09-17T07:06:50.427Z' }, title: 'Satchel UI Redesign', launch: { view: 'canvas' }, pages: [], boards, order, notes, designSystems: [] };
writeFileSync(out + 'canvas.json', JSON.stringify(canvas, null, 2));
console.log(Object.keys(files).length, 'artboards written');
