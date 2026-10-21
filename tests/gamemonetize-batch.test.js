import test from "node:test";
import assert from "node:assert/strict";
import { inspectGameUrls, appendGameUrl, parseGameUrls, collectGameUrl, validateBatch, MAX_BATCH_URLS, BATCH_STORAGE_KEY } from "../src/platforms/gamemonetize/game/batch.js";
import { buildBatchZip } from "../src/platforms/gamemonetize/game/archive.js";

const origin = "https://gamemonetize.com";
const capture = { gameId: "87713", title: "测试 & 足球", pageUrl: `${origin}/a-game`, mobileReady: true, xml: '<rss>测试\r\n  原文</rss>', capturedAt: "2026-10-21T00:00:00.000Z" };
const success = { inputUrl: capture.pageUrl, status: "success", capture };

test("link inspection counts unique valid URLs while retaining incomplete and invalid edits", () => {
  const result = inspectGameUrls(` ${origin}/a-game#play \n\ninvalid\n${origin}/a-game\n${origin}/b-game?mode=1\n${origin}/b-game?mode=2`);
  assert.deepEqual(result.urls, [capture.pageUrl, `${origin}/b-game?mode=1`, `${origin}/b-game?mode=2`]);
  assert.equal(result.duplicates, 1);
  assert.equal(result.invalid.length, 1);
  assert.equal(result.invalid[0].line, 3);
  assert.equal(result.cleaned, `${origin}/a-game\ninvalid\n${origin}/b-game?mode=1\n${origin}/b-game?mode=2`);
  assert.deepEqual(inspectGameUrls(""), { urls: [], cleaned: "", duplicates: 0, invalid: [] });
  assert.equal(inspectGameUrls("https://").invalid.length, 1);
  assert.equal(inspectGameUrls("https://").cleaned, "https://");
});

test("adding a page deduplicates fragments, preserves existing edits and enforces the unique-link limit", () => {
  const first = appendGameUrl("", `${origin}/a-game#play`);
  assert.equal(first.cleaned, capture.pageUrl);
  assert.equal(first.added, true);
  const duplicate = appendGameUrl(`${origin}/a-game\ninvalid\n${origin}/a-game#info`, `${origin}/a-game#play`);
  assert.equal(duplicate.cleaned, `${origin}/a-game\ninvalid`);
  assert.equal(duplicate.added, false);
  assert.equal(duplicate.urls.length, 1);
  const second = appendGameUrl(`${origin}/a-game`, `${origin}/b-game`);
  assert.deepEqual(second.urls, [capture.pageUrl, `${origin}/b-game`]);
  const full = Array.from({ length: MAX_BATCH_URLS }, (_, index) => `${origin}/${index}-game`).join("\n");
  assert.equal(appendGameUrl(full, `${origin}/0-game#play`).urls.length, MAX_BATCH_URLS);
  assert.throws(() => appendGameUrl(full, `${origin}/new-game`), /最多 200/);
  assert.throws(() => appendGameUrl(capture.pageUrl, "https://example.com/game"), /gamemonetize.com/);
});

test("batch URLs preserve order and queries, ignore fragments and duplicates, and reject unsafe or oversized inputs", () => {
  assert.equal(BATCH_STORAGE_KEY, "seoHelper:gamemonetize:batch");
  assert.deepEqual(parseGameUrls(`\n ${origin}/a-game#play \r\n${origin}/a-game\n${origin}/b-game?ref=example`), [capture.pageUrl, `${origin}/b-game?ref=example`]);
  for (const input of ["", "   ", "http://gamemonetize.com/a-game", "https://gamemonetize.com.evil.test/a-game", "https://user:pass@gamemonetize.com/a-game", "https://gamemonetize.com:1234/a-game", "javascript:alert(1)"]) {
    assert.throws(() => parseGameUrls(input));
  }
  assert.throws(() => parseGameUrls(`${origin}/a-game\ninvalid`), /第 2 行/);
  assert.equal(parseGameUrls(Array.from({ length: MAX_BATCH_URLS }, (_, i) => `${origin}/${i}-game`).join("\n")).length, MAX_BATCH_URLS);
  assert.throws(() => parseGameUrls(Array.from({ length: MAX_BATCH_URLS + 1 }, (_, i) => `${origin}/${i}-game`).join("\n")), /最多 200/);
});

test("saved batches validate each outcome without treating pending or failed games as captures", () => {
  const rows = [success, { inputUrl: `${origin}/b-game`, status: "error", error: "HTTP 503" }, { inputUrl: `${origin}/c-game`, status: "pending" }];
  assert.deepEqual(validateBatch({ input: "unfinished editor input", rows }), { input: "unfinished editor input", rows });
  for (const row of [{ ...success, capture: { ...capture, mobileReady: "Yes" } }, { inputUrl: "https://example.com/game", status: "pending" }, { inputUrl: capture.pageUrl, status: "running" }, { inputUrl: capture.pageUrl, status: "error", error: "" }]) {
    assert.throws(() => validateBatch({ input: "", rows: [row] }));
  }
  assert.throws(() => validateBatch({ input: "", rows: [success, success] }));
  assert.throws(() => validateBatch(null));
});

