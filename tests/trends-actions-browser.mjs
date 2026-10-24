// Isolated fixtures exercise both DOM adapters; translations are explicitly synthetic.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { SETTINGS_KEY, DEFAULT_SETTINGS, TRANSLATION_PERMISSION, requestKey, comparisonKey } from "../src/platforms/google-trends/page-actions/core.js";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "output/playwright");
const extension = join(output, "trends-actions-extension");
await mkdir(extension, { recursive: true });
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
assert.deepEqual(manifest.host_permissions, ["https://trends.google.com/*", TRANSLATION_PERMISSION]);
await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest));
await cp(join(root, "src"), join(extension, "src"), { recursive: true });
// Native side-panel targets are outside Playwright's page routing. Keep their
// inner search document local; analysis-browser separately verifies provider URLs.
const analysisCorePath = join(extension, "src/platforms/google-trends/analysis/core.js");
const analysisCore = await readFile(analysisCorePath, "utf8");
await writeFile(analysisCorePath, analysisCore.replaceAll("frameUrl: frame.href", 'frameUrl: chrome.runtime.getURL("test-search.html") + "?q=" + encodeURIComponent(keyword)'));
await writeFile(join(extension, "test-search.html"), '<!doctype html><meta charset="utf-8"><p>合成搜索结果，仅用于原生侧栏测试。</p>');
// Browser-created tabs can navigate before automation attaches. Block that first
// network hop as well; all inspected documents are fulfilled by local routes.
const networkBoundary = createServer((_request, response) => { response.writeHead(502); response.end(); });
networkBoundary.on("connect", (_request, socket) => {
  socket.on("error", error => { if (error.code !== "ECONNRESET") networkBoundary.emit("error", error); });
  socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
});
await new Promise(resolve => networkBoundary.listen(0, "127.0.0.1", resolve));
const context = await chromium.launchPersistentContext(join(output, `trends-actions-profile-${Date.now()}`), {
  proxy: { server: `http://127.0.0.1:${networkBoundary.address().port}` },
  executablePath: process.env.CHROME_EXECUTABLE || undefined, headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`], viewport: { width: 1000, height: 800 },
});
const errors = [];
context.on("page", page => page.on("pageerror", error => errors.push({ url: page.url(), stack: error.stack })));
const row = (word, index = 1) => `<a class="progress-label" href="/trends/explore?q=${encodeURIComponent(word)}&date=now%207-d"><span>${index}</span><div class="label-text"><span>${word.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</span></div><span>+40%</span></a>`;
const modernRow = (word, index = 1) => `<tr><td>${index}</td><td><div><span>${word.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</span></div></td><td>50</td><td>+40%</td><td><button aria-label="更多选项">⋮</button></td></tr>`;
const modernTable = (words, id = "", topics = false) => `<table><thead><tr><th></th><th>${topics ? "主题" : "查询"}</th><th>搜索热度</th><th>变化</th><th></th></tr></thead><tbody${id ? ` id="${id}"` : ""}>${words.map((word, index) => modernRow(word, index + 1)).join("")}</tbody></table>`;
const fixture = classic => `<!doctype html><meta charset="utf-8"><title>Synthetic Trends queries</title>
  <style>body{font:16px Arial;margin:40px}.progress-label{display:flex;gap:18px;margin:8px 0;padding:12px;color:#19252c;border-bottom:1px solid #ddd}.label-text{flex:1}section{margin:35px 0}table{width:100%;border-collapse:collapse}td,th{padding:12px;border-bottom:1px solid #ddd;text-align:left}trends-widget .progress-label{height:63px;padding:0 12px;line-height:63px;overflow:hidden}trends-widget .label-text{line-height:63px;white-space:nowrap;overflow:hidden}</style>
  <p>合成测试页面，不代表 Google 实际数据或真实翻译。</p>
  ${classic ? '<trends-widget widget-name="RELATED_QUERIES"><h2>相关查询</h2><div id="queries">' + row("tangerine file converter") + row("C++ & 中文/#?", 2) + '</div></trends-widget>'
    : '<section><div>热门查询</div>' + modernTable(["tangerine file converter", "C++ & 中文/#?"], "queries") + '</section><section><div>热度上升的查询</div>' + modernTable(["converter pdf em word"]) + '</section><section id="topics"><div>热门主题</div>' + modernTable(["Topic must stay untouched"], "", true) + '</section>'}
  <trends-widget widget-name="RELATED_TOPICS"><h2>相关主题</h2>${row("Topic must stay untouched", 4)}</trends-widget>`;
try {
  await context.route("https://**/*", route => {
    if (route.request().resourceType() !== "document") return route.abort();
    const url = new URL(route.request().url());
    if (url.hostname === "trends.google.com") return route.fulfill({ contentType: "text/html", body: fixture(url.pathname.startsWith("/trends/")) });
    return route.fulfill({ contentType: "text/html", body: '<meta charset="utf-8"><p id="query">模拟结果</p>' });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const id = new URL(worker.url()).hostname;
  // Stub only the remote translation transport; production validation and message routing run unchanged.
  await worker.evaluate(() => {
    chrome.permissions.request = async () => { throw new Error("Automatic page actions must not request optional permissions"); };
    globalThis.realFetch = fetch;
    globalThis.testTranslationRequests = [];
    globalThis.testTranslationError = "";
    globalThis.fetch = async (value, options) => {
      const url = new URL(value);
      if (url.hostname !== "translate.googleapis.com") return globalThis.realFetch(value, options);
      globalThis.testTranslationRequests.push(url.href);
      if (globalThis.testTranslationError === "network") throw new Error("synthetic network failure");
      if (globalThis.testTranslationError === "http") return new Response("limited", { status: 429 });
      return Response.json([[[`合成中文：${url.searchParams.get("q")}`]]]);
    };
  });
  // A fresh install works before opening any side panel or saving any settings.
  const source = await context.newPage();
  await source.goto("https://trends.google.com/trends/explore?q=pdf&date=now%207-d&geo=US&cat=7&gprop=youtube&hl=zh-CN");
  await source.locator("#queries a").first().locator("[data-seo-helper-translation]").waitFor();
  assert.equal(await worker.evaluate(async key => (await chrome.storage.local.get(key))[key], SETTINGS_KEY), undefined);
  assert.equal((await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] }))).length, 0);
  // Old disabled switches cannot block the updated feature, including after reload.
  await worker.evaluate(async ({ key, settings }) => chrome.storage.local.set({ [key]: { ...settings, enabled: false, translate: false } }), { key: SETTINGS_KEY, settings: DEFAULT_SETTINGS });
  await source.reload();
  await source.locator("#queries a").first().locator("[data-seo-helper-translation]").waitFor();
  const panel = await context.newPage();
  const analysisUrl = `chrome-extension://${id}/src/platforms/google-trends/analysis/sidepanel.html`;
  await panel.goto(analysisUrl);
  await panel.waitForFunction(() => !document.getElementById("analyze").disabled);
  await panel.locator("#page-settings summary").click();
  assert.equal(await panel.locator("#baseline-one").inputValue(), "happy birthday images");
  assert.equal(await panel.locator("#page-enabled,#page-translate").count(), 0);
  await panel.evaluate(() => { chrome.permissions.request = async () => { throw new Error("Baseline settings must not request permissions"); }; });
  await panel.evaluate(() => { window.realSet = chrome.storage.local.set; chrome.storage.local.set = async () => { throw new Error("synthetic storage failure"); }; });
  await panel.locator("#save-settings").click();
  await panel.locator("#settings-status[data-error=true]").filter({ hasText: "synthetic storage failure" }).waitFor();
  assert.equal(await panel.locator("#baseline-one").inputValue(), "happy birthday images");
  await panel.evaluate(() => { chrome.storage.local.set = window.realSet; });
  await panel.locator("#baseline-two").fill("HAPPY BIRTHDAY IMAGES");
  await panel.locator("#save-settings").click();
  await panel.locator("#settings-status[data-error=true]").filter({ hasText: "不能相同" }).waitFor();
  await panel.locator("#baseline-two").fill("GPTs");
  await panel.locator("#save-settings").click();
  await panel.locator("#settings-status").filter({ hasText: "已保存基准词" }).waitFor();
  assert.deepEqual(await panel.evaluate(async key => (await chrome.storage.local.get(key))[key], SETTINGS_KEY), DEFAULT_SETTINGS);
  await source.locator('[data-seo-helper="trends-actions"]').waitFor();
  const sourceInfo = await worker.evaluate(async () => (await chrome.tabs.query({ url: "https://trends.google.com/*" })).find(tab => tab.url.includes("q=pdf")));
  const isolated = async (page, operation) => {
    const tab = await worker.evaluate(async url => (await chrome.tabs.query({ url: "https://trends.google.com/*" })).find(tab => tab.url === url), page.url());
    return worker.evaluate(async ({ tabId, operation }) => {
      const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: async operation => {
        if (operation === "clipboard") Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => { globalThis.testCopied = text; } } });
        if (operation === "copied") return globalThis.testCopied;
        if (operation === "denyClipboard") navigator.clipboard.writeText = async () => { throw new Error("denied"); };
        if (operation === "unsupported") delete globalThis.Translator;
      }, args: [operation] });
      return result.result;
    }, { tabId: tab.id, operation });
  };
  const toolbar = page => page.locator('[data-seo-helper="trends-actions"] #actions');
  const select = async (page, index = 0) => {
    await page.bringToFront();
    await page.locator("#queries > a, #queries > tr").nth(index).hover();
    await toolbar(page).waitFor({ state: "visible" });
  };
  await select(source);
  await isolated(source, "clipboard");
  await toolbar(source).getByRole("button", { name: "复制", exact: true }).click();
  await source.locator('[data-seo-helper="trends-actions"] #notice').filter({ hasText: "已复制" }).waitFor();
  assert.equal(await isolated(source, "copied"), "tangerine file converter");
  await isolated(source, "denyClipboard");
  await select(source);
  await toolbar(source).getByRole("button", { name: "复制", exact: true }).click();
  await source.locator('[data-seo-helper="trends-actions"] #notice[data-error=true]').filter({ hasText: "复制失败" }).waitFor();
  await source.locator('[data-seo-helper="trends-actions"] #dismiss').click();

  // A real extension message from a real click creates/reuses the comparison tab.
  await select(source);
  const firstResult = context.waitForEvent("page");
  await toolbar(source).getByRole("button", { name: "对比", exact: true }).click();
  const result = await firstResult;
  await result.waitForURL(url => url.pathname === "/explore" && url.searchParams.get("q")?.includes("tangerine"));
  const comparison = new URL(result.url());
  assert.equal(comparison.searchParams.get("q"), "happy birthday images,GPTs,tangerine file converter");
  for (const key of ["date", "geo", "cat", "gprop", "hl"]) assert.equal(comparison.searchParams.get(key), new URL(source.url()).searchParams.get(key));
  const count = context.pages().length;
  await select(source, 1);
  await toolbar(source).getByRole("button", { name: "对比", exact: true }).click();
  await result.waitForURL(url => url.searchParams.get("q")?.endsWith("C++ & 中文/#?"));
  assert.equal(context.pages().length, count);
  assert.ok(source.url().includes("/trends/explore?q=pdf"));

  // Online translation works even if the browser has no local Translator API.
  await isolated(source, "unsupported");
  await source.locator("#queries a").first().locator("[data-seo-helper-translation]").waitFor();
  assert.equal(await source.locator("#queries a").first().evaluate(node => {
    const translation = node.querySelector("[data-seo-helper-translation]").getBoundingClientRect();
    const row = node.getBoundingClientRect();
    return translation.top >= row.top && translation.bottom <= row.bottom;
  }), true);
  assert.equal(await source.getByRole("button", { name: "下载翻译模型" }).count(), 0);
  assert.equal(await source.locator('trends-widget[widget-name="RELATED_TOPICS"] [data-seo-helper-translation]').count(), 0);
  const translationCalls = () => worker.evaluate(() => globalThis.testTranslationRequests.length);
  await worker.evaluate(() => {
    globalThis.containsBeforeTranslationTest = chrome.permissions.contains;
    chrome.permissions.contains = async options => options.origins?.includes("https://translate.googleapis.com/*") ? false : globalThis.containsBeforeTranslationTest(options);
  });
  const callsBeforeDenial = await translationCalls();
  await source.evaluate(html => document.getElementById("queries").insertAdjacentHTML("beforeend", html), row("permission denied scheduler", 3));
  await source.locator('[data-seo-helper="trends-actions"] #notice').filter({ hasText: "访问 Google 翻译服务" }).waitFor();
  assert.equal(await translationCalls(), callsBeforeDenial);
  await select(source);
  assert.equal(await toolbar(source).getByRole("button").count(), 3);
  await worker.evaluate(() => { chrome.permissions.contains = globalThis.containsBeforeTranslationTest; });
  await source.locator('[data-seo-helper="trends-actions"] #retry-translation').click();
  await source.locator("#queries a").last().locator("[data-seo-helper-translation]").waitFor();
  const originalCalls = await translationCalls();
  await source.evaluate(html => document.getElementById("queries").insertAdjacentHTML("beforeend", html), row("tangerine file converter", 5));
  await source.locator("#queries a").last().locator("[data-seo-helper-translation]").waitFor();
  assert.equal(await translationCalls(), originalCalls);
  await source.locator("#queries a").first().focus();
  await source.keyboard.press("Tab");
  assert.equal(await toolbar(source).getByRole("button", { name: "复制", exact: true }).evaluate(node => node === node.getRootNode().activeElement), true);
  await source.keyboard.press("Tab");
  await source.keyboard.press("Tab");
  await source.keyboard.press("Tab");
  assert.equal(await source.locator("#queries a").nth(1).evaluate(node => node === document.activeElement), true);
  await source.keyboard.press("Escape");
  assert.equal(await toolbar(source).isVisible(), false);
  await source.screenshot({ path: join(output, "trends-actions-classic.png"), fullPage: true });

  for (const [failure, message] of [["network", "synthetic network failure"], ["http", "HTTP 429"]]) {
    await worker.evaluate(value => { globalThis.testTranslationError = value; }, failure);
    await source.evaluate(html => document.getElementById("queries").insertAdjacentHTML("beforeend", html), row(`uncached ${failure} term`, 6));
    await source.locator('[data-seo-helper="trends-actions"] #notice').filter({ hasText: message }).waitFor();
    const failedCalls = await translationCalls();
    await source.evaluate(() => document.getElementById("queries").append(document.createTextNode(" ")));
    await source.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await translationCalls(), failedCalls); // No automatic request storm after an error.
    await worker.evaluate(() => { globalThis.testTranslationError = ""; });
    await source.locator('[data-seo-helper="trends-actions"] #retry-translation').click();
    await source.locator("#queries a").last().locator("[data-seo-helper-translation]").waitFor();
  }

  await panel.evaluate(windowId => {
    globalThis.testActivityPort = chrome.runtime.connect({ name: "seoHelper:panel-activity" });
    globalThis.testActivityPort.postMessage({ windowId, busy: true });
  }, sourceInfo.windowId);
  await select(source);
  await toolbar(source).getByRole("button", { name: "分析", exact: true }).click();
  await source.locator('[data-seo-helper="trends-actions"] #notice').filter({ hasText: "任务正在运行或保存" }).waitFor();
  assert.equal(await worker.evaluate(async key => (await chrome.storage.session.get(key))[key], requestKey(sourceInfo.windowId)), undefined);
  await panel.evaluate(() => globalThis.testActivityPort.disconnect());

  // The first Analyze click must open and populate a native side panel, without a second click.
  await select(source);
  await toolbar(source).getByRole("button", { name: "分析", exact: true }).click();
  await source.waitForFunction(() => document.querySelector('[data-seo-helper="trends-actions"]').shadowRoot.getElementById("actions").hidden);
  const options = await worker.evaluate(tabId => chrome.sidePanel.getOptions({ tabId }), sourceInfo.id);
  assert.ok(options.path.includes("analysis/sidepanel.html?windowId="));
  const requestId = new URL(`https://extension.test/${options.path}`).searchParams.get("request");
  assert.ok(requestId);
  // Headless Chromium exposes panel contexts through runtime, not Playwright's page list.
  await worker.evaluate(async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] });
    if (!contexts.length) throw new Error("Native side panel did not open on the first click");
  });
  const nativeState = await worker.evaluate(async () => (await chrome.storage.local.get("seoHelper:google-trends:analysis"))["seoHelper:google-trends:analysis"]);
  if (nativeState?.keyword !== "tangerine file converter") {
    await worker.evaluate(async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const state = (await chrome.storage.local.get("seoHelper:google-trends:analysis"))["seoHelper:google-trends:analysis"];
        if (state?.keyword === "tangerine file converter") return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error("Native side panel did not consume the query");
    });
  }
  assert.equal(await worker.evaluate(async key => (await chrome.storage.session.get(key))[key], requestKey(sourceInfo.windowId)), undefined);
  await select(source, 1);
  await toolbar(source).getByRole("button", { name: "分析", exact: true }).click();
  await panel.waitForFunction(async () => (await chrome.storage.local.get("seoHelper:google-trends:analysis"))["seoHelper:google-trends:analysis"]?.keyword === "C++ & 中文/#?");
  await panel.waitForFunction(async key => !(await chrome.storage.session.get(key))[key], requestKey(sourceInfo.windowId));
  const savedNative = (await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] }))).find(value => value.documentUrl.includes("request="));
  const requestCount = await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] }));
  assert.equal(requestCount.length, 1);
  const once = await context.newPage();
  await once.goto(savedNative.documentUrl);
  await once.waitForFunction(() => !document.getElementById("analyze").disabled);
  assert.equal(await once.locator("iframe").count(), 0); // Consumed requests never rerun on reopen.
  await once.close();

  const modern = await context.newPage();
  await modern.goto("https://trends.google.com/explore?q=modern&date=today%201-m");
  await modern.locator('[data-seo-helper="trends-actions"]').waitFor();
  assert.equal(await modern.locator("#queries a").count(), 0); // Actual new Explore uses table cells, not query links.
  await select(modern);
  await toolbar(modern).getByRole("button", { name: "对比", exact: true }).click();
  await result.waitForURL(url => url.searchParams.get("date") === "today 1-m");
  const home = await context.newPage();
  await home.goto(`chrome-extension://${id}/src/app/sidepanel.html`);
  await home.getByText("网页自动显示中文翻译", { exact: false }).waitFor();
  assert.equal(await home.getByRole("button", { name: /启用翻译|重新应用/ }).count(), 0);
  await modern.locator("#queries td:nth-child(2) [data-seo-helper-translation]").first().waitFor();
  assert.equal(await modern.locator("#queries td:first-child [data-seo-helper-translation]").count(), 0);
  assert.equal(await modern.locator("#topics [data-seo-helper-translation]").count(), 0);
  assert.equal(await modern.locator("#queries td:nth-child(2) [data-seo-helper-translation]").first().textContent(), "合成中文：tangerine file converter");
  await modern.evaluate(html => { document.getElementById("queries").innerHTML = html; }, modernRow("new paginated query"));
  await modern.locator("#queries tr [data-seo-helper-translation]").waitFor();
  await modern.locator("#queries tr").focus();
  await toolbar(modern).waitFor({ state: "visible" });
  // Reused rows must replace the translation and actions without absorbing old translated text.
  await modern.evaluate(() => { document.querySelector("#queries td:nth-child(2) div span").textContent = "recycled scheduler"; });
  await modern.locator("#queries [data-seo-helper-translation]").filter({ hasText: "合成中文：recycled scheduler" }).waitFor();
  await select(modern);
  const cell = await modern.locator("#queries tr").boundingBox();
  const copyButton = toolbar(modern).getByRole("button", { name: "复制", exact: true });
  const box = await copyButton.boundingBox();
  await modern.mouse.move(cell.x + cell.width / 2, cell.y + cell.height / 2);
  await modern.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
  assert.equal(await copyButton.isVisible(), true);
  await isolated(modern, "clipboard");
  await copyButton.click();
  assert.equal(await isolated(modern, "copied"), "recycled scheduler");
  assert.equal(await modern.locator("#queries tr").evaluate(node => {
    const translation = node.querySelector("[data-seo-helper-translation]").getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    return translation.top >= rect.top && translation.bottom <= rect.bottom;
  }), true);
  await modern.screenshot({ path: join(output, "trends-actions-modern.png"), fullPage: true });
  await worker.evaluate(() => { globalThis.testTranslationError = "network"; });
  await modern.evaluate(() => { document.querySelector("#queries td:nth-child(2) div span").textContent = "reapply scheduler"; });
  await modern.locator('[data-seo-helper="trends-actions"] #notice').filter({ hasText: "synthetic network failure" }).waitFor();
  await worker.evaluate(() => { globalThis.testTranslationError = ""; });
  await modern.locator('[data-seo-helper="trends-actions"] #retry-translation').click();
  await modern.locator("#queries [data-seo-helper-translation]").filter({ hasText: "合成中文：reapply scheduler" }).waitFor();
  for (const width of [280, 794]) {
    await home.setViewportSize({ width, height: 900 });
    assert.equal(await home.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await home.screenshot({ path: join(output, `trends-actions-home-${width}.png`), fullPage: true });
  }
  await home.close();

  const otherPageEvent = context.waitForEvent("page");
  const otherWindow = await worker.evaluate(() => chrome.windows.create({ url: "about:blank", focused: false }));
  const otherSource = await otherPageEvent;
  await otherSource.goto("https://trends.google.com/explore?q=other-window&date=now%201-d");
  await otherSource.locator('[data-seo-helper="trends-actions"]').waitFor();
  const otherResultEvent = context.waitForEvent("page");
  await select(otherSource);
  await toolbar(otherSource).getByRole("button", { name: "对比", exact: true }).click();
  const otherResult = await otherResultEvent;
  await otherResult.waitForURL(url => url.searchParams.get("date") === "now 1-d");
  const resultIds = await worker.evaluate(async keys => chrome.storage.session.get(keys), [comparisonKey(sourceInfo.windowId), comparisonKey(otherWindow.id)]);
  assert.notEqual(resultIds[comparisonKey(sourceInfo.windowId)], resultIds[comparisonKey(otherWindow.id)]);
  const sentinelKey = requestKey(sourceInfo.windowId);
  await worker.evaluate(async key => chrome.storage.session.set({ [key]: { id: "other-window-sentinel", keyword: "must stay pending" } }), sentinelKey);
  await select(otherSource);
  await toolbar(otherSource).getByRole("button", { name: "分析", exact: true }).click();
  await panel.waitForFunction(async key => !(await chrome.storage.session.get(key))[key], requestKey(otherWindow.id));
  assert.equal((await worker.evaluate(async key => (await chrome.storage.session.get(key))[key], sentinelKey)).keyword, "must stay pending");
  await worker.evaluate(async ({ windowId, key }) => { await chrome.windows.remove(windowId); await chrome.storage.session.remove(key); }, { windowId: otherWindow.id, key: sentinelKey });

  // Simulate the permission state after revocation, including hidden tab URLs.
  await worker.evaluate(() => { globalThis.realContains = chrome.permissions.contains; chrome.permissions.contains = async () => false; });
  assert.equal((await panel.evaluate(() => chrome.runtime.sendMessage({ type: "trends:sync" }))).enabled, false);
  await source.locator('[data-seo-helper="trends-actions"]').waitFor({ state: "detached" });
  assert.equal(await modern.locator('[data-seo-helper="trends-actions"]').count(), 0);
  assert.equal(await source.locator("[data-seo-helper-translation]").count(), 0);
  assert.equal(await source.locator("#queries .label-text").first().evaluate(node => getComputedStyle(node).lineHeight), "63px");
  assert.equal((await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts())).length, 0);
  await worker.evaluate(() => { chrome.permissions.contains = globalThis.realContains; });
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: "trends:sync" }));
  await source.locator('[data-seo-helper="trends-actions"]').waitFor();
  await source.locator("#queries a").first().locator("[data-seo-helper-translation]").waitFor();
  await modern.locator("#queries [data-seo-helper-translation]").waitFor();
  assert.equal((await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts())).length, 1);
  assert.deepEqual(errors, []);
  console.log("Trends actions browser passed: automatic fresh install and legacy-off reload without optional permission requests or feature activation, table/classic queries, baseline validation/storage failure, native first-click/continuous analysis, task protection, multi-window isolation, comparison reuse/filters, clipboard errors, online translation/cache/retry/HTTP/network failures, dynamic/recycled rows, pointer/keyboard, simulated revocation/cleanup/automatic recovery.");
} finally { await context.close(); networkBoundary.closeAllConnections(); await new Promise(resolve => networkBoundary.close(resolve)); }
