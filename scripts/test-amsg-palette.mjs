import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = 'output/amsg-palette';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.QA_BROWSER_PATH ? { executablePath: process.env.QA_BROWSER_PATH } : {}) });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' || route.request().url().startsWith('data:') ? route.continue() : route.abort());
const toggle = enabled => page.evaluate(value => { if (value) document.documentElement.dataset.paperUiStyle = 'sage-cream'; else delete document.documentElement.dataset.paperUiStyle; }, enabled);
const color = locator => locator.evaluate(element => getComputedStyle(element).backgroundColor);
const background = locator => locator.evaluate(element => getComputedStyle(element).background);
try {
  await page.goto(`${process.env.SAR_QA_URL || 'http://127.0.0.1:5186'}/test/fixtures/amsg-settings.html?platform=apk`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.getByRole('button', { name: /^主动消息 2.0/ }).click({ timeout: 120000 });
  const detail = page.getByRole('dialog', { name: '主动消息 2.0', exact: true });
  await detail.waitFor();
  const original = await background(detail);
  await toggle(true);
  assert.match(await background(detail), /rgb\(251, 248, 240\)/);
  for (const name of ['功能总览', '通知与设备', '功能设置']) {
    await detail.getByRole('tab', { name, exact: true }).click();
    assert.match(await background(detail), /rgb\(251, 248, 240\)/);
    await page.screenshot({ path: `${out}/${name}.png`, animations: 'disabled' });
  }
  await detail.getByRole('tab', { name: '功能总览', exact: true }).click();
  await detail.getByRole('button', { name: '配置 林 的主动消息', exact: true }).click();
  const character = page.getByRole('dialog', { name: '林 · 主动消息', exact: true });
  await character.waitFor();
  assert.match(await background(character), /rgb\(251, 248, 240\)/);
  assert.equal(await color(character.getByRole('switch', { name: '角色主动消息', exact: true })), 'rgb(130, 150, 108)');
  await page.screenshot({ path: `${out}/character.png`, animations: 'disabled' });
  await character.getByRole('button', { name: '调整', exact: true }).click();
  const pacing = page.getByRole('dialog', { name: '主动频率', exact: true });
  await pacing.waitFor();
  assert.match(await background(pacing), /rgb\(251, 248, 240\)/);
  await page.screenshot({ path: `${out}/pacing.png`, animations: 'disabled' });
  await pacing.getByRole('button', { name: '返回上一级', exact: true }).click();
  await character.getByRole('button', { name: '返回上一级', exact: true }).click();
  await toggle(false);
  assert.equal(await background(detail), original);
  assert.deepEqual(errors, []);
  console.log('PASS: sage palette across all main tabs, character settings and pacing; original palette restored');
} catch (error) {
  await page.screenshot({ path: `${out}/failure.png` });
  console.error((await page.locator('body').innerText()).slice(0, 2200));
  throw error;
} finally { await browser.close(); }
