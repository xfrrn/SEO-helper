import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS, normalizeKeyword, analysisTarget } from "../src/platforms/google-trends/analysis/core.js";

test("analysis validates single phrases and encodes queries without changing destinations", () => {
  const keyword = "C++ & 中文/#?<img src=x>";
  assert.equal(normalizeKeyword("  AI   writer\n"), "AI writer");
  assert.equal(normalizeKeyword("x".repeat(150)).length, 150);
  for (const invalid of [null, {}, "", " ", "x".repeat(151), "a,b", "a；b", "a\0b"]) {
    assert.throws(() => normalizeKeyword(invalid));
  }
  assert.throws(() => analysisTarget("__proto__", "create"));
  assert.throws(() => analysisTarget("constructor", "create"));
  assert.deepEqual(PROVIDERS.map(({ id }) => id), ["google", "time", "geo", "bing", "domains", "ahrefs"]);
  for (const [provider, host] of [["google", "www.google.com"], ["bing", "www.bing.com"], ["domains", "instantdomainsearch.com"]]) {
    const result = analysisTarget(provider, keyword);
    for (const value of [result.url, result.frameUrl]) {
      const url = new URL(value);
      assert.equal(url.hostname, host);
      assert.equal(url.protocol, "https:");
      assert.equal(url.searchParams.get("q"), keyword);
      assert.equal(url.hash, "");
    }
    assert.equal(new URL(result.frameUrl).searchParams.get("igu"), provider === "google" ? "1" : null);
  }
  const ahrefs = analysisTarget("ahrefs", keyword);
  assert.equal(ahrefs.url, "https://ahrefs.com/keyword-generator");
  assert.equal(ahrefs.frameUrl, null); // Ahrefs denies framing and has no verified prefill link.
});

test("Time and Geo use chart embeds with the saved filters, but jump only to new Explore", () => {
  const keyword = "AI writer & 中文";
  const filters = { date: "2026-02-01 2026-03-01", geo: "US-CA" };
  for (const [provider, widget] of [["time", "TIMESERIES"], ["geo", "GEO_MAP"]]) {
    const result = analysisTarget(provider, keyword, filters, -480);
    const jump = new URL(result.url);
    assert.equal(jump.pathname, "/explore");
    assert.equal(jump.origin, "https://trends.google.com");
    assert.equal(jump.searchParams.get("q"), keyword);
    assert.equal(jump.searchParams.get("date"), filters.date);
    assert.equal(jump.searchParams.get("geo"), filters.geo);
    const frame = new URL(result.frameUrl);
    assert.equal(frame.pathname, `/trends/embed/explore/${widget}`);
    assert.deepEqual(JSON.parse(frame.searchParams.get("req")), {
      comparisonItem: [{ keyword, geo: filters.geo, time: filters.date }], category: 0, property: "",
    });
    assert.equal(frame.searchParams.get("tz"), "-480");
    assert.equal(frame.searchParams.get("eq"), jump.searchParams.toString());
    assert.throws(() => analysisTarget(provider, keyword, { date: "2026-02-30 2026-03-01" }));
    assert.throws(() => analysisTarget(provider, keyword, { geo: "US&date=all" }));
    assert.equal(new URL(analysisTarget(provider, "create").url).searchParams.get("date"), "today 1-m");
  }
});
