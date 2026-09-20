const { chromium } = require('playwright');
const out = {};
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1900, height: 1150 } });
  const errors = []; page.on('pageerror', e => errors.push('page: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto('http://localhost:8765/jeff-companion.html');
  await page.getByRole('button', { name: 'Play interactive artboard' }).click(); await page.waitForTimeout(1500);
  const f = page.frames().find(fr => fr !== page.mainFrame() && fr.url().startsWith('about:')) || page.frames()[1];
  await f.locator('.hw').first().waitFor({ timeout: 10000 });
  const w = () => page.waitForTimeout(220);
  // laptop resume
  await f.locator('.key', { hasText: 'Resume here' }).first().click(); await w();
  out.sheet = await f.locator('text=/opens on this MacBook/').count();
  out.issue = await f.locator('.mono:has-text("jeff-v2#12")').count();
  await f.locator('.key', { hasText: 'Copy the handoff instead' }).click(); await w();
  out.copyShown = await f.locator('.pre:has-text("JEFF handoff · JEFF v2")').count();
  // phone sees it
  await f.locator('.hwkey', { hasText: 'Left off' }).click(); await w();
  out.phoneSees = await f.locator('text=/Picked up on your MacBook/').count();
  // phone resumes another (read on) 
  await f.locator('.key', { hasText: 'Resume on this phone' }).first().click(); await w();
  out.phoneSheet = await f.locator('text=/Claude opens with this handover/').count();
  out.laptopSeesPhone = await f.locator('text=/Picked up on your phone/').count();
  out.takeOver = await f.locator('.key', { hasText: 'Take it over here' }).count();
  // put back on laptop
  await f.locator('.key', { hasText: 'Put it back' }).first().click(); await w();
  out.afterRelease = await f.locator('.key', { hasText: 'Resume here' }).count();
  // phone read off -> cannot read path
  await f.locator('.hwkey', { hasText: 'Apps' }).click(); await w();
  await f.locator('.hw .sw.on').nth(2).click(); await w(); // claude read (phone list: codex r, codex s, claude r)
  await f.locator('.hwkey', { hasText: 'Left off' }).click(); await w();
  await f.locator('.key', { hasText: 'Resume on this phone' }).first().click(); await w();
  out.phoneCannotRead = await f.locator('text=/can.t read the book on this phone/').count();
  // side panel links
  await f.locator('.tab', { hasText: 'Left off' }).click(); await w(); await f.locator('.words.act', { hasText: '“' }).first().click(); await w();
  out.lastSavedGoesToBook = await f.locator('h1', { hasText: 'The book.' }).count();
  await f.locator('.mono.act', { hasText: 'IN THE BOOK' }).click(); await w();
  // skills verify
  await f.locator('.tab', { hasText: 'Skills' }).click(); await w();
  await f.locator('.act', { hasText: 'langfuse' }).first().click(); await w();
  await f.locator('.key', { hasText: 'Check installation' }).click(); await w();
  out.verified = await f.locator('text=/Verified on this MacBook/').count();
  out.langfuseReady = await f.locator('.meta:has-text("Ready")').count() > 0;
  // phone preview prepare handoff
  await f.locator('.hwkey', { hasText: 'More' }).click(); await w();
  await f.locator('.rowbtn', { hasText: 'Preview' }).click(); await w();
  await f.locator('.hw .key', { hasText: 'Prepare handoff' }).last().click(); await w();
  out.phoneHandoff = await f.locator('.hw .pre:has-text("JEFF handoff")').count();
  await page.screenshot({ path: 'pw-resume.png' });
  out.errors = errors; console.log(JSON.stringify(out, null, 2)); await browser.close();
})().catch(e => { console.error('FAIL', e.message.split('\n')[0]); console.error(JSON.stringify(out, null, 2)); process.exit(1); });
