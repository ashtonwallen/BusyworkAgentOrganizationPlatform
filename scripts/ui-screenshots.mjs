/**
 * Captures full-page screenshots of every dashboard page against the dev fixture,
 * in light and dark, so interface changes can be reviewed as pictures rather than
 * by clicking through nine pages.
 *
 *   node scripts/dev-fixture.mjs          # in one terminal
 *   node scripts/ui-screenshots.mjs       # in another
 *
 * Writes to artifacts/, which is git-ignored. Reads the fixture only; it never
 * touches the live data directory.
 */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const url = process.env.HIVE_FIXTURE_URL ?? 'http://127.0.0.1:3099';
const token = process.env.HIVE_FIXTURE_TOKEN ?? 'dev-fixture-access-key-not-a-secret';
const out = 'artifacts';
const pages = [['overview', 'overview'], ['experiments', 'opportunities'], ['orders','orders'], ['work', 'work'],
  ['inbox', 'inbox'], ['finance', 'money'], ['team', 'team'], ['models', 'models'],
  ['conversations','conversations'],['documents','documents'],['email','email'], ['log', 'log'], ['settings', 'controls']];

await mkdir(out, { recursive: true });
const fixture=await fetch(new URL('/fixture-info',url)).then(response=>response.json());
if(fixture.synthetic!==true||fixture.workersStarted!==false||fixture.persistentData!==false)throw new Error('Capture requires the isolated fixture server.');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.locator('#owner-key').fill(token);
  await page.getByRole('button', { name: 'Open dashboard', exact: true }).click();
  await page.locator('#content').waitFor();

  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => { try { localStorage.setItem('hive-theme', 'classic'); localStorage.setItem('hive-mode', t); } catch { /* ignore */ } }, theme);
    await page.reload();
    await page.locator('#content').waitFor();
    await page.waitForTimeout(600);
    for (const [id, name] of pages) {
      await page.locator(`nav [data-page="${id}"]`).click();
      await page.waitForTimeout(450);
      await page.screenshot({ path: `${out}/ui-${name}-${theme}.png`, fullPage: true });
    }
  }

  // At mobile width the sidebar is an off-screen overlay, so navigate by hash
  // rather than clicking a nav button that is deliberately translated away.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { location.hash = 'overview'; });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/ui-overview-mobile.png`, fullPage: true });

  console.log(JSON.stringify({ captured: pages.length * 2 + 1, directory: out, browserErrors: errors }));
  if (errors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
