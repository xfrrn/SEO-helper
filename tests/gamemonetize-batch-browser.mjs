// Synthetic HTTP pages/XML in an isolated extension; no website account or user profile.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BATCH_STORAGE_KEY } from "../src/platforms/gamemonetize/game/batch.js";
import { STORAGE_KEY, ORIGIN } from "../src/platforms/gamemonetize/game/core.js";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "output/playwright");
const extension = join(output, "gamemonetize-batch-extension");
await mkdir(extension, { recursive: true });
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
manifest.host_permissions = [`${ORIGIN}/*`];
await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest));
await cp(join(root, "src"), join(extension, "src"), { recursive: true });
const context = await chromium.launchPersistentContext(join(output, `gamemonetize-batch-profile-${Date.now()}`), {
  executablePath: process.env.CHROME_EXECUTABLE || undefined, headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  viewport: { width: 380, height: 900 }, downloadsPath: join(output, "gamemonetize-batch-downloads"),
});
const xmlFor = id => `<?xml version="1.0" encoding="utf-8"?>\r\n<rss><channel><item><id>${id}</id><title>合成游戏 ${id}</title><description>保留原始 XML\r\n  包括空格 &amp; 中文</description></item></channel></rss>\r\n`;
const games = { "/a-game": [10, "Yes"], "/b-game": [11, "No"], "/c-game": [12, null], "/broken-game": [13, "Yes"], "/hold-page-game": [14, "Yes"], "/hold-feed-game": [15, "Yes"] };
const requests = [];
const errors = [];
let holdPage = true;
let holdFeed = true;
let release;
context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
try {
  await context.route("https://**/*", async route => {
    const url = new URL(route.request().url());
    requests.push(url.href);
    if (url.origin !== ORIGIN) return route.abort();
    if ((url.pathname === "/hold-page-game" && holdPage) || (url.pathname === "/feed.php" && url.searchParams.get("id") === "15" && holdFeed)) {
      await new Promise(resolve => { release = resolve; });
    }
    if (url.pathname === "/bad-game") return route.fulfill({ status: 503, body: "Synthetic error" });
    if (url.pathname === "/feed.php") {
      assert.equal(url.searchParams.get("format"), "1");
      const id = url.searchParams.get("id");
      return route.fulfill({ contentType: "text/xml", headers: { "Cache-Control": "no-store" }, body: xmlFor(id === "13" ? "999" : id) }).catch(error => {
        if (!/closed|canceled|cancelled|invalid interception/i.test(error.message)) throw error;
      });
    }
    const [id, mobile] = games[url.pathname] || [];
    assert.ok(id, `Unexpected fixture request: ${url.href}`);
    const html = `<!doctype html><meta charset="utf-8"><div class="product-feed"><button class="XMLOrJson" id="XML-${id}">XML</button></div>${mobile ? `<div class="dev-platform__item"><p>Mobile Ready : ${mobile}</p></div>` : ""}<footer><p>Mobile Ready : Yes</p></footer><script>window.syntheticCodeExecuted=true</script>`;
    return route.fulfill({ contentType: "text/html", headers: { "Cache-Control": "no-store" }, body: html }).catch(error => {
      if (!/closed|canceled|cancelled|invalid interception/i.test(error.message)) throw error;
    });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const id = new URL(worker.url()).hostname;
  const panel = await context.newPage();
  const home = `chrome-extension://${id}/${manifest.side_panel.default_path}`;
  await panel.goto(home);
  const single = { gameId: "777", title: "保留的单页结果", mobileReady: true, pageUrl: `${ORIGIN}/prior-game`, xml: "<rss/>", capturedAt: "2026-10-21T00:00:00.000Z" };
  const sentinels = { seoHelper: { sentinel: "SEM" }, "seoHelper:sim:keyword-generator": { sentinel: "SIM" }, [STORAGE_KEY]: single };
  await panel.evaluate(value => chrome.storage.local.set(value), sentinels);
  await panel.getByRole("link", { name: "游戏采集", exact: true }).click();
  const idle = () => panel.waitForFunction(() => !document.getElementById("batch-start").disabled);
  await idle();
  await panel.locator("#mode-batch").click();
  await idle();
  const pageCount = context.pages().length;
  const readState = () => panel.evaluate(async key => (await chrome.storage.local.get(key))[key], BATCH_STORAGE_KEY);
  const start = async text => {
    await panel.locator("#batch-urls").fill(text);
    await panel.locator("#batch-start").click();
    await idle();
  };
  const waitForHold = async () => {
    const deadline = Date.now() + 10000;
    while (!release && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(release, await panel.locator("#status").textContent());
  };
  await start("https://example.com/game");
  assert.match(await panel.locator('#status[data-error="true"]').textContent(), /第 1 行/);
  assert.equal(requests.length, 0);
  assert.match(await panel.locator("#batch-url-count").textContent(), /不重复链接：0 个 · 无效 1 行/);
  await panel.locator("#batch-urls").fill(`${ORIGIN}/a-game\n${ORIGIN}/a-game#play\nunfinished`);
  assert.match(await panel.locator("#batch-url-count").textContent(), /不重复链接：1 个 · 重复 1 个 · 无效 1 行/);
  await panel.locator("#batch-urls").evaluate(node => node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" })));
  assert.equal(await panel.locator("#batch-urls").inputValue(), `${ORIGIN}/a-game\nunfinished`);
  assert.match(await panel.locator("#batch-url-count").textContent(), /不重复链接：1 个 · 无效 1 行/);
  await panel.evaluate(() => { window.permission = chrome.permissions.request; chrome.permissions.request = async () => false; });
  await start(`${ORIGIN}/a-game`);
  assert.match(await panel.locator('#status[data-error="true"]').textContent(), /请允许/);
  assert.equal(requests.length, 0);
  await panel.evaluate(() => { chrome.permissions.request = window.permission; });
  const input = ["a-game#play", "bad-game", "a-game", "b-game", "c-game", "broken-game"].map(path => `${ORIGIN}/${path}`).join("\n");
  const normalizedInput = ["a-game", "bad-game", "b-game", "c-game", "broken-game"].map(path => `${ORIGIN}/${path}`).join("\n");
  await panel.locator("#batch-urls").fill(input);
  await panel.locator("#batch-urls").evaluate(node => node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" })));
  assert.equal(await panel.locator("#batch-urls").inputValue(), normalizedInput);
  assert.equal(await panel.locator("#batch-url-count").textContent(), "不重复链接：5 个");
  await panel.locator("#batch-start").focus();
  await panel.keyboard.press("Enter");
  await idle();
  assert.match(await panel.locator("#batch-progress").textContent(), /5 \/ 5 已处理 · 3 成功 · 2 失败/);
  assert.equal(await panel.locator("#batch-results li").count(), 5);
  assert.match(await panel.locator("#batch-results li").nth(0).innerText(), /支持（Yes）/);
  assert.match(await panel.locator("#batch-results li").nth(2).innerText(), /不支持（No）/);
  assert.match(await panel.locator("#batch-results li").nth(3).innerText(), /未标注/);
  assert.match(await panel.locator("#batch-results li").nth(4).innerText(), /游戏 ID/);
  assert.deepEqual(requests.map(url => new URL(url).pathname), ["/a-game", "/feed.php", "/bad-game", "/b-game", "/feed.php", "/c-game", "/feed.php", "/broken-game", "/feed.php"]);
  assert.equal(await panel.evaluate(() => Boolean(window.syntheticCodeExecuted)), false);
  assert.equal(context.pages().length, pageCount);
  const saved = await readState();
  assert.equal(saved.rows[2].capture.mobileReady, false);
  assert.equal(saved.rows[3].capture.mobileReady, null);
  assert.equal(saved.rows[0].capture.xml, xmlFor(10));
  const downloadZip = async name => {
    const event = panel.waitForEvent("download");
    await panel.locator("#batch-download").click();
    const download = await event;
    assert.equal(download.suggestedFilename(), "gamemonetize-games.zip");
    await download.saveAs(join(output, name));
    assert.equal((await readFile(join(output, name))).readUInt32LE(0), 0x04034b50);
    await idle();
  };
  await downloadZip("gamemonetize-batch.zip");
  await panel.screenshot({ path: join(output, "gamemonetize-batch.png"), fullPage: true });
  await panel.setViewportSize({ width: 280, height: 800 });
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await panel.screenshot({ path: join(output, "gamemonetize-batch-narrow.png"), fullPage: true });
  const count = requests.length;
  await panel.reload();
  await idle();
  await panel.locator("#mode-batch").click();
  await idle();
  assert.equal(await panel.locator("#batch-urls").inputValue(), normalizedInput);
  assert.equal(requests.length, count);
  assert.deepEqual((await readState()).rows, saved.rows);

  await panel.locator("#batch-urls").fill(["a-game", "hold-page-game", "b-game"].map(path => `${ORIGIN}/${path}`).join("\n"));
  assert.equal(await panel.locator("#batch-input-note").isVisible(), true);
  assert.equal(await panel.locator("#batch-download").textContent(), "下载上次 ZIP");
  assert.equal(await panel.locator("#batch-start").textContent(), "开始新批次");
  await panel.locator("#batch-start").click();
  await waitForHold();
  assert.equal(await panel.locator("#feature-home").isDisabled(), true);
  assert.equal(await panel.locator("#mode-current").isDisabled(), true);
  assert.equal(await panel.locator("#batch-urls").isDisabled(), true);
  await panel.locator("#batch-stop").click();
  await idle();
  release(); release = undefined; holdPage = false;
  assert.match(await panel.locator("#batch-progress").textContent(), /1 \/ 3 已处理 · 1 成功 · 0 失败 · 2 未完成/);
  assert.equal(await panel.locator("#batch-start").textContent(), "继续未完成项");
  await downloadZip("gamemonetize-batch-partial.zip");
  const beforeResume = requests.filter(url => new URL(url).pathname === "/a-game").length;
  await panel.locator("#batch-start").click();
  await idle();
  assert.match(await panel.locator("#batch-progress").textContent(), /3 \/ 3 已处理 · 3 成功/);
  assert.equal(requests.filter(url => new URL(url).pathname === "/a-game").length, beforeResume);

  await panel.locator("#batch-urls").fill(`${ORIGIN}/hold-feed-game\n${ORIGIN}/b-game`);
  await panel.locator("#batch-start").click();
  await waitForHold();
  await panel.locator("#batch-stop").click();
  await idle();
  release(); release = undefined; holdFeed = false;
  assert.match(await panel.locator("#batch-progress").textContent(), /0 \/ 2 已处理 · 0 成功 · 0 失败/);
  assert.equal(await panel.locator("#batch-download").isDisabled(), true);
  await panel.locator("#batch-start").click();
  await idle();
  assert.match(await panel.locator("#batch-progress").textContent(), /2 \/ 2 已处理 · 2 成功/);

  await panel.evaluate(() => {
    window.save = chrome.storage.local.set.bind(chrome.storage.local);
    window.writes = 0;
    chrome.storage.local.set = async value => { if (++window.writes === 2) throw new Error("Disk full"); return window.save(value); };
  });
  await start(`${ORIGIN}/a-game\n${ORIGIN}/b-game`);
  assert.match(await panel.locator('#status[data-error="true"]').textContent(), /批量记录保存失败/);
  assert.equal(await panel.locator("#batch-download").isEnabled(), true, JSON.stringify({ progress: await panel.locator("#batch-progress").textContent(), writes: await panel.evaluate(() => window.writes), rows: await panel.locator("#batch-results").innerText() }));
  assert.match(await panel.locator("#batch-progress").textContent(), /1 \/ 2 已处理 · 1 成功/);
  assert.equal((await readState()).rows[0].status, "pending");
  await panel.evaluate(() => { chrome.storage.local.set = window.save; });
  await downloadZip("gamemonetize-batch-unsaved.zip");
  await panel.locator("#feature-home").click();
  await panel.waitForURL(home);
  await panel.getByRole("link", { name: "游戏采集", exact: true }).click();
  await idle();
  await panel.locator("#mode-batch").click();
  await idle();
  assert.equal((await readState()).rows[0].status, "success");
  assert.deepEqual(await panel.evaluate(keys => chrome.storage.local.get(keys), Object.keys(sentinels)), sentinels);
  assert.equal(await panel.evaluate(() => chrome.permissions.contains({ permissions: ["downloads"] })), false);
  const current = await context.newPage();
  await current.goto(`${ORIGIN}/c-game#play`);
  const beforeAdd = requests.length;
  await panel.locator("#batch-add-current").click();
  await idle();
  assert.equal(await panel.locator("#batch-urls").inputValue(), `${ORIGIN}/a-game\n${ORIGIN}/b-game\n${ORIGIN}/c-game`);
  assert.equal(await panel.locator("#batch-url-count").textContent(), "不重复链接：3 个");
  assert.equal((await readState()).input, await panel.locator("#batch-urls").inputValue());
  assert.equal(requests.length, beforeAdd);
  await panel.locator("#batch-add-current").click();
  await idle();
  assert.match(await panel.locator("#status").textContent(), /已在列表中/);
  assert.equal(await panel.locator("#batch-url-count").textContent(), "不重复链接：3 个");
  await panel.evaluate(() => { window.nativeQuery = chrome.tabs.query.bind(chrome.tabs); chrome.tabs.query = async () => [{ id: 999, url: "https://example.com/game" }]; });
  const beforeWrongPage = await panel.locator("#batch-urls").inputValue();
  await panel.locator("#batch-add-current").click();
  await idle();
  assert.match(await panel.locator('#status[data-error="true"]').textContent(), /请先切换到 GameMonetize/);
  assert.equal(await panel.locator("#batch-urls").inputValue(), beforeWrongPage);
  await panel.evaluate(() => { chrome.tabs.query = window.nativeQuery; });
  await current.close();
  await panel.reload();
  await idle();
  await panel.locator("#mode-batch").click();
  await idle();
  assert.equal(await panel.locator("#batch-urls").inputValue(), beforeWrongPage);
  assert.equal(await panel.locator("#batch-url-count").textContent(), "不重复链接：3 个");
  await panel.evaluate(key => chrome.storage.local.set({ [key]: { input: "", rows: [{ inputUrl: "https://example.com", status: "success" }] } }), BATCH_STORAGE_KEY);
  await panel.reload();
  await idle();
  assert.match(await panel.locator('#status[data-error="true"]').textContent(), /无法恢复批量记录/);
  assert.equal(await panel.locator("#game-title").textContent(), single.title);
  assert.deepEqual(errors, []);
  console.log("Batch browser checks passed: sequential fetch, deduplication, XML/mobile, partial ZIP, stop/resume of page and XML requests, persistence, validation, failures and isolation.");
} finally { release?.(); await context.close(); }
