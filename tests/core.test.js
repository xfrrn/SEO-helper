import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_URL, researchUrl, researchKey, keywordUrl, parseRoots, parseBatches, appendRootBatches, filterDescription, numericValue, normalizeRows, mergeCapture } from "../src/platforms/sem/keyword-magic/core.js";
import { PRESET_ROOTS } from "../src/platforms/sem/keyword-magic/root-library.js";
import { collectTab } from "../src/platforms/sem/keyword-magic/collector.js";
import { normalizeDownloadFolder, matchesNativeDownload, watchNativeDownload, exportNativeFile } from "../src/platforms/sem/keyword-magic/native-export.js";

const capture = {
  url: DEFAULT_URL, page: "1", currency: "USD", capturedAt: "2026-10-01T06:00:00Z",
  headers: ["", "关键词", "意图", "搜索量", "KD", "CPC (USD)", "SERP 精选结果", "已更新"],
  rows: [["", "how to check tire tread", "I", "110,000", "24", "0.15", "", "1 个月"]],
  summary: { total_keywords: "10", total_volume: "579,300", average_kd: "22%" },
};

test("replace only q, reset page, preserve opaque filters and omit access marker", () => {
  const original = `${DEFAULT_URL}&page=5&__gmitm=temporary&sort=volume%3Adesc`;
  const url = keywordUrl(original, "AI writer & 中文+1");
  assert.equal(new URL(url).searchParams.get("q"), "AI writer & 中文+1");
  assert.equal(url.split("&filter=")[1].split("&")[0], DEFAULT_URL.split("&filter=")[1]);
  assert.equal(new URL(url).searchParams.get("sort"), "volume:desc");
  assert.ok(!url.includes("__gmitm") && !url.includes("page="));
  assert.equal(new URL(url).searchParams.get("db"), "us");
  assert.equal(researchKey(`${DEFAULT_URL}&page=2`), researchKey(keywordUrl(DEFAULT_URL, "checker")));
});

test("only the requested SEM destination is allowed", () => {
  for (const url of ["javascript:alert(1)", "https://sim.3ue.co/?q=x", "https://sem.3ue.co.evil.test/analytics/keywordmagic/?q=x", "https://sem.3ue.co/analytics/keywordmagic/", "http://sem.3ue.co/analytics/keywordmagic/?q=x", "https://user:pass@sem.3ue.co/analytics/keywordmagic/?q=x"]) {
    assert.throws(() => researchUrl(url));
  }
  assert.throws(() => keywordUrl(DEFAULT_URL, " "));
});

test("roots preserve phrases and remove case insensitive duplicates", () => {
  assert.deepEqual(parseRoots(" checker\nChecker,ai   writer；中文词根\n\ncalculator"), ["checker", "ai writer", "中文词根", "calculator"]);
  assert.throws(() => parseRoots(Array.from({ length: 201 }, (_, i) => `root${i}`).join("\n")));
});

test("each input line stays one batch, with deduplication inside each line only", () => {
  assert.deepEqual(parseBatches(" Checker,calculator,checker\r\n\nai   writer，translator；converter\nchecker"), [
    ["Checker", "calculator"], ["ai writer", "translator", "converter"], ["checker"],
  ]);
  assert.deepEqual(parseBatches(" \n,，;；\r\n"), []);
  assert.deepEqual(parseBatches("checker\nchecker"), [["checker"], ["checker"]]);
  assert.throws(() => parseBatches(Array(201).fill("checker").join("\n")), /200/);
  assert.throws(() => parseBatches("x".repeat(151)), /150/);
});

test("decode actual supplied filter and tolerate unknown filter encodings", async () => {
  const description = await filterDescription(DEFAULT_URL);
  assert.match(description, /搜索量 ≥ 30,000/);
  assert.match(description, /KD ≤ 29/);
  assert.match(description, /CPC ≥ 0/);
  assert.match(await filterDescription("https://sem.3ue.co/analytics/keywordmagic/?q=x&filter=invalid"), /保留/);
});

