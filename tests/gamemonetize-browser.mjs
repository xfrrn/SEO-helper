// Isolated extension and synthetic site responses; never uses the user's browser profile or clipboard.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ORIGIN, STORAGE_KEY } from "../src/platforms/gamemonetize/game/core.js";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "output/playwright");
const extension = join(output, "gamemonetize-extension");
await mkdir(extension, { recursive: true });
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
manifest.host_permissions = [`${ORIGIN}/*`];
await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest));
await cp(join(root, "src"), join(extension, "src"), { recursive: true });
const context = await chromium.launchPersistentContext(join(output, `gamemonetize-profile-${Date.now()}`), {
  executablePath: process.env.CHROME_EXECUTABLE || undefined, headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  viewport: { width: 380, height: 900 }, downloadsPath: join(output, "gamemonetize-downloads"),
});
const xml = '<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0"><channel><title>Synthetic fixture</title><item><id>87713</id><title><![CDATA[测试 & 足球游戏]]></title><description>合成测试内容，保留原始格式。\n  第二行</description></item></channel></rss>\n';
const html = '<!doctype html><meta charset="utf-8"><title>Synthetic game fixture</title><h1>测试游戏</h1><div class="product-feed"><button class="XMLOrJson" id="XML-87713">XML</button></div><div class="dev-platform__item"><p> Mobile Ready : Yes </p></div><footer><p>Mobile Ready : Yes</p></footer>';
const errors = [];
let feedMode = "ok";
let feedRequests = 0;
let releaseFeed;
context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
try {
  await context.route("https://**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    if (url.pathname !== "/feed.php") return route.fulfill({ contentType: "text/html", body: html });
    feedRequests++;
    assert.equal(url.searchParams.get("format"), "1");
    assert.equal(url.searchParams.get("id"), "87713");
    const mode = feedMode;
    if (mode === "hold") await new Promise(resolve => { releaseFeed = resolve; });
    if (mode === "network") return route.abort();
    if (mode === "http") return route.fulfill({ status: 503, body: "Unavailable" });
    const body = mode === "html" ? "<!doctype html><html><body>Verify you are human</body></html>"
      : mode === "malformed" ? "<rss><channel>"
        : mode === "wrong-id" ? xml.replace("<id>87713</id>", "<id>99</id>")
          : mode === "multiple" ? xml.replace("</channel>", "<item><id>2</id></item></channel>") : xml;
    await route.fulfill({ contentType: "text/xml;charset=utf-8", body }).catch(error => {
      if (!/closed|canceled|cancelled|invalid interception/i.test(error.message)) throw error;
    });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const id = new URL(worker.url()).hostname;
  const panel = await context.newPage();
  const home = `chrome-extension://${id}/${manifest.side_panel.default_path}`;
  await panel.goto(home);
  await panel.getByRole("link", { name: "游戏采集", exact: true }).click();
  await panel.waitForFunction(() => !document.getElementById("collect").disabled);
  assert.equal(await panel.locator("#result").isHidden(), true);
  assert.equal(feedRequests, 0);
  const sentinels = { seoHelper: { sentinel: "SEM" }, "seoHelper:sim:keyword-generator": { sentinel: "SIM" }, "seoHelper:google-trends:compare": { sentinel: "Trends" } };
  await panel.evaluate(value => chrome.storage.local.set(value), sentinels);
  const target = await context.newPage();
  await target.goto(`${ORIGIN}/fixture-game`);
  const tabId = await panel.evaluate(async origin => (await chrome.tabs.query({ url: `${origin}/*` }))[0].id, ORIGIN);
  const collect = async () => {
    await panel.evaluate(id => chrome.tabs.update(id, { active: true }), tabId);
    await panel.locator("#collect").click();
    await panel.waitForFunction(() => !document.getElementById("collect").disabled);
  };
  const readState = () => panel.evaluate(async key => (await chrome.storage.local.get(key))[key], STORAGE_KEY);
  const expectError = async text => {
    await collect();
    assert.match(await panel.locator('#status[data-error="true"]').textContent(), text);
    assert.equal(await panel.locator("#result").isHidden(), true);
    assert.equal(await panel.locator("#xml").inputValue(), "");
  };
  await panel.evaluate(() => { window.requestPermission = chrome.permissions.request; chrome.permissions.request = async () => false; });
  await expectError(/请允许访问 GameMonetize/);
  assert.equal(feedRequests, 0);
  await panel.evaluate(() => { chrome.permissions.request = window.requestPermission; });
  await collect();
  assert.equal(feedRequests, 1);
  assert.equal(await panel.locator("#game-title").textContent(), "测试 & 足球游戏");
  assert.equal(await panel.locator("#mobile-ready").textContent(), "支持（Yes）");
  assert.equal(await panel.locator("#xml").inputValue(), xml);
  assert.equal((await readState()).mobileReady, true);
  assert.equal((await readState()).pageUrl, target.url());
  await panel.screenshot({ path: join(output, "gamemonetize-game.png"), fullPage: true });
  await panel.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async value => { window.copied = value; } } });
  });
  await panel.locator("#copy-all").click();
  await panel.waitForFunction(() => !document.getElementById("copy-all").disabled);
  const copied = JSON.parse(await panel.evaluate(() => window.copied));
  assert.equal(copied.mobileReady, true);
  assert.equal(copied.xml, xml);
  await panel.locator("#copy-xml").click();
  await panel.waitForFunction(() => !document.getElementById("copy-xml").disabled);
  assert.equal(await panel.evaluate(() => window.copied), xml);
  const downloadEvent = panel.waitForEvent("download");
  await panel.locator("#download-xml").click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(), "gamemonetize-87713.xml");
  assert.equal(await readFile(await download.path(), "utf8"), xml);
  assert.equal(await panel.evaluate(() => chrome.permissions.contains({ permissions: ["downloads"] })), false);
  const requestCount = feedRequests;
  await panel.reload();
  await panel.waitForFunction(() => !document.getElementById("collect").disabled);
  assert.equal(await panel.locator("#xml").inputValue(), xml);
  assert.equal(feedRequests, requestCount);

  await target.locator(".dev-platform__item p").evaluate(node => { node.textContent = "Mobile Ready : No"; });
  await collect();
  assert.equal(await panel.locator("#mobile-ready").textContent(), "不支持（No）");
  assert.equal((await readState()).mobileReady, false);
  await target.locator(".dev-platform__item p").evaluate(node => { node.textContent = "Other field"; });
  await collect();
  assert.equal(await panel.locator("#mobile-ready").textContent(), "未标注");
  assert.equal((await readState()).mobileReady, null);
  await panel.setViewportSize({ width: 280, height: 800 });
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await panel.screenshot({ path: join(output, "gamemonetize-game-narrow.png"), fullPage: true });
  const lastSaved = await readState();
  await target.locator(".dev-platform__item p").evaluate(node => { node.textContent = "Mobile Ready : Maybe"; });
  const beforeInvalidLabel = feedRequests;
  await expectError(/无法识别手机支持标记/);
  assert.equal(feedRequests, beforeInvalidLabel);
  await target.locator(".dev-platform__item p").evaluate(node => { node.textContent = "Mobile Ready : Yes"; });
  for (const [mode, message] of [["http", /HTTP 503/], ["html", /有效的游戏 XML/], ["malformed", /有效的游戏 XML/], ["wrong-id", /游戏 ID/], ["multiple", /游戏 ID/], ["network", /fetch|network/i]]) {
    feedMode = mode;
    await expectError(message);
    assert.deepEqual(await readState(), lastSaved);
  }
  feedMode = "ok";
  await target.locator(".XMLOrJson").evaluate(node => { node.id = "XML-invalid"; });
  const beforeMissingButton = feedRequests;
  await expectError(/未找到游戏 XML 按钮/);
  assert.equal(feedRequests, beforeMissingButton);
  await target.locator(".XMLOrJson").evaluate(node => { node.id = "XML-87713"; });

  feedMode = "hold";
  await panel.evaluate(id => chrome.tabs.update(id, { active: true }), tabId);
  await panel.locator("#collect").click();
  const requestDeadline = Date.now() + 10000;
  while (!releaseFeed && Date.now() < requestDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(releaseFeed, `XML request did not start: ${await panel.locator("#status").textContent()}`);
  assert.equal(await panel.locator("#feature-home").isDisabled(), true);
  assert.equal(await panel.locator("#copy-all").isDisabled(), true);
  await target.evaluate(() => history.pushState({}, "", "/changed-game"));
  releaseFeed();
  releaseFeed = undefined;
  await panel.waitForFunction(() => !document.getElementById("collect").disabled);
  assert.match(await panel.locator('#status[data-error="true"]').textContent(), /页面已切换/);
  assert.deepEqual(await readState(), lastSaved);
  await expectError(/超过 15 秒/);
  releaseFeed?.();
  releaseFeed = undefined;
  feedMode = "ok";

  await panel.evaluate(() => { window.saveStorage = chrome.storage.local.set; chrome.storage.local.set = async () => { throw new Error("Disk full"); }; });
  await collect();
  assert.equal(await panel.locator("#result").isVisible(), true);
  assert.equal(await panel.locator("#xml").inputValue(), xml);
  assert.match(await panel.locator('#status[data-error="true"]').textContent(), /采集完成，但保存失败/);
  assert.deepEqual(await readState(), lastSaved);
  await panel.evaluate(() => { chrome.storage.local.set = window.saveStorage; navigator.clipboard.writeText = async () => { throw new Error("Denied"); }; });
  await panel.locator("#copy-all").click();
  await panel.waitForFunction(() => !document.getElementById("copy-all").disabled);
  assert.match(await panel.locator('#status[data-error="true"]').textContent(), /复制失败/);

  await panel.locator("#feature-home").click();
  await panel.waitForURL(home);
  await panel.getByRole("link", { name: "游戏采集", exact: true }).click();
  await panel.waitForFunction(() => !document.getElementById("collect").disabled);
  assert.equal(await panel.locator("#mobile-ready").textContent(), "未标注");
  await panel.evaluate(() => { window.queryTabs = chrome.tabs.query; chrome.tabs.query = async () => [{ id: 999, url: "https://example.com/game" }]; });
  await expectError(/请先切换到 GameMonetize/);
  await panel.evaluate(() => { chrome.tabs.query = window.queryTabs; });
  await panel.evaluate(key => chrome.storage.local.set({ [key]: { xml: "corrupted" } }), STORAGE_KEY);
  await panel.reload();
  await panel.waitForFunction(() => !document.getElementById("collect").disabled);
  assert.match(await panel.locator('#status[data-error="true"]').textContent(), /无法恢复上次采集/);
  assert.equal(await panel.locator("#result").isHidden(), true);
  assert.deepEqual(await panel.evaluate(keys => chrome.storage.local.get(keys), Object.keys(sentinels)), sentinels);
  assert.deepEqual(errors, []);
  console.log("GameMonetize browser checks passed: raw XML, three mobile states, copy/download, persistence, permissions, errors, timeout, navigation, isolation and 280px layout.");
} finally {
  releaseFeed?.();
  await context.close();
}