test("batch HTML fetch validates hosts and redirects, sends credentials and propagates network and abort errors", async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, capture.pageUrl);
    assert.equal(options.credentials, "include");
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: false, status: 503 };
  };
  try {
    await assert.rejects(collectGameUrl("https://example.com/game"), /gamemonetize.com/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(collectGameUrl(capture.pageUrl, controller.signal), { name: "AbortError" });
    assert.equal(calls, 0);
    await assert.rejects(collectGameUrl(capture.pageUrl), /HTTP 503/);
    assert.equal(calls, 1);
    globalThis.fetch = async () => ({ ok: true, url: "https://example.com/login" });
    await assert.rejects(collectGameUrl(capture.pageUrl), /跳转到其他网站/);
    globalThis.fetch = async () => { throw new DOMException("timeout", "TimeoutError"); };
    await assert.rejects(collectGameUrl(capture.pageUrl), /页面请求超过 15 秒/);
    globalThis.fetch = async () => { throw new Error("Network unavailable"); };
    await assert.rejects(collectGameUrl(capture.pageUrl), /Network unavailable/);
  } finally { globalThis.fetch = previous; }
});

function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const entries = new Map();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    assert.equal(view.getUint16(offset + 6, true), 0x0800);
    assert.equal(view.getUint16(offset + 8, true), 0);
    const size = view.getUint32(offset + 18, true);
    assert.equal(view.getUint32(offset + 22, true), size);
    const nameSize = view.getUint16(offset + 26, true);
    const dataOffset = offset + 30 + nameSize + view.getUint16(offset + 28, true);
    const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameSize));
    assert.equal(entries.has(name), false);
    entries.set(name, { text: decoder.decode(bytes.subarray(dataOffset, dataOffset + size)), crc: view.getUint32(offset + 14, true), offset });
    offset = dataOffset + size;
  }
  const directoryOffset = offset;
  for (const [name, file] of entries) {
    assert.equal(view.getUint32(offset, true), 0x02014b50);
    assert.equal(view.getUint32(offset + 16, true), file.crc);
    assert.equal(view.getUint32(offset + 42, true), file.offset);
    const nameSize = view.getUint16(offset + 28, true);
    assert.equal(decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameSize)), name);
    offset += 46 + nameSize;
  }
  assert.equal(view.getUint32(offset, true), 0x06054b50);
  assert.equal(view.getUint16(offset + 8, true), entries.size);
  assert.equal(view.getUint16(offset + 10, true), entries.size);
  assert.equal(view.getUint32(offset + 12, true), offset - directoryOffset);
  assert.equal(view.getUint32(offset + 16, true), directoryOffset);
  assert.equal(offset + 22, bytes.length);
  return entries;
}

test("ZIP preserves raw UTF-8 XML and records mobile, failed and pending outcomes with unique file paths", async () => {
  const rows = [success, { inputUrl: `${origin}/alias-game`, status: "success", capture: { ...capture, mobileReady: false } }, { inputUrl: `${origin}/b-game`, status: "error", error: "HTTP 503" }, { inputUrl: `${origin}/c-game`, status: "pending" }];
  const zip = buildBatchZip(rows);
  assert.equal(zip.type, "application/zip");
  const files = readZip(new Uint8Array(await zip.arrayBuffer()));
  assert.deepEqual([...files.keys()], ["manifest.json", "xml/1-87713.xml", "xml/2-87713.xml"]);
  assert.equal(files.get("xml/1-87713.xml").text, capture.xml);
  const manifest = JSON.parse(files.get("manifest.json").text);
  assert.equal(manifest.total, 4);
  assert.equal(manifest.success, 2);
  assert.equal(manifest.failed, 1);
  assert.equal(manifest.pending, 1);
  assert.equal(manifest.results[0].mobileReady, true);
  assert.equal(manifest.results[1].mobileReady, false);
  assert.equal(manifest.results[0].xmlFile, "xml/1-87713.xml");
  assert.equal(manifest.results[0].xml, undefined);
  assert.equal(manifest.results[2].error, "HTTP 503");
  assert.equal(manifest.results[2].xmlFile, undefined);
  assert.equal(manifest.results[3].status, "pending");
  const checksumZip = readZip(new Uint8Array(await buildBatchZip([{ ...success, capture: { ...capture, xml: "123456789", mobileReady: null } }]).arrayBuffer()));
  assert.equal(checksumZip.get("xml/1-87713.xml").crc, 0xcbf43926);
  assert.equal(JSON.parse(checksumZip.get("manifest.json").text).results[0].mobileReady, null);
  assert.throws(() => buildBatchZip([]), /还没有采集成功/);
});
