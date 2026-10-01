// Optional integration check: uses an existing Playwright installation and Chrome for Testing.
// All SEM responses are local fixtures. No live SEO queries or account access.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readRenderedPage } from "../src/platforms/sem/keyword-magic/collector.js";
import { researchKey, parseBatches } from "../src/platforms/sem/keyword-magic/core.js";
import { PRESET_ROOTS } from "../src/platforms/sem/keyword-magic/root-library.js";
import { clickNativeExport } from "../src/platforms/sem/keyword-magic/native-export.js";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, "output/playwright");
const extension = join(output, "extension");
const profile = join(output, `profile-${Date.now()}`);
const downloadsDir = join(profile, "downloads");
await mkdir(extension, { recursive: true });
await mkdir(join(profile, "Default"), { recursive: true });
await mkdir(downloadsDir, { recursive: true });
await writeFile(join(profile, "Default/Preferences"), JSON.stringify({ download: { default_directory: downloadsDir, prompt_for_download: false, directory_upgrade: true } }));
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
// Grant only the production optional host up front in the isolated test copy.
manifest.host_permissions = manifest.optional_host_permissions;
manifest.permissions.push(...manifest.optional_permissions);
manifest.optional_permissions = [];
await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest));
await cp(join(root, "src"), join(extension, "src"), { recursive: true });
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_EXECUTABLE || undefined,
  headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--host-resolver-rules=MAP sem.3ue.co 127.0.0.1, MAP dash.3ue.co 127.0.0.1"],
  viewport: { width: 380, height: 900 },
  acceptDownloads: true,
});
const errors = [];
context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
const escape = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const exportRequests = [];
const nativeDownloads = [];
const researchRequests = [];
const emptyRoots = new Set();
function fixture(root) {
  const empty = emptyRoots.has(root);
  return `<!doctype html><meta charset="utf-8"><title>本地模拟 SEM 表格</title>
    ${empty ? '<aside>未找到任何数据.</aside>' : '<p>所有关键词: 10 总搜索量: 579,300 平均 KD: 22%</p>'}
    <table><thead><tr><th></th><th>关键词</th><th>意图</th><th>搜索量</th><th>KD</th><th>CPC (USD)</th></tr></thead>
    <tbody>${empty ? '' : `<tr><td></td><td><a>${escape(root)} example one</a></td><td>I</td><td>110,000</td><td>24</td><td>0.15</td></tr>
    <tr><td></td><td><a>${escape(root)} example two</a></td><td>T</td><td>33.1K</td><td>17</td><td>0</td></tr>`}</tbody></table>
    ${empty ? '<section id="empty-results"><h3>未找到任何数据</h3><p>Try changing your filters.</p><button>Clear filters</button></section>' : ''}
    <button aria-label="导出" ${empty ? 'disabled' : ''} onclick="document.getElementById('native-menu').hidden=false">↥</button>
    <div id="native-menu" role="dialog" hidden><strong>导出数据</strong>
      <label><input type="radio" name="scope" value="all">所有 (10)</label>
      <label><input type="radio" name="scope" value="group">此分组</label>
      <label><input type="radio" name="scope" value="selected" checked>已选定 (1)</label>
      <label><input type="checkbox">保持分组</label>
      <button onclick="nativeDownload('XLSX')">XLSX</button>
      <button onclick="nativeDownload('CSV')">CSV</button>
      <button onclick="nativeDownload('CSV Semicolon')">CSV Semicolon</button>
    </div>
    <script>
      async function nativeDownload(format) {
        const url = new URL('/native-export', location.origin);
        url.searchParams.set('q', new URL(location.href).searchParams.get('q'));
        url.searchParams.set('scope', document.querySelector('input[name=scope]:checked').value);
        url.searchParams.set('format', format);
        const response = await fetch(url);
        const link = document.createElement('a'); link.href = URL.createObjectURL(await response.blob());
        link.download = 'sem-' + url.searchParams.get('q') + (format === 'XLSX' ? '.xlsx' : '.csv');
        document.body.append(link); link.click(); link.remove();
        document.getElementById('native-menu').hidden=true;
      }
    </script>`;
}
try {
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === "chrome-extension:") return route.continue();
    if (url.origin !== "https://sem.3ue.co") return route.abort();
    if (url.pathname === "/native-export") {
      const root = url.searchParams.get("q");
      const format = url.searchParams.get("format");
      exportRequests.push({ root, format, scope: url.searchParams.get("scope") });
      const separator = format === "CSV Semicolon" ? ";" : ",";
      const body = format === "XLSX" ? "NATIVE-XLSX-FIXTURE"
        : `Keyword${separator}Volume\r\n${root} example one${separator}110000\r\n${root} native-only row${separator}74000\r\n`;
      return route.fulfill({
        headers: { "Content-Type": format === "XLSX" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv", "Content-Disposition": `attachment; filename="sem-${root}.${format === "XLSX" ? "xlsx" : "csv"}"` },
        body,
      });
    }
    researchRequests.push(url.href);
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: fixture(url.searchParams.get("q") || "checker") });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  await worker.evaluate(() => {
    globalThis.testDownloads = [];
    chrome.downloads.onCreated.addListener((item) => globalThis.testDownloads.push(item));
  });
  const id = new URL(worker.url()).hostname;
  const panel = await context.newPage();
  // Use Chrome's normal target selection, including extension subfolders. Playwright's
  // allowAndName override bypasses that selection and assigns UUID filenames.
  const cdp = await context.newCDPSession(panel);
  await cdp.send("Browser.setDownloadBehavior", { behavior: "default", eventsEnabled: true });
  await panel.goto(`chrome-extension://${id}/${manifest.side_panel.default_path}`);
  await panel.getByRole("link", { name: "词根研究", exact: true }).click();
  await panel.locator("#filter-description").filter({ hasText: "30,000" }).waitFor();
  await panel.getByRole("button", { name: "全部功能", exact: true }).click();
  await panel.getByRole("link", { name: "词根研究", exact: true }).click();
  const queryPage = await context.newPage();
  queryPage.on("download", (download) => nativeDownloads.push(download));
  await queryPage.bringToFront();
  const fixtureTabId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
  // Browser-created targets can navigate before Playwright attaches. Use an attached
  // target for deterministic offline routing; all updates and injections remain real.
  const useFixtureTab = () => panel.evaluate((tabId) => {
    window.originalCreate ||= chrome.tabs.create.bind(chrome.tabs);
    chrome.tabs.create = (options) => chrome.tabs.update(tabId, options);
    const originalQuery = chrome.tabs.query.bind(chrome.tabs);
    // A native side panel does not become the active tab; emulate that here.
    chrome.tabs.query = (options) => options.active && options.currentWindow
      ? chrome.tabs.get(tabId).then((tab) => [tab]) : originalQuery(options);
  }, fixtureTabId);
  const expand = async (id) => {
    if (!await panel.locator(`#${id}`).evaluate((node) => node.open)) await panel.locator(`#${id} > summary`).click();
  };
  const setRoots = async (text) => {
    await expand("root-editor");
    await panel.locator("#roots").fill(text);
    await panel.locator("#apply-roots").click();
    await panel.waitForFunction(() => !document.getElementById("root-editor").open);
  };
  await useFixtureTab();
  await panel.locator("#filter-description").filter({ hasText: "30,000" }).waitFor();
  assert.equal(await panel.locator("#start, #stop, #capture-current, #clear-exported, #next-batch, #status, #range-start, #range-count, #select-all").count(), 0);
  const readState = () => panel.evaluate(async () => (await chrome.storage.local.get("seoHelper")).seoHelper);
  const downloadRecords = async () => Object.values((await readState()).exports);
  const selectedLine = () => panel.locator('#root-list li[data-selected="true"] .root-link').textContent();
  const choose = async (index) => {
    await panel.locator("#root-list .root-link").nth(index).click();
    await panel.locator("#range-description").filter({ hasText: `第 ${index + 1} /` }).waitFor();
  };
  const exportBatch = async (count) => {
    await panel.locator("#export-batch").click();
    await panel.locator("#export-scope").filter({ hasText: "正在原生导出" }).waitFor();
    assert.equal(await panel.locator("#feature-home").isDisabled(), true);
    await panel.locator("#export-scope").filter({ hasText: `已完成 ${count} 个词根的原生导出` }).waitFor({ timeout: 30000 });
  };
  const input = "checker,calculator\ntranslator,ai writer\nchecker";
  await setRoots(input);
  assert.equal(await panel.locator("#root-list li").count(), 3);
  assert.equal(await selectedLine(), "checker, calculator");
  assert.equal(await panel.locator("#results details").count(), 2);
  assert.equal((await readState()).config.roots, "checker, calculator\ntranslator, ai writer\nchecker");
  // Preset/custom library changes are independent of the research list and survive reload.
  const beforeLibrary = await readState();
  assert.equal(beforeLibrary.rootLibrary.length, 51);
  await expand("root-library");
  await panel.locator("#library-search").fill("翻译器");
  assert.equal(await panel.locator("#library-list li").count(), 1);
  await panel.locator('#library-list input[value="Translator"]').check();
  await panel.locator("#library-search").fill("生成器");
  await panel.locator('#library-list input[value="Generator"]').check();
  assert.equal(await panel.locator("#library-selection-count").textContent(), "已选 2 个");
  await panel.locator("#library-import").click();
  await panel.locator("#export-scope").filter({ hasText: "已加入 1 个词根" }).waitFor();
  assert.equal(await selectedLine(), "Generator"); // Translator was already present, with different casing.
  assert.equal((await readState()).config.roots, `${beforeLibrary.config.roots}\nGenerator`);
  await expand("root-editor");
  await panel.locator("#roots").fill("");
  await panel.locator("#apply-roots").click();
  await panel.waitForFunction(() => document.querySelectorAll("#root-list li").length === 0);
  await expand("root-library");
  await panel.locator("#library-search").fill("");
  await panel.locator("#library-select-all").click();
  assert.equal(await panel.locator("#library-selection-count").textContent(), "已选 51 个");
  await panel.locator("#library-import").click();
  await panel.locator("#export-scope").filter({ hasText: "已加入 51 个词根，生成 11 批" }).waitFor();
  const importedGroups = parseBatches((await readState()).config.roots);
  assert.deepEqual(importedGroups.flat(), PRESET_ROOTS.map((item) => item.root));
  assert.equal(await panel.locator("#root-list li").count(), 11);
  await expand("root-library");
  await panel.locator("main").evaluate(node => { node.scrollTop += document.getElementById("root-library").getBoundingClientRect().top - node.getBoundingClientRect().top - 16; });
  await panel.screenshot({ path: join(output, "sidepanel-root-library.png"), fullPage: true });
  await panel.setViewportSize({ width: 300, height: 800 });
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await panel.locator("#library-list").evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await panel.screenshot({ path: join(output, "sidepanel-root-library-narrow.png"), fullPage: true });
  await panel.setViewportSize({ width: 380, height: 900 });
  await panel.locator("#library-add-input").fill("Summarizer, AI writer, summarizer, checker");
  await panel.locator("#library-add").click();
  await panel.locator("#export-scope").filter({ hasText: "已添加 2 个词根到词库" }).waitFor();
  assert.equal((await readState()).rootLibrary.length, 53);
  assert.equal(await panel.locator("#library-selection-count").textContent(), "已选 2 个");
  await panel.locator("#library-import").click();
  await panel.locator("#export-scope").filter({ hasText: "已加入 2 个词根" }).waitFor();
  assert.equal(await selectedLine(), "Summarizer, AI writer");
  await expand("root-library");
  await panel.getByRole("button", { name: "从词根库删除 Translator", exact: true }).click();
  await panel.locator("#export-scope").filter({ hasText: "已从词根库删除「Translator」" }).waitFor();
  await panel.getByRole("button", { name: "从词根库删除 Summarizer", exact: true }).click();
  await panel.locator("#export-scope").filter({ hasText: "已从词根库删除「Summarizer」" }).waitFor();
  assert.ok(parseBatches((await readState()).config.roots).flat().includes("Translator"));
  assert.ok(parseBatches((await readState()).config.roots).flat().includes("Summarizer"));
  await panel.reload();
  await useFixtureTab();
  await expand("root-library");
  assert.equal(await panel.locator("#library-list li").count(), 51);
  assert.equal(await panel.locator('#library-list input[value="Translator"], #library-list input[value="Summarizer"]').count(), 0);
  assert.equal(await panel.locator('#library-list input[value="AI writer"]').count(), 1);
  const beforeFailedLibrary = await readState();
  await panel.evaluate(() => { window.savedSet = chrome.storage.local.set.bind(chrome.storage.local); chrome.storage.local.set = async () => { throw new Error("simulated quota"); }; });
  await panel.locator("#library-add-input").fill("NotSavedRoot");
  await panel.locator("#library-add").click();
  await panel.locator("#export-scope").filter({ hasText: "本机进度保存失败" }).waitFor();
  assert.deepEqual(await readState(), beforeFailedLibrary);
  await panel.evaluate(() => { chrome.storage.local.set = window.savedSet; });
  await panel.evaluate(async () => { const { seoHelper } = await chrome.storage.local.get("seoHelper"); await chrome.storage.local.set({ seoHelper: { ...seoHelper, rootLibrary: [] } }); });
  await panel.reload();
  await useFixtureTab();
  await expand("root-library");
  assert.equal(await panel.locator("#library-list li").count(), 0); // Never reseed a library the user emptied.
  await panel.locator("#library-add-input").fill("Restored root");
  await panel.locator("#library-add").click();
  await panel.locator("#export-scope").filter({ hasText: "已添加 1 个词根到词库" }).waitFor();
  assert.equal((await readState()).rootLibrary.length, 1);
  await panel.evaluate(value => chrome.storage.local.set({ seoHelper: value }), beforeLibrary);
  await panel.reload();
  await useFixtureTab();
  await panel.locator("#root-list li").nth(2).waitFor();
  // Named filters save only the URL settings; applying one keeps batches and downloads intact.
  const beforeTemplates = await readState();
  await expand("filter-settings");
  await panel.locator("#save-template").click();
  await panel.locator("#export-scope").filter({ hasText: "请输入 1–60" }).waitFor();
  assert.deepEqual((await readState()).templates, []);
  await panel.locator("#template-name").fill("美国 · 高搜索量低难度");
  await panel.locator("#template-url").fill(`${beforeTemplates.config.templateUrl}&page=7&__gmitm=temporary`);
  await panel.locator("#save-template").click();
  await panel.locator("#export-scope").filter({ hasText: "已保存模板" }).waitFor();
  const firstTemplate = (await readState()).templates[0];
  assert.equal(await panel.locator("#filter-template").inputValue(), firstTemplate.id);
  assert.equal(new URL(firstTemplate.url).searchParams.has("page"), false);
  assert.equal(new URL(firstTemplate.url).searchParams.has("__gmitm"), false);
  assert.equal(firstTemplate.url.split("&filter=")[1], beforeTemplates.config.templateUrl.split("&filter=")[1]);
  const custom = new URL(firstTemplate.url);
  custom.searchParams.set("db", "uk");
  custom.searchParams.delete("filter");
  await panel.locator("#template-name").fill("英国 · 全部关键词");
  await panel.locator("#template-url").fill("https://sim.3ue.co/?q=checker");
  await panel.locator("#save-template").click();
  await panel.locator("#export-scope").filter({ hasText: "目前只支持" }).waitFor();
  assert.equal((await readState()).templates.length, 1);
  await panel.locator("#template-url").fill(custom.href);
  await panel.locator("#save-template").click();
  await panel.locator("#export-scope").filter({ hasText: "已保存模板「英国" }).waitFor();
  const secondTemplate = (await readState()).templates.find((item) => item.id !== firstTemplate.id);
  await panel.locator("#filter-template").selectOption(firstTemplate.id);
  await panel.locator("#export-scope").filter({ hasText: "已使用模板「美国" }).waitFor();
  assert.equal(await panel.locator("#template-url").inputValue(), firstTemplate.url);
  assert.equal((await readState()).config.roots, beforeTemplates.config.roots);
  assert.equal((await readState()).config.batchIndex, beforeTemplates.config.batchIndex);
  assert.equal((await readState()).config.exportFolder, beforeTemplates.config.exportFolder);
  assert.equal((await readState()).config.exportFormat, beforeTemplates.config.exportFormat);
  assert.deepEqual((await readState()).exports, beforeTemplates.exports);
  await panel.reload();
  await useFixtureTab();
  await panel.locator("#filter-template option").filter({ hasText: firstTemplate.name }).waitFor({ state: "attached" });
  assert.equal(await panel.locator("#filter-template").inputValue(), firstTemplate.id);
  assert.equal((await readState()).templates.length, 2);
  await expand("filter-settings");
  // Same-name saves update explicitly; manual URL edits leave saved templates untouched.
  const revised = new URL(firstTemplate.url);
  revised.searchParams.set("db", "ca");
  await panel.locator("#template-url").fill(revised.href);
  await panel.waitForFunction(async () => (await chrome.storage.local.get("seoHelper")).seoHelper.config.filterTemplateId === "");
  assert.equal((await readState()).templates.find((item) => item.id === firstTemplate.id).url, firstTemplate.url);
  assert.equal(await panel.locator("#save-template").textContent(), "更新模板");
  await panel.locator("#save-template").click();
  await panel.locator("#export-scope").filter({ hasText: "已更新模板" }).waitFor();
  assert.equal((await readState()).templates.length, 2);
  assert.equal(new URL((await readState()).templates.find((item) => item.id === firstTemplate.id).url).searchParams.get("db"), "ca");
  await panel.locator("#filter-template").selectOption(secondTemplate.id);
  await panel.locator("#export-scope").filter({ hasText: "已使用模板「英国" }).waitFor();
  await panel.locator("#delete-template").click();
  await panel.locator("#export-scope").filter({ hasText: "已删除模板" }).waitFor();
  assert.equal((await readState()).templates.length, 1);
  assert.equal((await readState()).config.templateUrl, secondTemplate.url);
  assert.equal(await panel.locator("#filter-template").inputValue(), "");
  await panel.locator("#filter-template").selectOption(firstTemplate.id);
  await panel.locator("#export-scope").filter({ hasText: "已使用模板「美国" }).waitFor();
  const beforeFailedTemplate = await readState();
  await panel.evaluate(() => { window.savedSet = chrome.storage.local.set.bind(chrome.storage.local); chrome.storage.local.set = async () => { throw new Error("simulated quota"); }; });
  await panel.locator("#template-name").fill("不能保存的模板");
  await panel.locator("#save-template").click();
  await panel.locator("#export-scope").filter({ hasText: "本机进度保存失败" }).waitFor();
  assert.deepEqual(await readState(), beforeFailedTemplate);
  await panel.evaluate(() => { chrome.storage.local.set = window.savedSet; });
  await panel.locator("#template-name").fill("加拿大 · 高搜索量低难度");
  await panel.locator("#save-template").click();
  await panel.locator("#export-scope").filter({ hasText: "已保存模板「加拿大" }).waitFor();
  await panel.locator("main").evaluate(node => { node.scrollTop = document.getElementById("filter-settings").offsetTop - node.offsetTop; });
  await panel.screenshot({ path: join(output, "sidepanel-filter-templates.png"), fullPage: true });
  await panel.setViewportSize({ width: 300, height: 800 });
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await panel.locator("main").evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await panel.screenshot({ path: join(output, "sidepanel-filter-templates-narrow.png"), fullPage: true });
  await panel.setViewportSize({ width: 380, height: 900 });
  await panel.evaluate(value => chrome.storage.local.set({ seoHelper: value }), beforeTemplates);
  await panel.reload();
  await useFixtureTab();
  await panel.locator("#root-list li").nth(2).waitFor();
  await panel.locator("#range-next").click();
  await panel.locator("#range-description").filter({ hasText: "第 2 / 3 批" }).waitFor();
  assert.equal(await selectedLine(), "translator, ai writer");
  await panel.locator("#range-next").click();
  await panel.locator("#range-description").filter({ hasText: "第 3 / 3 批" }).waitFor();
  assert.equal(await panel.locator("#range-next").isDisabled(), true);
  await panel.locator("#range-previous").click();
  await panel.locator("#range-description").filter({ hasText: "第 2 / 3 批" }).waitFor();
  await panel.reload();
  await useFixtureTab();
  await panel.locator("#range-description").filter({ hasText: "第 2 / 3 批" }).waitFor();
  // Tabs really open, but the initial navigation is replaced by about:blank for offline routing.
  await panel.evaluate(() => {
    window.openedLinks = [];
    chrome.tabs.create = async (options) => {
      const tab = await window.originalCreate({ url: "about:blank", active: options.active });
      window.openedLinks.push({ ...options, id: tab.id });
      return tab;
    };
  });
  await panel.locator("#open-selected").click();
  await panel.locator("#export-scope").filter({ hasText: "已在新标签页打开 2 个" }).waitFor();
  const openedLinks = await panel.evaluate(() => window.openedLinks);
  const filter = new URL((await readState()).config.templateUrl).searchParams.get("filter");
  assert.deepEqual(openedLinks.map((link) => new URL(link.url).searchParams.get("q")), ["translator", "ai writer"]);
  assert.ok(openedLinks.every((link) => link.active === false && new URL(link.url).searchParams.get("filter") === filter));
  await worker.evaluate((ids) => chrome.tabs.remove(ids), openedLinks.map((link) => link.id));
  await useFixtureTab();
  await choose(0);
  await expand("export-settings");
  await panel.locator("#export-folder").fill("SEO-Helper/项目 A");
  await exportBatch(2);
  assert.deepEqual(exportRequests.map((request) => request.root), ["checker", "calculator"]);
  assert.equal(nativeDownloads.length, 2);
  const firstFiles = await downloadRecords();
  for (const file of firstFiles) {
    assert.equal(file.path, join(downloadsDir, "SEO-Helper/项目 A", `sem-${file.root}.csv`));
    assert.equal(await readFile(file.path, "utf8"), `Keyword,Volume\r\n${file.root} example one,110000\r\n${file.root} native-only row,74000\r\n`);
  }
  assert.ok(exportRequests.every((request) => request.scope === "all"));
  assert.equal(await panel.locator("#root-list .root-state").nth(0).textContent(), "2/2");
  assert.equal(await panel.locator("#root-list .root-state").nth(2).textContent(), "0/1");
  await panel.locator("#export-batch").click();
  await panel.locator("#export-scope").filter({ hasText: "本批已全部导出" }).waitFor();
  assert.equal(nativeDownloads.length, 2);
  // A later line containing the same root is its own batch and still downloads.
  await choose(2);
  await exportBatch(1);
  assert.equal(nativeDownloads.length, 3);
  assert.equal((await downloadRecords()).filter((file) => file.root === "checker").length, 2);
  assert.equal((await downloadRecords()).at(-1).filename, "sem-checker (1).csv");
  // Keep all three native formats and the original download bytes.
  for (const format of ["XLSX", "CSV Semicolon"]) {
    await panel.locator("#export-format").selectOption(format);
    await panel.locator("#export-current").click();
    await panel.locator("#export-scope").filter({ hasText: "正在原生导出" }).waitFor();
    await panel.locator("#export-scope").filter({ hasText: "已完成 1 个词根的原生导出" }).waitFor({ timeout: 15000 });
    const file = (await downloadRecords()).at(-1);
    assert.equal(file.folder, "SEO-Helper/项目 A");
    assert.equal(exportRequests.at(-1).format, format);
    if (format === "XLSX") assert.equal(await readFile(file.path, "utf8"), "NATIVE-XLSX-FIXTURE");
    else assert.match(await readFile(file.path, "utf8"), /native-only row;74000/);
  }
  await panel.locator("#export-format").selectOption("CSV");
  await panel.locator("#export-folder").fill("SEO-Helper/项目 B");
  await exportBatch(1);
  assert.equal(nativeDownloads.length, 6);
  const lastFile = (await downloadRecords()).at(-1);
  assert.equal(lastFile.path, join(downloadsDir, "SEO-Helper/项目 B/sem-checker.csv"));
  await panel.evaluate(() => { window.revealed = []; chrome.downloads.show = (id) => { window.revealed.push(id); }; });
  await panel.locator("#results details summary").first().click();
  await panel.getByRole("button", { name: "打开所在文件夹" }).click();
  await panel.waitForFunction((id) => window.revealed.includes(id), lastFile.downloadId);
  // An individual result still has its preview action outside the removed toolbar.
  await panel.getByRole("button", { name: "读取预览", exact: true }).click();
  await panel.locator("#export-scope").filter({ hasText: "已完成 1 个词根的预览" }).waitFor({ timeout: 15000 });
  assert.equal(await panel.locator("#results tbody tr").count(), 2);
  assert.equal(Object.keys((await readState()).records).length, 1);
  await choose(1);
  await panel.locator("#export-batch").click();
  await panel.locator("#export-scope").filter({ hasText: "正在原生导出 translator" }).waitFor();
  assert.equal(await panel.locator("#range-next").isDisabled(), true);
  assert.equal(await panel.locator("#open-selected").isDisabled(), true);
  assert.equal(await panel.locator("#roots").isDisabled(), true);
  assert.equal(await panel.locator("#filter-template").isDisabled(), true);
  assert.equal(await panel.locator("#save-template").isDisabled(), true);
  assert.equal(await panel.locator("#library-add").isDisabled(), true);
  await panel.getByRole("button", { name: "停止任务", exact: true }).click();
  await panel.locator("#export-scope").filter({ hasText: "任务已停止" }).waitFor();
  assert.equal(nativeDownloads.length, 6);
  // Saving a new list is transactional: failed storage keeps the old batches and progress.
  const beforeEdit = await readState();
  await panel.evaluate(() => { window.originalSet = chrome.storage.local.set.bind(chrome.storage.local); chrome.storage.local.set = async () => { throw new Error("simulated quota"); }; });
  await expand("root-editor");
  await panel.locator("#roots").fill("new root,other");
  await panel.locator("#apply-roots").click();
  await panel.locator("#export-scope").filter({ hasText: "本机进度保存失败" }).waitFor();
  assert.equal(await panel.locator("#root-list li").count(), 3);
  assert.deepEqual(await readState(), beforeEdit);
  await panel.evaluate(() => { chrome.storage.local.set = window.originalSet; });
  await setRoots("translator,ai writer\nchecker,calculator\nchecker");
  await choose(2);
  assert.equal(await panel.locator("#progress").textContent(), "1 / 1 已导出");
  await panel.reload();
  await useFixtureTab();
  await panel.locator("#range-description").filter({ hasText: "第 3 / 3 批" }).waitFor();
  assert.equal(await selectedLine(), "checker");
  assert.equal(await panel.locator("#export-folder").inputValue(), "SEO-Helper/项目 B");
  // Removing a line removes its progress only; original files remain on disk.
  await setRoots("translator,ai writer\nchecker,calculator");
  assert.equal((await downloadRecords()).filter((file) => file.root === "checker").length, 1);
  assert.equal(Object.keys((await readState()).records).length, 0);
  for (const file of [...firstFiles, lastFile]) assert.match(await readFile(file.path, "utf8"), /native-only row/);
  await setRoots("translator,ai writer\nchecker,calculator\nchecker");
  await choose(2);
  assert.equal(await panel.locator("#progress").textContent(), "0 / 1 已导出");
  await exportBatch(1);
  assert.equal(nativeDownloads.length, 7);
  // Empty input stays empty after reopening. No stale rows occupy the list.
  await expand("root-editor");
  await panel.locator("#roots").fill("");
  await panel.locator("#apply-roots").click();
  await panel.waitForFunction(() => document.querySelectorAll("#root-list li").length === 0);
  assert.deepEqual((await readState()).exports, {});
  assert.equal(await panel.locator("#export-batch").isDisabled(), true);
  await panel.reload();
  await useFixtureTab();
  await panel.locator("#root-list-empty").waitFor();
  assert.equal(await panel.locator("#roots").inputValue(), "");
  // Existing 0.5 config keeps each stored line and its export records when migrated.
  const legacyFile = firstFiles.find((file) => file.root === "checker");
  await panel.evaluate(({ file, key }) => chrome.storage.local.set({ seoHelper: {
    config: { templateUrl: file.url, roots: "checker\ncalculator", rangeStart: 2, rangeCount: 5, settleSeconds: 3, exportFormat: "CSV", exportFolder: file.folder },
    records: {}, exports: { [key]: file },
  } }), { file: legacyFile, key: researchKey(legacyFile.url) });
  await panel.reload();
  await useFixtureTab();
  await panel.locator("#range-description").filter({ hasText: "第 2 / 2 批" }).waitFor();
  await choose(0);
  assert.equal(await panel.locator("#progress").textContent(), "1 / 1 已导出");
  assert.equal(Object.keys((await readState()).exports).length, 1);
  assert.equal((await readState()).config.rangeCount, undefined);
  // Empty SEM results must finish the job without generating a file or stopping the batch.
  for (const word of ["Recorder", "Silent", "Dormant"]) emptyRoots.add(word);
  const emptyHTML = fixture("Recorder");
  for (const [html, expected] of [
    [emptyHTML, true],
    [emptyHTML.replaceAll("未找到任何数据", "No data found"), true],
    [emptyHTML.replaceAll("未找到任何数据", "No results found"), true],
    [emptyHTML.replace('<table>', '<table aria-busy="true">'), false],
    [emptyHTML + '<div role="progressbar">Loading</div>', false],
    [emptyHTML + '<input type="password">', false],
    [emptyHTML + '<h2>Verify you are human</h2>', false],
    [emptyHTML + '<h2>加载失败</h2>', false],
    [emptyHTML.replace(/<section id="empty-results">[\s\S]*?<\/section>/, ''), false],
    [emptyHTML.replaceAll('未找到任何数据', '这里并非未找到任何数据的提示'), false],
    [emptyHTML + '<p>所有关键词: 10</p>', false],
    ['<p>所有关键词: 0</p><table><thead><tr><th>关键词</th><th>搜索量</th></tr></thead></table><button disabled>导出</button>', false],
    [fixture("Checker") + '<aside>未找到任何数据</aside><p>Try changing your filters.</p><button>Clear filters</button>', false],
  ]) {
    await queryPage.setContent(html);
    const page = await queryPage.evaluate(readRenderedPage);
    assert.equal(Boolean(page.empty && !page.busy && !page.fatal), expected, html);
  }
  const downloadsBeforeEmpty = nativeDownloads.length;
  const requestsBeforeEmpty = exportRequests.length;
  await setRoots("Recorder,Checker,Silent,Calculator,Dormant\nRecorder,Silent");
  await choose(0);
  await panel.locator("#export-batch").click();
  await panel.locator("#export-scope").filter({ hasText: "已处理 5 个词根：已导出 2 个，无结果 3 个" }).waitFor({ timeout: 45000 });
  assert.equal(nativeDownloads.length, downloadsBeforeEmpty + 2);
  assert.deepEqual(exportRequests.slice(requestsBeforeEmpty).map(item => item.root), ["Checker", "Calculator"]);
  const resultsWithEmpty = await downloadRecords();
  assert.deepEqual(["Recorder", "Checker", "Silent", "Calculator", "Dormant"].map(word => resultsWithEmpty.find(item => item.root === word).state), ["empty", "done", "empty", "done", "empty"]);
  assert.ok(resultsWithEmpty.filter(item => item.state === "empty").every(item => item.checkedAt && !item.downloadId && !item.filename && !item.path));
  assert.equal(await panel.locator("#progress").textContent(), "2 / 5 已导出 · 3 无结果");
  assert.equal(await panel.locator("#root-list .root-state").first().textContent(), "5/5 · 无结果 3");
  const recorderResult = panel.locator("#results details").first();
  await recorderResult.locator("summary").click();
  assert.equal(await recorderResult.getByRole("button", { name: "打开所在文件夹" }).count(), 0);
  await panel.locator("main").evaluate(node => { node.scrollTop = document.getElementById("results-heading").offsetTop - node.offsetTop; });
  await panel.screenshot({ path: join(output, "sidepanel-empty-results.png"), fullPage: true });
  await panel.setViewportSize({ width: 300, height: 800 });
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await panel.locator("#root-list").evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await panel.setViewportSize({ width: 380, height: 900 });
  await choose(1);
  await panel.locator("#export-batch").click();
  await panel.locator("#export-scope").filter({ hasText: "已处理 2 个词根：已导出 0 个，无结果 2 个" }).waitFor({ timeout: 25000 });
  await panel.reload();
  await useFixtureTab();
  await panel.locator("#progress").filter({ hasText: "0 / 2 已导出 · 2 无结果" }).waitFor();
  const checkedCount = researchRequests.length;
  await panel.locator("#export-batch").click();
  await panel.locator("#export-scope").filter({ hasText: "本批已全部处理" }).waitFor();
  assert.equal(researchRequests.length, checkedCount);
  // The current-page action and preview share empty detection.
  await panel.locator("#export-current").click();
  await panel.locator("#export-scope").filter({ hasText: "已处理 1 个词根：已导出 0 个，无结果 1 个" }).waitFor({ timeout: 15000 });
  await recorderResult.locator("summary").click();
  await recorderResult.getByRole("button", { name: "读取预览" }).click();
  await panel.locator("#export-scope").filter({ hasText: "已完成 1 个词根的预览" }).waitFor({ timeout: 15000 });
  assert.equal(Object.values((await readState()).records).at(-1).empty, true);
  assert.equal(nativeDownloads.length, downloadsBeforeEmpty + 2);
  // A new filter must not reuse an old empty result.
  await expand("filter-settings");
  const changedFilter = new URL((await readState()).config.templateUrl);
  changedFilter.searchParams.set("db", "au");
  await panel.locator("#template-url").fill(changedFilter.href);
  await panel.locator("#progress").filter({ hasText: "0 / 2 已导出" }).waitFor();
  await panel.waitForFunction(() => document.getElementById("progress").textContent === "0 / 2 已导出");
  await panel.locator("#export-batch").click();
  await panel.locator("#export-scope").filter({ hasText: "已处理 2 个词根：已导出 0 个，无结果 2 个" }).waitFor({ timeout: 25000 });
  assert.equal(researchRequests.length, checkedCount + 3); // One preview and two new-filter queries; current export never navigates.
  // A forced individual recheck can download data that appeared after an empty result.
  emptyRoots.delete("Recorder");
  await recorderResult.locator("summary").click();
  await recorderResult.getByRole("button", { name: "原生导出", exact: true }).click();
  await panel.locator("#export-scope").filter({ hasText: "已完成 1 个词根的原生导出" }).waitFor({ timeout: 15000 });
  assert.equal(await panel.locator("#progress").textContent(), "1 / 2 已导出 · 1 无结果");
  assert.equal(nativeDownloads.length, downloadsBeforeEmpty + 3);
  // A successful new preview also invalidates an earlier empty export record.
  emptyRoots.delete("Silent");
  const silentResult = panel.locator("#results details").nth(1);
  await silentResult.locator("summary").click();
  await silentResult.getByRole("button", { name: "读取预览" }).click();
  await panel.locator("#export-scope").filter({ hasText: "已完成 1 个词根的预览" }).waitFor({ timeout: 15000 });
  assert.equal(await panel.locator("#progress").textContent(), "1 / 2 已导出");
  // Unsupported preview markup does not stop the native export path.
  await queryPage.locator("table").evaluate(node => node.remove());
  await panel.locator("#export-current").click();
  await panel.locator("#export-scope").filter({ hasText: "已完成 1 个词根的原生导出" }).waitFor({ timeout: 15000 });
  assert.equal(await panel.locator("#progress").textContent(), "2 / 2 已导出");
  // Long multi-root lines remain readable in a narrow side panel.
  await setRoots("Translator,Generator,Example,Convert,Online\nDownloader,Maker,Creator,Editor,Processor\nAnalyzer,Designer,Compiler,Evaluator,Scheduler\nChecker,Detector,Scraper,Manager,Explorer\nDashboard,Planner,Tracker,Recorder,Optimizer\nResponder");
  await choose(3);
  await panel.locator("main").evaluate((node) => { node.scrollTop += document.querySelector(".root-heading").getBoundingClientRect().top - node.getBoundingClientRect().top - 16; });
  await panel.screenshot({ path: join(output, "sidepanel-line-batches.png"), fullPage: true });
  await panel.setViewportSize({ width: 300, height: 800 });
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await panel.locator("#root-list").evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await panel.screenshot({ path: join(output, "sidepanel-line-batches-narrow.png"), fullPage: true });
  await expand("export-settings");
  await panel.locator("#download-settings").click();
  await queryPage.waitForURL("chrome://settings/downloads");
  await panel.locator("#export-scope").filter({ hasText: "全局下载设置" }).waitFor();
  assert.deepEqual(errors, []);
  console.log("PASS: empty SEM results (mixed/all-empty batches, reload/retry/new filters, current export, preview, loading/login/error guards), all 51 preset roots, library editing/persistence, saved filters, native exports and narrow layout. All SEM responses mocked.");
} catch (error) {
  for (const page of context.pages()) {
    console.error(JSON.stringify({ url: page.url(), text: (await page.locator("body").innerText().catch(() => "unavailable")).slice(0, 4000) }));
  }
  console.error("Page errors:", errors);
  console.error("Native requests:", exportRequests, "Playwright downloads:", nativeDownloads.map((item) => item.suggestedFilename()));
  const worker = context.serviceWorkers()[0];
  if (worker) console.error("Test browser download events:", await worker.evaluate(() => globalThis.testDownloads));
  throw error;
} finally {
  await context.close();
}
