// Isolated extension integration: controlled frames, no third-party requests or user profile.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, cp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { STORAGE_KEY, PROVIDERS } from "../src/platforms/google-trends/analysis/core.js";
import { COMPARE_STORAGE_KEY } from "../src/platforms/google-trends/explore.js";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "output/playwright");
const extension = join(output, "analysis-extension");
await mkdir(extension, { recursive: true });
await cp(join(root, "manifest.json"), join(extension, "manifest.json"));
await cp(join(root, "src"), join(extension, "src"), { recursive: true });
const context = await chromium.launchPersistentContext(join(output, `analysis-profile-${Date.now()}`), {
  executablePath: process.env.CHROME_EXECUTABLE || undefined,
  headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  viewport: { width: 380, height: 900 },
});
const requests = [];
const errors = [];
context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
try {
  await context.route("https://**/*", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8">
      <style>body{font:16px/1.6 sans-serif;margin:24px;color:#19252c}p{color:#67737c}</style>
      <h2>模拟搜索结果</h2><main id="query"></main><p>此页面用于交互验证，不代表第三方真实数据。</p>
      <a href="https://trends.google.com/trends/explore?q=legacy" target="_blank">Legacy chart link</a>
      <script>const u=new URL(location.href);document.getElementById('query').textContent=u.searchParams.get('q')||JSON.parse(u.searchParams.get('req')||'{}').comparisonItem?.[0]?.keyword||'';</script>` });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const id = new URL(worker.url()).hostname;
  const panel = await context.newPage();
  const home = `chrome-extension://${id}/src/app/sidepanel.html`;
  await panel.goto(home);
  const compare = { groups: "create,writer", date: "2026-02-01 2026-03-01", geo: "US-CA", selectedIndex: -1 };
  await panel.evaluate(({ key, value }) => chrome.storage.local.set({ [key]: value, seoHelper: { sentinel: "SEM" } }), { key: COMPARE_STORAGE_KEY, value: compare });
  await panel.getByRole("link", { name: "词义分析", exact: true }).click();
  await panel.waitForFunction(() => !document.getElementById("analyze").disabled);
  assert.equal(await panel.getByRole("tab").count(), 6);
  assert.equal(await panel.locator("iframe").count(), 0);
  assert.equal(requests.length, 0);
  const readState = () => panel.evaluate(async (key) => (await chrome.storage.local.get(key))[key], STORAGE_KEY);
  const idle = () => panel.waitForFunction(() => !document.getElementById("analyze").disabled);
  const enterKeyword = async word => {
    if (!await panel.locator("#analysis-form").isVisible()) { await panel.reload(); await idle(); }
    await panel.locator("#keyword").fill(word);
  };
  const checkFrame = async (word) => {
    await idle();
    await panel.frameLocator("iframe").locator("#query").filter({ hasText: word }).waitFor();
    assert.equal(await panel.locator("iframe").count(), 1);
    assert.equal(await panel.frameLocator("iframe").locator("#query").textContent(), word);
  };
  await panel.locator("#keyword").fill("  create  ");
  await panel.locator("#keyword").press("Enter");
  await checkFrame("create");
  assert.deepEqual(await readState(), { keyword: "create", provider: "google" });
  assert.equal(new URL(await panel.locator("iframe").getAttribute("src")).searchParams.get("igu"), "1");
  assert.equal(requests.length, 1); // Other tabs have not been requested.
  assert.equal(await panel.locator("#analysis-form").isVisible(), false);
  for (const width of [280, 380, 794]) {
    await panel.setViewportSize({ width, height: 900 });
    const bounds = await panel.locator("iframe").boundingBox();
    assert.ok(bounds.y <= 100, `result starts at ${bounds.y}px for ${width}px`);
    assert.ok(bounds.height >= 800, `result height ${bounds.height}px for ${width}px`);
    assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), true);
    await panel.screenshot({ path: join(output, `trends-analysis-compact-${width}.png`), fullPage: true });
  }
  await panel.setViewportSize({ width: 380, height: 900 });
  await panel.screenshot({ path: join(output, "trends-analysis.png"), fullPage: true });

  for (const provider of PROVIDERS.filter(({ id }) => id !== "google" && id !== "ahrefs")) {
    await panel.getByRole("tab", { name: provider.label, exact: true }).click();
    await checkFrame("create");
    assert.equal((await readState()).provider, provider.id);
    const jump = new URL(await panel.locator("#open-result").getAttribute("href"));
    if (["time", "geo"].includes(provider.id)) {
      assert.equal(jump.pathname, "/explore");
      assert.equal(jump.searchParams.get("date"), compare.date);
      assert.equal(jump.searchParams.get("geo"), compare.geo);
      const req = JSON.parse(new URL(await panel.locator("iframe").getAttribute("src")).searchParams.get("req"));
      assert.deepEqual(req.comparisonItem, [{ keyword: "create", geo: compare.geo, time: compare.date }]);
      assert.equal((await panel.locator("iframe").getAttribute("sandbox")).includes("allow-popups"), false);
      const before = context.pages().length;
      await panel.frameLocator("iframe").getByRole("link", { name: "Legacy chart link" }).click();
      assert.equal(context.pages().length, before);
      assert.equal(requests.some((url) => new URL(url).pathname === "/trends/explore"), false);
    }
  }
  await panel.getByRole("tab", { name: "Ahrefs", exact: true }).click();
  await idle();
  assert.equal(await panel.locator("iframe").count(), 0);
  assert.equal(await panel.locator("#external-result").isVisible(), true);
  assert.equal(await panel.locator("#open-result").getAttribute("href"), "https://ahrefs.com/keyword-generator");
  await panel.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => { window.copied = text; } } }));
  await panel.locator("#copy-keyword").click();
  await idle();
  assert.equal(await panel.evaluate(() => window.copied), "create");
  await panel.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error("denied"); }; });
  await panel.locator("#copy-keyword").click();
  await panel.locator("#status[data-error=true]").filter({ hasText: "复制失败" }).waitFor();
  const popupPromise = context.waitForEvent("page");
  await panel.locator("#open-result").click();
  const popup = await popupPromise;
  await popup.waitForURL("https://ahrefs.com/keyword-generator");
  await popup.close();
  await panel.bringToFront();

  await enterKeyword("AI writer & 中文/#?<img src=x>");
  await panel.getByRole("tab", { name: "Google", exact: true }).click();
  await checkFrame("AI writer & 中文/#?<img src=x>");
  assert.equal(await panel.locator("#analysis-result img").count(), 0);
  await panel.getByRole("tab", { name: "Google", exact: true }).press("ArrowRight");
  assert.equal(await panel.locator("#provider-time").evaluate((node) => node === document.activeElement), true);
  await panel.locator("#provider-time").press("Enter");
  await checkFrame("AI writer & 中文/#?<img src=x>");
  assert.equal(await panel.locator("#provider-time").evaluate((node) => node === document.activeElement), true);
  await panel.locator("#reload").click();
  await checkFrame("AI writer & 中文/#?<img src=x>");
  const saved = await readState();
  const count = requests.length;
  await panel.reload();
  await idle();
  assert.equal(await panel.locator("#keyword").inputValue(), saved.keyword);
  assert.equal(await panel.locator("#provider-time").getAttribute("aria-selected"), "true");
  assert.equal(await panel.locator("iframe").count(), 0);
  assert.equal(requests.length, count); // Restore does not resend a keyword.
  await panel.locator("#analyze").click();
  await checkFrame(saved.keyword);

  await enterKeyword("unsaved phrase");
  await panel.evaluate(() => { window.realSet = chrome.storage.local.set; chrome.storage.local.set = async () => { throw new Error("quota"); }; });
  await panel.getByRole("tab", { name: "Bing", exact: true }).click();
  await panel.locator("#status[data-error=true]").filter({ hasText: "保存失败" }).waitFor();
  assert.deepEqual(await readState(), saved);
  assert.equal(await panel.locator("#keyword").inputValue(), "unsaved phrase");
  assert.equal(await panel.locator("#provider-time").getAttribute("aria-selected"), "true");
  await panel.evaluate(() => { chrome.storage.local.set = window.realSet; });
  await panel.locator("#keyword").fill("one,two");
  await panel.locator("#analyze").click();
  await panel.locator("#status[data-error=true]").filter({ hasText: "一次分析一个词" }).waitFor();
  assert.deepEqual(await readState(), saved);
  await panel.locator("#keyword").fill("");
  await panel.getByRole("tab", { name: "Google", exact: true }).click();
  await idle();
  assert.equal(await panel.locator("iframe").count(), 0);
  assert.equal((await readState()).keyword, "");
  await panel.locator("#keyword").fill("create");
  await panel.locator("#analyze").click();
  await checkFrame("create");
  await panel.setViewportSize({ width: 280, height: 720 });
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await panel.screenshot({ path: join(output, "trends-analysis-narrow.png"), fullPage: true });
  assert.deepEqual(await panel.evaluate(async (key) => (await chrome.storage.local.get(key))[key], COMPARE_STORAGE_KEY), compare);
  assert.deepEqual(await panel.evaluate(async () => (await chrome.storage.local.get("seoHelper")).seoHelper), { sentinel: "SEM" });

  await enterKeyword("saved draft");
  await panel.locator("#feature-compare").click();
  await panel.locator(".group").waitFor();
  assert.equal((await readState()).keyword, "saved draft");
  await panel.locator("#group-editor summary").click();
  await panel.locator("#groups").fill("new,words");
  await panel.locator("#feature-analysis").click();
  await idle();
  assert.equal(await panel.locator("#keyword").inputValue(), "saved draft");
  assert.equal(await panel.evaluate(async (key) => (await chrome.storage.local.get(key))[key].groups, COMPARE_STORAGE_KEY), "new, words");
  await panel.evaluate((key) => chrome.storage.local.set({ [key]: { keyword: "saved draft", provider: "unknown" } }), STORAGE_KEY);
  await panel.reload();
  await panel.locator("#status[data-error=true]").filter({ hasText: "无法恢复" }).waitFor();
  assert.equal(await panel.locator("#analyze").isDisabled(), true);
  assert.equal((await readState()).provider, "unknown");
  await panel.locator("#feature-home").click();
  await panel.waitForURL(home);
  assert.deepEqual(errors, []);
  console.log("Analysis browser check passed: six sources, selected-only requests, embeds, new Explore jumps, blocked legacy popups, keyboard, storage failures/isolation, draft navigation, narrow layout.");
} finally { await context.close(); }