test("the preset library contains all 51 supplied roots and their reference descriptions", () => {
  assert.deepEqual(PRESET_ROOTS.map((item) => item.root), "Translator,Generator,Example,Convert,Online,Downloader,Maker,Creator,Editor,Processor,Designer,Compiler,Analyzer,Evaluator,Sender,Receiver,Interpreter,Uploader,Calculator,Sample,Template,Format,Builder,Scheme,Pattern,Checker,Detector,Scraper,Manager,Explorer,Dashboard,Planner,Tracker,Recorder,Optimizer,Scheduler,Converter,Viewer,Extractor,Monitor,Notifier,Verifier,Simulator,Assistant,Constructor,Comparator,Navigator,Syncer,Connector,Cataloger,Responder".split(","));
  assert.ok(PRESET_ROOTS.every((item) => item.meaning && item.examples));
  assert.equal(PRESET_ROOTS.find((item) => item.root === "Translator").examples, "Google Translator、Online Translator");
});

test("library selection appends batches of five without duplicating active roots or exceeding the limit", () => {
  const all = appendRootBatches("", PRESET_ROOTS.map((item) => item.root));
  assert.equal(all.added, 51);
  assert.equal(all.firstBatch, 0);
  assert.deepEqual(parseBatches(all.roots).map((batch) => batch.length), [...Array(10).fill(5), 1]);
  const append = appendRootBatches("Checker, calculator\nAI writer", ["checker", "Generator", "Maker", "Editor", "Viewer", "Monitor", "Responder", "generator"]);
  assert.deepEqual(parseBatches(append.roots), [["Checker", "calculator"], ["AI writer"], ["Generator", "Maker", "Editor", "Viewer", "Monitor"], ["Responder"]]);
  assert.equal(append.firstBatch, 2);
  assert.equal(append.added, 6);
  assert.equal(appendRootBatches("checker", ["Checker"]).added, 0);
  assert.equal(appendRootBatches("", []).roots, "");
  assert.throws(() => appendRootBatches(Array.from({ length: 200 }, (_, index) => `root${index}`).join(","), ["new root"]), /200/);
});

test("metrics distinguish zero, absent and abbreviated numbers", () => {
  assert.equal(numericValue("110,000"), 110000);
  assert.equal(numericValue("33.1K"), 33100);
  assert.equal(numericValue("3.2万"), 32000);
  assert.equal(numericValue("0.00"), 0);
  assert.equal(numericValue("—"), null);
  assert.equal(numericValue(""), null);
  const [row] = normalizeRows(capture);
  assert.equal(row.keyword, "how to check tire tread");
  assert.equal(row.volume, 110000);
  assert.equal(row.kd, 24);
  assert.equal(row.cpc, 0.15);
  assert.throws(() => normalizeRows({ headers: ["name"], rows: [["x"]] }));
});

test("append pages, deduplicate keywords, and replace a refreshed page", () => {
  const first = mergeCapture(null, capture);
  const secondCapture = { ...capture, page: "2", url: `${DEFAULT_URL}&page=2`, rows: [...capture.rows, ["", "check disk", "I", "74,000", "20", "0"]] };
  const second = mergeCapture(first, secondCapture);
  assert.equal(second.rows.length, 2);
  assert.equal(second.captures.length, 2);
  assert.equal(second.rows[0].currency, "USD");
  assert.equal(mergeCapture(second, secondCapture).rows.length, 2);
  const unknownFirst = mergeCapture(null, { ...capture, page: "unknown" });
  const unknownNext = { ...secondCapture, page: "unknown", url: DEFAULT_URL };
  const unknown = mergeCapture(unknownFirst, unknownNext);
  assert.equal(unknown.captures.length, 2);
  assert.equal(mergeCapture(unknown, unknownNext).captures.length, 2);
});

test("collection waits for stable rows, stops on wrong query and respects cancellation", async () => {
  globalThis.chrome = {
    tabs: { get: async () => ({ url: DEFAULT_URL, status: "complete" }) },
    scripting: { executeScript: async () => [{ result: capture }] },
  };
  try {
    const result = await collectTab(1, DEFAULT_URL, { settleMs: 0, timeoutMs: 5000 });
    assert.equal(result.rows.length, 1);
    chrome.scripting.executeScript = async () => [{ result: { ...capture, rows: [], empty: true } }];
    const empty = await collectTab(1, DEFAULT_URL, { settleMs: 0, timeoutMs: 5000 });
    assert.equal(empty.empty, true);
    assert.deepEqual(empty.rows, []);
    await assert.rejects(collectTab(1, keywordUrl(DEFAULT_URL, "other")), /筛选条件已改变/);
    chrome.tabs.get = async () => ({ url: "https://dash.3ue.co/login", status: "complete" });
    await assert.rejects(collectTab(1, DEFAULT_URL), /登录状态/);
    chrome.tabs.get = async () => ({ url: DEFAULT_URL, status: "complete" });
    const stop = new AbortController();
    stop.abort();
    await assert.rejects(collectTab(1, DEFAULT_URL, { signal: stop.signal }), { name: "AbortError" });
    chrome.scripting.executeScript = async () => [{ result: { ...capture, fatal: true, error: "需要登录" } }];
    await assert.rejects(collectTab(1, DEFAULT_URL), /需要登录/);
    chrome.scripting.executeScript = async () => [{ result: { ...capture, rows: undefined, error: "尚未识别到关键词表格" } }];
    await assert.rejects(collectTab(1, DEFAULT_URL, { timeoutMs: 50 }), /尚未识别/);
  } finally { delete globalThis.chrome; }
});

