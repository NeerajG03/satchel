const { chromium } = require('playwright');
const out = {};
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1900, height: 1150 } });
  const errors = []; page.on('pageerror', e => errors.push('page: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto('http://localhost:8765/jeff-companion.html');
  await page.getByRole('button', { name: 'Play interactive artboard' }).click();
  await page.waitForTimeout(1500);
  const f = page.frames().find(fr => fr !== page.mainFrame() && fr.url().startsWith('about:')) || page.frames()[1];
  await f.locator('.hw').first().waitFor({ timeout: 10000 });
  const tab = async (n) => { await f.locator('.tab', { hasText: n }).click(); await page.waitForTimeout(250); };
  const txt = async (sel) => (await f.locator(sel).first().textContent()).trim();
  // Book: scope picker + search + filter + history + forget
  await tab('Book');
  await f.locator('.chip', { hasText: 'Repo / frontend' }).first().click();
  const li = f.locator('input.line').first(); await li.fill('Laptop line'); await li.press('Enter'); await page.waitForTimeout(250);
  out.newScope = await txt('.lbl:has-text("Repo / frontend")');
  await f.locator('input.search').fill('bank'); await page.waitForTimeout(250);
  out.searchCount = await f.locator('.words:has-text("bank")').count();
  await f.locator('input.search').fill(''); await page.waitForTimeout(200);
  await f.locator('.chip', { hasText: 'Repos' }).first().click(); await page.waitForTimeout(200);
  out.repoFilterRows = await f.locator('.lbl:has-text("Repo /")').count();
  await f.locator('.chip', { hasText: 'All' }).first().click(); await page.waitForTimeout(200);
  await f.locator('span.act', { hasText: 'History' }).nth(1).click(); await page.waitForTimeout(200);
  out.historyOpen = await f.locator('text=/superseded/').count();
  await f.locator('span.act', { hasText: 'Forget' }).first().click(); await page.waitForTimeout(200);
  out.forgetPrompt = await f.locator('text=/Forget this line/').count();
  await f.locator('.key', { hasText: 'Forget' }).first().click(); await page.waitForTimeout(250);
  out.afterForget = await txt('text=/IN THE BOOK/');
  out.forgotNote = await f.locator('text=/left the book/').count();
  // Projects: add
  await tab('Projects');
  out.projectRows = await f.locator('text=/lines in the book/').count();
  const pi = f.locator('input.line').first(); await pi.fill('Hermes'); await f.locator('.chip', { hasText: 'Work' }).first().click(); await pi.press('Enter'); await page.waitForTimeout(250);
  out.projectRowsAfter = await f.locator('text=/lines in the book/').count();
  await f.locator('.key', { hasText: 'Preview' }).first().click(); await page.waitForTimeout(250);
  out.previewFromProject = await txt('h1');
  // Preview: switch app to ChatGPT (read off) -> blocked; prepare handoff
  await f.locator('.chip', { hasText: 'ChatGPT' }).first().click(); await page.waitForTimeout(200);
  out.previewBlocked = await f.locator('text=/can.t read the book yet/').count();
  await f.locator('.chip', { hasText: 'Codex' }).first().click(); await page.waitForTimeout(200);
  await f.locator('.key', { hasText: 'Prepare handoff' }).click(); await page.waitForTimeout(200);
  out.handoffText = await f.locator('.pre').count();
  // Apps: check fails while phone read-only, passes after allow
  await tab('Apps');
  await f.locator('.key', { hasText: 'Run the check' }).first().click(); await page.waitForTimeout(200);
  out.checkFirst = await txt('text=/Fix the amber|Handoff works/');
  await f.locator('.sw').nth(3).click(); await page.waitForTimeout(200); // claude save
  await f.locator('.key', { hasText: 'Run the check' }).first().click(); await page.waitForTimeout(200);
  out.checkSecond = await txt('text=/Fix the amber|Handoff works/');
  // Skills: select langfuse
  await tab('Skills');
  await f.locator('.act', { hasText: 'langfuse' }).first().click(); await page.waitForTimeout(200);
  out.skillDetail = await f.locator('.pre:has-text("npx skills add")').count();
  // Settings: offline -> save fails on phone and laptop; export
  await tab('Settings');
  await f.locator('.key', { hasText: 'Export the book' }).click(); await page.waitForTimeout(200);
  out.exportShown = await f.locator('.pre:has-text("jeff export")').count();
  await f.locator('.sw.on').last().click(); await page.waitForTimeout(200); // online toggle (last on switch in settings pane)
  out.offlineText = await txt('text=/Reachable|Unreachable/');
  const pin = f.locator('input.line.small'); await pin.fill('phone while offline'); await pin.press('Enter'); await page.waitForTimeout(250);
  out.phoneFail = await f.locator('text=/Couldn.t reach/').count();
  out.phoneDraftKept = await pin.inputValue();
  // Phone More -> Skills -> Preview
  await f.locator('.hwkey', { hasText: 'More' }).click(); await page.waitForTimeout(200);
  await f.locator('.rowbtn', { hasText: 'Skills' }).click(); await page.waitForTimeout(200);
  await f.locator('.hw .act', { hasText: 'mongodb' }).last().click(); await page.waitForTimeout(200);
  out.phoneSkillNote = await f.locator('text=/runs on your MacBook/').count();
  await f.locator('.hwkey', { hasText: 'More' }).click(); await page.waitForTimeout(200);
  await f.locator('.rowbtn', { hasText: 'Preview' }).click(); await page.waitForTimeout(200);
  out.phonePreviewOffline = await f.locator('text=/Unavailable/').count();
  await page.screenshot({ path: 'pw-after2.png' });
  out.errors = errors;
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch(e => { console.error('FAIL', e.message.split('\n')[0]); console.error(JSON.stringify(out, null, 2)); process.exit(1); });
