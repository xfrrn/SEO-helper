import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_GROUPS, parseGroups, compareUrl, isTrendsUrl, openComparison, validateDate } from "../src/platforms/google-trends/compare/core.js";

test("Trends groups preserve phrases, deduplicate per line and enforce the new Explore limits", () => {
  const presets = parseGroups(DEFAULT_GROUPS);
  assert.equal(presets.length, 11);
  assert.equal(presets.flat().length, 51);
  assert.deepEqual(presets[0], ["Translator", "Generator", "Example", "Convert", "Online"]);
  assert.deepEqual(parseGroups("  AI   writer,ai writer；中文，C++\r\n\nAI writer,Calculator"), [["AI writer", "中文", "C++"], ["AI writer", "Calculator"]]);
  assert.deepEqual(parseGroups("\n ; , "), []);
  assert.equal(parseGroups(Array.from({ length: 8 }, (_, i) => `word${i}`).join(","))[0].length, 8);
  assert.throws(() => parseGroups(Array.from({ length: 9 }, (_, i) => `word${i}`).join(",")), /8 个词/);
  assert.throws(() => parseGroups("x".repeat(151)), /150/);
  assert.throws(() => parseGroups(Array(201).fill("word").join("\n")), /200/);
  assert.throws(() => parseGroups(null));
});

test("comparison always uses /explore, replaces old terms, encodes text and preserves relevant filters", () => {
  const url = new URL(compareUrl(["AI writer", "C++", "中文 & test#?"], { date: "today 1-m", geo: "US" },
    "https://trends.google.com/trends/explore?q=old&date=now%207-d&geo=GB&cat=7&gprop=youtube&hl=zh-CN&legacy=1#old"));
  assert.equal(url.origin, "https://trends.google.com");
  assert.equal(url.pathname, "/explore");
  assert.equal(url.searchParams.get("q"), "AI writer,C++,中文 & test#?");
  assert.equal(url.searchParams.get("date"), "today 1-m");
  assert.equal(url.searchParams.get("geo"), "US");
  for (const [key, value] of [["cat", "7"], ["gprop", "youtube"], ["hl", "zh-CN"]]) assert.equal(url.searchParams.get(key), value);
  assert.equal(url.searchParams.has("legacy"), false);
  assert.equal(url.hash, "");
  assert.equal(new URL(compareUrl(["x"], { geo: "" }, url.href)).searchParams.has("geo"), false);
  for (const value of ["https://trends.google.com.evil.test/explore", "http://trends.google.com", "https://trends.google.com:444/explore", "https://user:password@trends.google.com/explore", "bad"]) {
    assert.equal(isTrendsUrl(value), false);
    assert.equal(new URL(compareUrl(["x"], undefined, value)).origin, "https://trends.google.com");
  }
  for (const words of [[], [""], ["one,two"], ["one\ntwo"], [null]]) assert.throws(() => compareUrl(words));
  assert.throws(() => compareUrl(["x"], { date: "bad" }));
  assert.throws(() => compareUrl(["x"], { geo: "US&date=all" }));
});

test("all time presets, calendar years and custom dates are validated and passed to new Explore", () => {
  for (const date of ["now 1-H", "now 4-H", "now 1-d", "now 7-d", "today 1-m", "today 3-m", "today 12-m", "today 5-y", "all",
    "2026-01-01 2026-12-31", "2025-01-01 2025-12-31", "2024-02-29 2024-03-01", "2004-01-01 2004-01-01"]) {
    const url = new URL(compareUrl(["Translator"], { date }));
    assert.equal(url.searchParams.get("date"), date);
    assert.equal(url.pathname, "/explore");
  }
  for (const date of [null, "", "custom", "now 24-H", "2025-02-29 2025-03-01", "2026-04-31 2026-05-01",
    "2026-13-01 2027-01-01", "2003-12-31 2004-01-01", "2026-03-02 2026-03-01", "2026-01-01 "]) {
    assert.throws(() => validateDate(date));
    assert.throws(() => compareUrl(["Translator"], { date }));
  }
});

test("comparison reuses the active Trends tab, never replaces unrelated tabs, and propagates failures", async () => {
  const original = globalThis.chrome;
  const calls = [];
  let tabs = [{ id: 1, active: false, url: "https://trends.google.com/explore?q=old&cat=7" },
    { id: 2, active: true, url: "https://trends.google.com/explore?q=active&gprop=youtube" }];
  globalThis.chrome = { tabs: {
    query: async (query) => { assert.deepEqual(query, { currentWindow: true, url: "https://trends.google.com/*" }); return tabs; },
    update: async (id, options) => { calls.push([id, options]); return { id, ...options }; },
    create: async (options) => { calls.push(["create", options]); return { id: 3, ...options }; },
  } };
  try {
    await openComparison(["Translator", "Calculator"], { date: "today 1-m", geo: "" });
    assert.equal(calls[0][0], 2);
    assert.equal(new URL(calls[0][1].url).searchParams.get("gprop"), "youtube");
    tabs[1].active = false;
    await openComparison(["x"], {});
    assert.equal(calls[1][0], 1);
    tabs = [{ id: 1, active: true, url: "https://example.com/" }];
    await openComparison(["x"], {});
    assert.equal(calls[2][0], "create");
    tabs = [{ id: 1, url: "https://trends.google.com/explore", pendingUrl: "https://example.com/" }];
    await openComparison(["x"], {});
    assert.equal(calls[3][0], "create");
    const count = calls.length;
    await assert.rejects(openComparison([], {}));
    assert.equal(calls.length, count);
    globalThis.chrome.tabs.query = async () => { throw new Error("denied"); };
    await assert.rejects(openComparison(["x"], {}), /denied/);
  } finally { globalThis.chrome = original; }
});
