const { chromium } = require('/Users/neerajgopalakrishnan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1900, height: 1150 } });
  await page.goto('http://localhost:8765/jeff-companion.html');
  await page.getByRole('button', { name: 'Play interactive artboard' }).click();
  await page.waitForTimeout(1500);
  const f = page.frames().find(fr => fr !== page.mainFrame() && fr.url().startsWith('about:')) || page.frames()[1];
  await f.locator('.hw').first().waitFor();
  await f.locator('.tab', { hasText: 'Book' }).click(); await page.waitForTimeout(250);
  const row = f;
  await row.locator('span.act:has-text("History")').nth(1).click(); await page.waitForTimeout(250);
  console.log(JSON.stringify({ superseded: await f.locator('text=/Rev 1 · superseded/').count(), current: await f.locator('text=/Rev 2 · current/').count() }));
  await f.locator('.tab', { hasText: 'Book' }).click();
  await page.screenshot({ path: 'pw-book.png', clip: { x: 130, y: 149, width: 1640, height: 900 } });
  await browser.close();
})().catch(e => { console.error('FAIL', e.message.split('\n')[0]); process.exit(1); });