test("native export confirms a stable empty result without clicking or watching downloads", async () => {
  let samples = 0;
  globalThis.chrome = {
    tabs: { get: async () => ({ url: DEFAULT_URL, status: "complete" }) },
    scripting: { executeScript: async ({ func }) => {
      assert.equal(func.name, "readRenderedPage"); // No export click or downloads API is needed.
      samples++;
      return [{ result: { ...capture, rows: [], empty: true, busy: samples === 3 } }];
    } },
  };
  try {
    const result = await exportNativeFile(1, DEFAULT_URL, { settleMs: 0 });
    assert.equal(result.empty, true);
    assert.ok(samples >= 9); // Loading resets the stability period.
    assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
    assert.equal(result.downloadId, undefined);
    samples = 0;
    chrome.scripting.executeScript = async () => [{ result: ++samples === 1
      ? { ...capture, rows: [], empty: true } : { ...capture, fatal: true, error: "需要登录" } }];
    await assert.rejects(exportNativeFile(1, DEFAULT_URL, { settleMs: 0 }), /需要登录/);
    chrome.scripting.executeScript = async () => [{ result: { ...capture, rows: [], empty: true, busy: true } }];
    await assert.rejects(exportNativeFile(1, DEFAULT_URL, { signal: AbortSignal.timeout(50), settleMs: 0 }), { name: "TimeoutError" });
    chrome.tabs.get = async () => ({ url: DEFAULT_URL, status: "loading" });
    chrome.scripting.executeScript = async () => { assert.fail("Do not inspect a navigating page"); };
    await assert.rejects(exportNativeFile(1, DEFAULT_URL, { signal: AbortSignal.timeout(50), settleMs: 0 }), { name: "TimeoutError" });
    const stop = new AbortController();
    chrome.tabs.get = async () => ({ url: DEFAULT_URL, status: "complete" });
    chrome.scripting.executeScript = async ({ func }) => {
      assert.equal(func.name, "readRenderedPage");
      stop.abort();
      return [{ result: capture }];
    };
    await assert.rejects(exportNativeFile(1, DEFAULT_URL, { signal: stop.signal, settleMs: 0 }), { name: "AbortError" });
  } finally { delete globalThis.chrome; }
});

test("only new SEM downloads of the chosen format match the export", () => {
  const started = Date.now();
  const item = { startTime: new Date(started).toISOString(), url: "blob:https://sem.3ue.co/example", referrer: DEFAULT_URL, filename: "checker.csv", mime: "text/csv" };
  assert.equal(matchesNativeDownload(item, DEFAULT_URL, "CSV", started), true);
  assert.equal(matchesNativeDownload(item, DEFAULT_URL, "XLSX", started), false);
  assert.equal(matchesNativeDownload({ ...item, startTime: "invalid" }, DEFAULT_URL, "CSV", started), false);
  assert.equal(matchesNativeDownload(item, DEFAULT_URL, "CSV", started + 1), false);
  assert.equal(matchesNativeDownload({ ...item, referrer: keywordUrl(DEFAULT_URL, "other") }, DEFAULT_URL, "CSV", started), false);
  assert.equal(matchesNativeDownload({ ...item, referrer: "https://other.test/?q=Checker" }, DEFAULT_URL, "CSV", started), false);
  assert.equal(matchesNativeDownload({ ...item, url: "https://other.test/file.csv", referrer: "" }, DEFAULT_URL, "CSV", started), false);
});

