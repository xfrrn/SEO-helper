// Isolated extension check. Google Trends responses are local fixtures, not a live Google account.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { STORAGE_KEY, DEFAULT_GROUPS } from "../src/platforms/google-trends/compare/core.js";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "output/playwright");
const extension = join(output, "trends-extension");
await mkdir(extension, { recursive: true });
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest));
await cp(join(root, "src"), join(extension, "src"), { recursive: true });
const context = await chromium.launchPersistentContext(join(output, `trends-profile-${Date.now()}`), {
  executablePath: process.env.CHROME_EXECUTABLE || undefined,
  headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  viewport: { width: 380, height: 900 },
});
const errors = [];
context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
try {
  await context.route("https://trends.google.com/**", (route) => route.fulfill({ contentType: "text/html", body:
    '<!doctype html><meta charset="utf-8"><title>Trends fixture</title><main id="terms"></main><script>document.getElementById("terms").textContent = new URL(location.href).searchParams.get("q")</script>' }));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const id = new URL(worker.url()).hostname;
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/${manifest.side_panel.default_path}`);
  await panel.getByRole("link", { name: "分组对比", exact: true }).click();
  await panel.locator("#group-list li").nth(10).waitFor();
  assert.equal(await panel.locator("#group-count").textContent(), "11 组 · 51 词");
  const year = new Date().getFullYear();
  const annualDates = [year, year - 1].map((value) => `${value}-01-01 ${value}-12-31`);
  assert.deepEqual(await panel.locator("#date option").evaluateAll((nodes) => nodes.map((node) => node.value)),
    ["now 1-H", "now 4-H", "now 1-d", "now 7-d", "today 1-m", "today 3-m", "today 12-m", "today 5-y", "all", ...annualDates, "custom"]);
  const readState = () => panel.evaluate(async (key) => (await chrome.storage.local.get(key))[key], STORAGE_KEY);
  await panel.evaluate(() => chrome.storage.local.set({ seoHelper: { sentinel: "SEM data stays independent" } }));
  const target = await context.newPage();
  await target.goto("https://trends.google.com/explore?q=old&date=today%201-m&cat=7&gprop=youtube");
  const pageCount = context.pages().length;
  // Browser-withheld required access is an error; group comparison never asks to start an optional feature.
  await panel.evaluate(() => {
    window.containsPermission = chrome.permissions.contains;
    chrome.permissions.contains = async () => false;
    chrome.permissions.request = async () => { throw new Error("Trends must not request optional permissions"); };
  });
  await panel.locator(".group").first().click();
  await panel.locator("#status[data-error=true]").filter({ hasText: "扩展管理页" }).waitFor();
  assert.equal(new URL(target.url()).searchParams.get("q"), "old");
  await panel.evaluate(() => { chrome.permissions.contains = window.containsPermission; });
  const compare = async (index, query) => {
    await panel.locator(".group").nth(index).click();
    await panel.locator("#status").filter({ hasText: "交给新版探索页" }).waitFor();
    await panel.waitForFunction(() => !document.getElementById("controls").disabled);
    const state = await readState();
    await target.waitForURL((url) => url.pathname === "/explore" && url.searchParams.get("q") === query && url.searchParams.get("date") === state.date);
    assert.equal(context.pages().length, pageCount);
    assert.equal(await target.locator("#terms").textContent(), query);
  };
  await compare(0, "Translator,Generator,Example,Convert,Online");
  assert.equal(new URL(target.url()).searchParams.get("date"), "today 1-m");
  assert.equal(new URL(target.url()).searchParams.get("cat"), "7");
  assert.equal(new URL(target.url()).searchParams.get("gprop"), "youtube");
  await compare(1, "Downloader,Maker,Creator,Editor,Processor");
  for (const date of ["now 1-H", "now 4-H", "now 1-d", ...annualDates]) {
    await panel.locator("#date").selectOption(date);
    await panel.waitForFunction(() => !document.getElementById("controls").disabled);
    assert.equal((await readState()).date, date);
    await compare(0, "Translator,Generator,Example,Convert,Online");
  }
  await panel.reload();
  await panel.locator(".group").first().waitFor();
  assert.equal(await panel.locator("#date").inputValue(), annualDates[1]);
  await panel.locator("#date").selectOption("custom");
  await panel.locator("#apply-date").click();
  await panel.locator("#status[data-error=true]").filter({ hasText: "开始和结束日期" }).waitFor();
  assert.equal((await readState()).date, annualDates[1]);
  await panel.locator("#date-start").fill("2026-03-02");
  await panel.locator("#date-end").fill("2026-03-01");
  await panel.locator("#apply-date").click();
  await panel.locator("#status[data-error=true]").filter({ hasText: "开始日期不能晚于结束日期" }).waitFor();
  assert.equal((await readState()).date, annualDates[1]);
  await panel.locator("#date-start").fill("2026-02-01");
  await panel.locator("#apply-date").click();
  await panel.locator("#status").filter({ hasText: "设置已保存" }).waitFor();
  await compare(1, "Downloader,Maker,Creator,Editor,Processor");
  assert.equal(new URL(target.url()).searchParams.get("date"), "2026-02-01 2026-03-01");
  await panel.reload();
  await panel.locator(".group").first().waitFor();
  assert.equal(await panel.locator("#date").inputValue(), "custom");
  assert.equal(await panel.locator("#date-start").inputValue(), "2026-02-01");
  assert.equal(await panel.locator("#date-end").inputValue(), "2026-03-01");
  await panel.setViewportSize({ width: 280, height: 720 });
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await panel.screenshot({ path: join(output, "trends-custom-date.png"), fullPage: true });
  await panel.setViewportSize({ width: 380, height: 900 });
  await panel.locator("#date").selectOption("now 7-d");
  await panel.waitForFunction(() => !document.getElementById("controls").disabled);
  await panel.locator("#geo").selectOption("US");
  await panel.waitForFunction(() => !document.getElementById("controls").disabled);
  await compare(0, "Translator,Generator,Example,Convert,Online");
  assert.equal(new URL(target.url()).searchParams.get("date"), "now 7-d");
  assert.equal(new URL(target.url()).searchParams.get("geo"), "US");
  await target.goto("https://trends.google.com/explore?q=from-page&date=2026-01-01%202026-02-01&geo=US-CA&hl=zh-CN");
  await panel.locator("#use-current").click();
  await panel.locator("#status").filter({ hasText: "已读取" }).waitFor();
  assert.equal(await panel.locator("#date").inputValue(), "custom");
  assert.equal(await panel.locator("#date-start").inputValue(), "2026-01-01");
  assert.equal(await panel.locator("#date-end").inputValue(), "2026-02-01");
  assert.equal(await panel.locator("#geo").inputValue(), "US-CA");
  await panel.locator("#group-editor summary").click();
  await panel.locator("#groups").fill("AI writer,中文,C++\nTranslator,Calculator");
  await panel.locator(".group").first().click();
  await panel.locator("#status").filter({ hasText: "请先保存" }).waitFor();
  assert.equal(new URL(target.url()).searchParams.get("q"), "from-page");
  await panel.locator("#save-groups").click();
  await panel.locator("#status").filter({ hasText: "分组已保存" }).waitFor();
  await compare(0, "AI writer,中文,C++");
  await panel.reload();
  await panel.locator(".group").nth(1).waitFor();
  assert.equal(await panel.locator(".group[aria-pressed=true]").count(), 1);
  assert.equal(await panel.locator("#groups").inputValue(), "AI writer, 中文, C++\nTranslator, Calculator");
  assert.equal((await readState()).geo, "US-CA");
  await panel.locator("#group-editor summary").click();
  await panel.locator("#groups").fill("a,b,c,d,e,f,g,h,i");
  await panel.locator("#save-groups").click();
  await panel.locator("#status").filter({ hasText: "超过 8 个词" }).waitFor();
  assert.equal((await readState()).groups.startsWith("AI writer"), true);
  await panel.locator("#groups").fill("replacement");
  await panel.evaluate(() => { window.storageSet = chrome.storage.local.set; chrome.storage.local.set = async () => { throw new Error("quota"); }; });
  await panel.locator("#save-groups").click();
  await panel.locator("#status").filter({ hasText: "保存失败" }).waitFor();
  assert.equal(await panel.locator("#groups").inputValue(), "replacement");
  assert.equal((await readState()).groups.startsWith("AI writer"), true);
  await panel.evaluate(() => { chrome.storage.local.set = window.storageSet; });
  await panel.locator("#groups").fill("");
  await panel.locator("#save-groups").click();
  await panel.locator("#empty").waitFor();
  await panel.reload();
  await panel.locator("#empty").waitFor();
  assert.equal(await panel.locator(".group").count(), 0);
  await panel.locator("#groups").fill(DEFAULT_GROUPS);
  await panel.locator("#save-groups").click();
  await panel.locator("#status").filter({ hasText: "分组已保存" }).waitFor();
  await panel.locator("#date").selectOption("today 1-m");
  await panel.waitForFunction(() => !document.getElementById("controls").disabled);
  await panel.locator("#geo").selectOption("");
  await panel.waitForFunction(() => !document.getElementById("controls").disabled);
  await compare(0, "Translator,Generator,Example,Convert,Online");
  assert.ok(await panel.locator(".group").first().evaluate((node) => parseFloat(getComputedStyle(node).fontSize) >= 16));
  await panel.screenshot({ path: join(output, "trends-compare.png"), fullPage: true });
  await panel.setViewportSize({ width: 280, height: 720 });
  await panel.screenshot({ path: join(output, "trends-compare-narrow.png"), fullPage: true });
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const sem = await panel.evaluate(async () => (await chrome.storage.local.get("seoHelper")).seoHelper);
  assert.deepEqual(sem, { sentinel: "SEM data stays independent" });
  // A failed restore must not allow a default list to overwrite the existing saved data.
  await panel.evaluate((key) => chrome.storage.local.set({ [key]: { groups: null } }), STORAGE_KEY);
  await panel.reload();
  await panel.locator("#status").filter({ hasText: "无法恢复分组" }).waitFor();
  assert.equal(await panel.locator(".group").first().isDisabled(), true);
  await panel.locator("#feature-home").click();
  await panel.getByRole("link", { name: "分组对比", exact: true }).waitFor();
  assert.deepEqual(await readState(), { groups: null });
  assert.deepEqual(errors, []);
  console.log("PASS: Trends navigation, permission denial, URL comparison, tab reuse, filters, editing, recovery, storage failure and narrow layout.");
} finally { await context.close(); }
