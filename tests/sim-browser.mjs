// Isolated extension fixture: no live SIM account or downloads.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_URL, STORAGE_KEY, keywordUrl } from "../src/platforms/sim/keyword-generator/core.js";
import { readRenderedPage } from "../src/platforms/sim/keyword-generator/collector.js";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'output/sim');
const extension = join(output, 'extension');
await mkdir(extension, { recursive: true });
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['https://sim.3ue.co/*'];
await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
await cp(join(root, 'src'), join(extension, 'src'), { recursive: true });
const context = await chromium.launchPersistentContext(join(output, `profile-${Date.now()}`), {
  executablePath: process.env.CHROME_EXECUTABLE || undefined, headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--host-resolver-rules=MAP sim.3ue.co 127.0.0.1'],
  viewport: { width: 380, height: 900 },
});
const errors = [];
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
try {
  await context.route('https://sim.3ue.co/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><title>SIM fixture</title>
    <table><thead><tr><th></th><th>关键词 (60)</th><th>28 天的体量</th><th>平均体量</th><th>KD</th><th>CPC</th></tr></thead><tbody></tbody></table>
    <script>
      const word = new URLSearchParams(location.hash.split('?')[1]).get('keyword');
      const tbody = document.querySelector('tbody');
      if (word === 'Empty') { document.querySelectorAll('th')[1].textContent = '关键词 (0)'; const p = document.createElement('p'); p.textContent = '未找到任何数据'; document.body.append(p); }
      else { const row = document.createElement('tr'); for (const value of ['', word + ' example', '1.4M', '1.6M', '25', '$0.14']) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); } tbody.append(row); }
    </script>` }));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/${manifest.side_panel.default_path}`);
  await panel.locator('a[href$="sim/keyword-generator/sidepanel.html"]').click();
  await panel.locator('#filter-description').filter({ hasText: '搜索量 ≥ 30,000' }).waitFor();
  assert.equal(await panel.locator('#export-current, #export-batch, #export-settings, #download-settings').count(), 0);
  assert.equal(await panel.getByRole('button', { name: /下载|导出/ }).count(), 0);
  const readState = () => panel.evaluate(async key => (await chrome.storage.local.get(key))[key], STORAGE_KEY);
  await panel.evaluate(() => chrome.storage.local.set({ seoHelper: { sentinel: 'SEM unchanged' }, 'seoHelper:google-trends:compare': { sentinel: 'Trends unchanged' } }));
  const fixturePage = await context.newPage();
  await fixturePage.goto(DEFAULT_URL);
  await fixturePage.bringToFront();
  const fixtureId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
  // A real tabs.create loads a new document. Reuse an attached target for offline
  // routing, but retain that new-document behavior even when only the hash differs.
  await panel.exposeFunction('openFixture', async options => {
    await fixturePage.goto('about:blank');
    await fixturePage.goto(options.url);
    return { id: fixtureId };
  });
  const useFixture = () => panel.evaluate(tabId => {
    chrome.tabs.create = options => window.openFixture(options);
    const originalQuery = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = options => options.active && options.currentWindow ? chrome.tabs.get(tabId).then(tab => [tab]) : originalQuery(options);
  }, fixtureId);
  await useFixture();
  const expand = async id => { if (!await panel.locator(`#${id}`).evaluate(node => node.open)) await panel.locator(`#${id} > summary`).click(); };
  const setRoots = async text => { await expand('root-editor'); await panel.locator('#roots').fill(text); await panel.locator('#apply-roots').click(); await panel.waitForFunction(() => !document.getElementById('root-editor').open); };
  await expand('root-library');
  assert.equal(await panel.locator('#library-list li').count(), 51);
  await panel.locator('#library-select-all').click();
  await panel.locator('#library-import').click();
  await panel.locator('#root-count').filter({ hasText: '11 批 · 51 词' }).waitFor();
  await setRoots('calculator, AI writer\nEmpty');
  await panel.locator('#range-previous').click();
  await panel.locator('#range-description').filter({ hasText: '第 1 / 2 批' }).waitFor();
  await expand('filter-settings');
  await panel.locator('#settle-seconds').fill('2');
  await panel.locator('#template-name').fill('全球 · 高搜索量');
  await panel.locator('#save-template').click();
  await panel.locator('#export-scope').filter({ hasText: '已保存模板' }).waitFor();
  const templateId = (await readState()).config.filterTemplateId;
  // Read the current page's hash route, then restore the saved template.
  await fixturePage.goto(DEFAULT_URL.replace('/999/28d', '/840/3m').replace('volumeFromValue=30000', 'volumeFromValue=50000'));
  await panel.locator('#use-current').click();
  await panel.locator('#filter-description').filter({ hasText: '地区 840' }).waitFor();
  assert.ok((await readState()).config.templateUrl.includes('/840/3m'));
  await panel.locator('#filter-template').selectOption(templateId);
  await panel.locator('#filter-description').filter({ hasText: '全球' }).waitFor();
  // Record actual batch opening URLs without sending new, unattached tabs to the network.
  await panel.evaluate(() => { window.opened = []; chrome.tabs.create = async options => { window.opened.push(options); return { id: 999 }; }; });
  await panel.locator('#open-selected').click();
  await panel.locator('#export-scope').filter({ hasText: '已在新标签页打开 2 个 SIM' }).waitFor();
  const opened = await panel.evaluate(() => window.opened);
  assert.deepEqual(opened.map(item => new URLSearchParams(new URL(item.url).hash.split('?')[1]).get('keyword')), ['calculator', 'AI writer']);
  assert.ok(opened.every(item => !item.active && item.url.includes('difficultyToValue=30') && item.url.includes('/999/28d')));
  await useFixture();
  await panel.evaluate(() => { window.permissionRequest = chrome.permissions.request; chrome.permissions.request = async () => false; });
  await panel.locator('#preview-batch').click();
  await panel.locator('#export-scope[data-error=true]').filter({ hasText: '需要允许读取 sim.3ue.co' }).waitFor();
  await panel.evaluate(() => { chrome.permissions.request = window.permissionRequest; });
  await panel.locator('#preview-batch').click();
  await panel.locator('#export-scope').filter({ hasText: '正在采集' }).waitFor();
  assert.equal(await panel.locator('#clear-research').isDisabled(), true);
  await panel.locator('#export-scope').filter({ hasText: '已完成 2 个词根的预览' }).waitFor({ timeout: 30000 });
  assert.equal(await panel.locator('#progress').textContent(), '2 / 2 已读取');
  const records = Object.values((await readState()).records);
  assert.deepEqual(records.map(record => record.rows[0].keyword).sort(), ['AI writer example', 'calculator example']);
  assert.equal(records[0].rows[0].volume, 1400000);
  assert.equal(records[0].rows[0].average_volume, 1600000);
  await panel.locator('#preview-batch').click();
  await panel.locator('#export-scope').filter({ hasText: '本批已全部读取' }).waitFor();
  await panel.reload();
  await useFixture();
  await panel.locator('#progress').filter({ hasText: '2 / 2 已读取' }).waitFor();
  await panel.locator('#results summary').first().click();
  await panel.locator('#results').evaluate(node => node.scrollIntoView());
  await panel.screenshot({ path: join(output, 'sim-preview.png'), fullPage: true });
  await panel.locator('#range-next').click();
  await panel.locator('#preview-batch').click();
  await panel.locator('#export-scope').filter({ hasText: '已完成 1 个词根的预览' }).waitFor({ timeout: 20000 });
  assert.equal(await panel.locator('#progress').textContent(), '0 / 1 已读取 · 1 无结果');
  const beforeReset = await readState();
  panel.once('dialog', dialog => dialog.dismiss());
  await panel.locator('#reset-batch').click();
  assert.deepEqual(await readState(), beforeReset);
  panel.once('dialog', dialog => dialog.accept());
  await panel.locator('#reset-batch').click();
  await panel.locator('#export-scope').filter({ hasText: '已清除本批记录' }).waitFor();
  assert.equal(Object.keys((await readState()).records).length, 2);
  // Save failure must not erase in-memory or persisted batches.
  const beforeClear = await readState();
  await panel.evaluate(() => { window.savedSet = chrome.storage.local.set.bind(chrome.storage.local); chrome.storage.local.set = async () => { throw Error('quota'); }; });
  panel.once('dialog', dialog => dialog.accept());
  await panel.locator('#clear-research').click();
  await panel.locator('#export-scope').filter({ hasText: '本机进度保存失败' }).waitFor();
  assert.deepEqual(await readState(), beforeClear);
  await panel.evaluate(() => { chrome.storage.local.set = window.savedSet; });
  panel.once('dialog', dialog => dialog.accept());
  await panel.locator('#clear-research').click();
  await panel.locator('#export-scope').filter({ hasText: '已清空待研究列表' }).waitFor();
  assert.deepEqual((await readState()).records, {});
  assert.deepEqual((await readState()).templates, beforeClear.templates);
  assert.deepEqual((await readState()).rootLibrary, beforeClear.rootLibrary);
  await panel.reload();
  await panel.locator('#root-count').filter({ hasText: '0 批 · 0 词' }).waitFor();
  assert.equal(await panel.locator('#preview-batch').isDisabled(), true);
  await setRoots('Translator, Generator, Example, Convert, Online\nDownloader, Maker');
  await panel.setViewportSize({ width: 300, height: 800 });
  await panel.locator('#root-list').evaluate(node => node.scrollIntoView());
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await panel.screenshot({ path: join(output, 'sim-narrow.png'), fullPage: true });
  assert.deepEqual(await panel.evaluate(async () => (await chrome.storage.local.get('seoHelper')).seoHelper), { sentinel: 'SEM unchanged' });
  assert.deepEqual(await panel.evaluate(async () => (await chrome.storage.local.get('seoHelper:google-trends:compare'))['seoHelper:google-trends:compare']), { sentinel: 'Trends unchanged' });
  assert.equal(await panel.evaluate(() => chrome.permissions.contains({ permissions: ['downloads'] })), false);
  // Collector guard: visible login, loading and an unconfirmed empty table are not success.
  await fixturePage.goto(keywordUrl(DEFAULT_URL, 'calculator'));
  await fixturePage.reload();
  await fixturePage.locator('table').waitFor();
  assert.equal((await fixturePage.evaluate(readRenderedPage)).rows.length, 1);
  await fixturePage.evaluate(() => { document.querySelector('table').setAttribute('aria-busy', 'true'); });
  assert.equal((await fixturePage.evaluate(readRenderedPage)).busy, true);
  await fixturePage.evaluate(() => { document.querySelector('table').removeAttribute('aria-busy'); document.querySelector('tbody').replaceChildren(); });
  assert.ok((await fixturePage.evaluate(readRenderedPage)).error);
  await fixturePage.evaluate(() => { const input = document.createElement('input'); input.type = 'password'; document.body.append(input); });
  assert.equal((await fixturePage.evaluate(readRenderedPage)).fatal, true);
  assert.deepEqual(errors, []);
  console.log('PASS: SIM hash filters, library, templates, batch URLs, preview/reload/empty/reset, save failure, independent storage, no downloads, narrow layout; simulated pages only.');
} catch (error) {
  for (const page of context.pages()) console.error((await page.locator('body').innerText().catch(() => '')).slice(-5000));
  console.error('Page errors:', errors);
  throw error;
} finally { await context.close(); }