test("download folders accept relative subfolders and reject absolute or unsafe paths", () => {
  assert.equal(normalizeDownloadFolder(" SEO-Helper\\项目 A/ "), "SEO-Helper/项目 A");
  assert.equal(normalizeDownloadFolder(""), "");
  for (const folder of ["D:\\SEO", "C:SEO", "\\\\server\\share", "/tmp", "..", "a/../b", "./a", "a//b", "a/CON", "a/lpt1.csv", "bad?.dir", "bad./ok", "bad /ok", "bad\u0000name", "x".repeat(181)]) {
    assert.throws(() => normalizeDownloadFolder(folder), folder);
  }
});

test("native downloads route only the active export, wait for completion and clean up listeners", async () => {
  const event = () => {
    const listeners = new Set();
    return { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn), emit: (...args) => [...listeners].forEach((fn) => fn(...args)), listeners };
  };
  const onCreated = event();
  const onChanged = event();
  const onDeterminingFilename = event();
  let item;
  globalThis.chrome = { downloads: { onCreated, onChanged, onDeterminingFilename, search: async () => [item] } };
  try {
    const watch = watchNativeDownload(DEFAULT_URL, "CSV", { folder: "SEO-Helper/项目 A", timeoutMs: 2000 });
    item = { id: 1, startTime: new Date().toISOString(), url: "https://sem.3ue.co/export", referrer: DEFAULT_URL, filename: "checker.csv", state: "in_progress" };
    onCreated.emit(item); // Events before the format click are ignored.
    assert.equal(onCreated.listeners.size, 1);
    const suggestions = [];
    const suggest = (value) => suggestions.push(value);
    onDeterminingFilename.emit(item, suggest);
    assert.deepEqual(suggestions, [undefined]);
    watch.arm();
    onDeterminingFilename.emit({ ...item, url: "https://other.test/file.csv", referrer: "" }, suggest);
    onDeterminingFilename.emit({ ...item, referrer: keywordUrl(DEFAULT_URL, "other") }, suggest);
    onDeterminingFilename.emit({ ...item, startTime: "2000-01-01T00:00:00Z" }, suggest);
    onDeterminingFilename.emit({ ...item, filename: "checker.xlsx" }, suggest);
    assert.deepEqual(suggestions, Array(5).fill(undefined));
    onDeterminingFilename.emit({ ...item, filename: "C:\\Downloads\\checker.csv" }, suggest);
    assert.deepEqual(suggestions.at(-1), { filename: "SEO-Helper/项目 A/checker.csv", conflictAction: "uniquify" });
    onDeterminingFilename.emit({ ...item, id: 99 }, suggest);
    assert.equal(suggestions.at(-1), undefined);
    let completed = false;
    watch.promise.then(() => { completed = true; });
    onCreated.emit(item);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(completed, false);
    item = { ...item, state: "complete" };
    onChanged.emit({ id: 1, state: { current: "complete" } });
    assert.equal((await watch.promise).id, 1);
    assert.equal(onCreated.listeners.size, 0);
    assert.equal(onChanged.listeners.size, 0);
    assert.equal(onDeterminingFilename.listeners.size, 0);

    const failed = watchNativeDownload(DEFAULT_URL, "CSV", { folder: "test", timeoutMs: 2000 });
    failed.arm();
    item = { ...item, id: 2, startTime: new Date().toISOString(), state: "interrupted", error: "USER_CANCELED" };
    onCreated.emit(item);
    await assert.rejects(failed.promise, /USER_CANCELED/);
    const networkFailure = watchNativeDownload(DEFAULT_URL, "CSV", { timeoutMs: 2000 });
    assert.equal(onDeterminingFilename.listeners.size, 0); // Blank folder keeps the browser's normal destination.
    networkFailure.arm();
    item = { ...item, id: 3, startTime: new Date().toISOString(), filename: "", mime: "", error: "NETWORK_FAILED" };
    onCreated.emit(item);
    await assert.rejects(networkFailure.promise, /NETWORK_FAILED/);
    const stopped = new AbortController();
    const canceled = watchNativeDownload(DEFAULT_URL, "CSV", { signal: stopped.signal, folder: "test" });
    stopped.abort();
    await assert.rejects(canceled.promise, { name: "AbortError" });
    const timedOut = watchNativeDownload(DEFAULT_URL, "CSV", { timeoutMs: 5, folder: "test" });
    await assert.rejects(timedOut.promise, /未确认网站文件下载完成/);
    assert.equal(onCreated.listeners.size + onChanged.listeners.size + onDeterminingFilename.listeners.size, 0);
  } finally { delete globalThis.chrome; }
});
