const { chromium } = require('/Users/neerajgopalakrishnan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1900, height: 1150 } });
  const errors = []; page.on('pageerror', e => errors.push('page: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto('http://localhost:8765/jeff-companion.html');
  await page.getByRole('button', { name: 'Play interactive artboard' }).click();
  await page.waitForTimeout(1500);
  const f = page.frames().find(fr => fr !== page.mainFrame() && fr.url().startsWith('about:'))
         || page.frames()[1];
  const art = f.locator('.hw').first();
  await art.waitFor({ timeout: 10000 });
  const out = {}; globalThis.__out = out;
  out.initialCount = await f.locator('text=/SAVED · EXPLICIT/').first().textContent();
  // 1. phone: read-only note visible, allow saves
  out.noteBefore = await f.locator('text=/can.t write in it yet/').count();
  await f.locator('text=Allow saves').first().click();
  await page.waitForTimeout(200);
  out.noteAfter = await f.locator('text=/can.t write in it yet/').count();
  // 2. phone: write a line + Enter
  const pinput = f.locator('input.line.small');
  await pinput.click(); await pinput.fill('Test line from the phone'); await pinput.press('Enter');
  await page.waitForTimeout(300);
  out.countAfterSave = await f.locator('text=/SAVED · EXPLICIT/').first().textContent();
  out.phoneFirstEntry = (await f.locator('.entry .words').first().textContent()).trim();
  out.laptopLatest = (await f.locator('text=/Test line from the phone/').count());
  // 3. laptop: open Book tab, correct first entry
  await f.locator('.tab', { hasText: 'Book' }).click();
  await page.waitForTimeout(300);
  out.bookVisible = await f.locator('h1', { hasText: 'The book.' }).count();
  await f.locator('span.act', { hasText: 'Correct' }).first().click();
  await page.waitForTimeout(200);
  const einput = f.locator('input.line').nth(1);
  await einput.fill('Corrected line from the laptop'); await einput.press('Enter');
  await page.waitForTimeout(300);
  out.strikeCount = await f.locator('.strike').count();
  out.correctedText = (await f.locator('text=/Corrected line from the laptop/').count());
  // 4. laptop: apps tab, toggle chatgpt read
  await f.locator('.tab', { hasText: 'Apps' }).click();
  await page.waitForTimeout(300);
  out.switchesOnBefore = await f.locator('.sw.on').count();
  await f.locator('.sw').last().click();
  await page.waitForTimeout(200);
  out.switchesOnAfter = await f.locator('.sw.on').count();
  // 5. resume on Left off
  await f.locator('.tab', { hasText: 'Left off' }).click();
  await page.waitForTimeout(300);
  await f.locator('text=Resume here').first().click();
  await page.waitForTimeout(200);
  out.resumed = await f.locator('text=/Opened here/').count();
  await page.screenshot({ path: 'pw-after.png' });
  out.errors = errors;
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch(e => { console.error("FAIL", e.message); console.error(JSON.stringify(globalThis.__out||{}, null, 2)); process.exit(1); });
