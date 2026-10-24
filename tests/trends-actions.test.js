import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DEFAULT_SETTINGS, SETTINGS_KEY, validateSettings, sourceTab, quickComparisonUrl, openQuickComparison, comparisonKey } from "../src/platforms/google-trends/page-actions/core.js";

test("page action baselines validate phrases without changing other feature settings", () => {
  assert.equal(SETTINGS_KEY, "seoHelper:google-trends:page-actions");
  assert.deepEqual(validateSettings({ ...DEFAULT_SETTINGS, baselines: ["  happy   birthday images ", "GPTs"] }).baselines, DEFAULT_SETTINGS.baselines);
  for (const baselines of [[], ["one"], ["one", "ONE"], ["", "two"], ["x".repeat(151), "two"], ["a,b", "c"], [null, "c"]]) {
    assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, baselines }));
  }
  for (const value of [null, {}, { baselines: "one,two" }]) assert.throws(() => validateSettings(value));
});

test("page actions are automatic and discard obsolete off flags without losing baselines", async () => {
  assert.deepEqual(DEFAULT_SETTINGS, { baselines: ["happy birthday images", "GPTs"] });
  assert.deepEqual(validateSettings({ enabled: false, translate: false, baselines: ["custom phrase", "Other"] }), { baselines: ["custom phrase", "Other"] });
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  for (const origin of ["https://trends.google.com/*", "https://translate.googleapis.com/*"]) {
    assert.ok(manifest.host_permissions.includes(origin));
    assert.equal(manifest.optional_host_permissions.includes(origin), false);
  }
  assert.ok(manifest.optional_host_permissions.includes("https://sem.3ue.co/*"));
});

test("quick comparison keeps source filters, deduplicates and always uses new Explore", () => {
  const source = "https://trends.google.com/trends/explore?q=old&date=now%207-d&geo=US&cat=7&gprop=youtube&hl=zh-CN&legacy=1#old";
  const url = new URL(quickComparisonUrl("C++ & 中文/#?", DEFAULT_SETTINGS, source));
  assert.equal(url.pathname, "/explore");
  assert.equal(url.searchParams.get("q"), "happy birthday images,GPTs,C++ & 中文/#?");
  for (const key of ["date", "geo", "cat", "gprop", "hl"]) assert.equal(url.searchParams.get(key), new URL(source).searchParams.get(key));
  assert.equal(url.searchParams.has("legacy"), false);
  assert.equal(url.hash, "");
  assert.equal(new URL(quickComparisonUrl("gpts", DEFAULT_SETTINGS, source)).searchParams.get("q"), "happy birthday images,GPTs");
  assert.throws(() => quickComparisonUrl("a", DEFAULT_SETTINGS, source.replace("now%207-d", "invalid")));
  assert.throws(() => quickComparisonUrl("a", DEFAULT_SETTINGS, "https://evil.test/explore"));
});

test("page action messages accept only top-level matching Trends explore documents", () => {
  const url = "https://trends.google.com/explore?q=test";
  const sender = { frameId: 0, url, tab: { id: 1, windowId: 2, url } };
  assert.equal(sourceTab(sender), sender.tab);
  for (const invalid of [{ ...sender, frameId: 1 }, { ...sender, url: "https://evil.test/explore" },
    { ...sender, tab: { ...sender.tab, url: `${url}2` } }, { ...sender, tab: { ...sender.tab, pendingUrl: "https://evil.test/" } },
    { ...sender, url: "https://trends.google.com/trends/embed/explore/TIMESERIES" }]) assert.throws(() => sourceTab(invalid));
});

test("quick comparison reuses only its own result tab in the source window", async () => {
  const original = globalThis.chrome;
  const saved = {};
  const calls = [];
  let resultTab;
  let sequence = 10;
  globalThis.chrome = {
    storage: { session: { get: async key => ({ [key]: saved[key] }), set: async values => Object.assign(saved, values) } },
    tabs: {
      get: async () => { if (!resultTab) throw new Error("No tab with id: 10."); return resultTab; },
      create: async options => { calls.push(["create", options]); return resultTab = { ...options, id: sequence++ }; },
      update: async (id, options) => { calls.push([id, options]); return resultTab = { ...resultTab, ...options }; },
    },
  };
  const source = { id: 1, windowId: 2, url: "https://trends.google.com/explore?date=now%207-d" };
  try {
    await Promise.all([openQuickComparison("one", DEFAULT_SETTINGS, source), openQuickComparison("two", DEFAULT_SETTINGS, source)]);
    assert.deepEqual(calls.map(call => call[0]), ["create", 10]);
    resultTab.url = "https://example.com/";
    await openQuickComparison("three", DEFAULT_SETTINGS, source);
    assert.equal(calls.at(-1)[0], "create");
    resultTab = null;
    await openQuickComparison("four", DEFAULT_SETTINGS, source);
    assert.equal(calls.at(-1)[0], "create");
    resultTab.windowId = 3;
    await openQuickComparison("five", DEFAULT_SETTINGS, source);
    assert.equal(calls.at(-1)[0], "create");
    saved[comparisonKey(2)] = source.id;
    await openQuickComparison("six", DEFAULT_SETTINGS, source);
    assert.equal(calls.at(-1)[0], "create");
    globalThis.chrome.tabs.get = async () => { throw new Error("permission denied"); };
    await assert.rejects(openQuickComparison("seven", DEFAULT_SETTINGS, source), /permission denied/);
  } finally { globalThis.chrome = original; }
});
