import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ORIGIN, STORAGE_KEY, collectCurrentGame, currentGameTab, validateCapture, mobileReadyLabel } from "../src/platforms/gamemonetize/game/core.js";
import { readGamePage } from "../src/platforms/gamemonetize/game/collector.js";

const capture = {
  gameId: "87713", title: "Synthetic test game", pageUrl: `${ORIGIN}/test-game`,
  mobileReady: true, xml: '<?xml version="1.0"?><rss><channel><item><id>87713</id></item></channel></rss>',
  capturedAt: "2026-10-21T00:00:00.000Z",
};

test("current-page lookup reads only the active current-window URL without collecting a game", async () => {
  const previous = globalThis.chrome;
  const tab = { id: 9, url: capture.pageUrl + "#play" };
  globalThis.chrome = {
    permissions: { request: async () => true },
    tabs: { query: async query => { assert.deepEqual(query, { active: true, currentWindow: true }); return [tab]; } },
  };
  try {
    assert.deepEqual(await currentGameTab(), tab);
    tab.pendingUrl = `${ORIGIN}/another-game`;
    await assert.rejects(currentGameTab(), /正在跳转/);
    delete tab.pendingUrl;
    tab.url = "https://example.com/game";
    await assert.rejects(currentGameTab(), /请先切换到 GameMonetize/);
  } finally { globalThis.chrome = previous; }
});

test("game captures distinguish Yes, No and absent mobile labels and validate saved data", () => {
  assert.equal(mobileReadyLabel(true), "支持（Yes）");
  assert.equal(mobileReadyLabel(false), "不支持（No）");
  assert.equal(mobileReadyLabel(null), "未标注");
  for (const mobileReady of [true, false, null]) assert.equal(validateCapture({ ...capture, mobileReady }).mobileReady, mobileReady);
  for (const patch of [
    { gameId: "../1" }, { title: "" }, { xml: " " }, { mobileReady: "Yes" }, { mobileReady: undefined }, { capturedAt: "invalid" },
    { pageUrl: "https://gamemonetize.com.evil.test/game" }, { pageUrl: "http://gamemonetize.com/game" },
    { pageUrl: "https://user:password@gamemonetize.com/game" }, { pageUrl: "not a URL" },
  ]) assert.throws(() => validateCapture({ ...capture, ...patch }), /采集结果不完整/);
  assert.throws(() => validateCapture(null), /采集结果不完整/);
});

test("game collection requests only its host and injects into the active current-window game tab", async () => {
  const previous = globalThis.chrome;
  let injections = 0;
  globalThis.chrome = {
    permissions: { request: async permission => { assert.deepEqual(permission, { origins: [`${ORIGIN}/*`] }); return true; } },
    tabs: {
      query: async query => { assert.deepEqual(query, { active: true, currentWindow: true }); return [{ id: 7, url: capture.pageUrl }]; },
      get: async id => { assert.equal(id, 7); return { url: capture.pageUrl }; },
    },
    scripting: { executeScript: async injection => {
      injections++;
      assert.deepEqual(injection.target, { tabId: 7 });
      assert.equal(injection.func, readGamePage);
      assert.deepEqual(injection.args, [capture.pageUrl]);
      return [{ result: capture }];
    } },
  };
  try {
    assert.deepEqual(await collectCurrentGame(), capture);
    assert.equal(injections, 1);
    chrome.permissions.request = async () => false;
    await assert.rejects(collectCurrentGame(), /请允许访问 GameMonetize/);
    assert.equal(injections, 1);
    chrome.permissions.request = async () => true;
    for (const url of [undefined, "https://example.com/game", "http://gamemonetize.com/game", "https://gamemonetize.com.evil.test/game"]) {
      chrome.tabs.query = async () => [{ id: 7, url }];
      await assert.rejects(collectCurrentGame(), /请先切换到 GameMonetize/);
    }
    chrome.tabs.query = async () => [];
    await assert.rejects(collectCurrentGame(), /请先切换到 GameMonetize/);
    assert.equal(injections, 1);
    chrome.tabs.query = async () => [{ id: 7, url: capture.pageUrl }];
    chrome.scripting.executeScript = async () => [{ result: { error: "XML 请求失败（HTTP 503）" } }];
    await assert.rejects(collectCurrentGame(), /HTTP 503/);
    chrome.scripting.executeScript = async () => [];
    await assert.rejects(collectCurrentGame(), /采集结果不完整/);
    chrome.scripting.executeScript = async () => [{ result: capture }];
    chrome.tabs.get = async () => ({ url: `${ORIGIN}/another-game` });
    await assert.rejects(collectCurrentGame(), /页面已切换/);
    chrome.tabs.get = async () => ({ url: capture.pageUrl });
    chrome.scripting.executeScript = async () => [{ result: { ...capture, pageUrl: `${ORIGIN}/another-game` } }];
    await assert.rejects(collectCurrentGame(), /页面已切换/);
    chrome.scripting.executeScript = async () => { throw new Error("Cannot access contents of the page"); };
    await assert.rejects(collectCurrentGame(), /Cannot access/);
  } finally { globalThis.chrome = previous; }
});

test("GameMonetize uses an independent storage key and optional host access without extra permissions", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(STORAGE_KEY, "seoHelper:gamemonetize:game");
  assert.ok(manifest.optional_host_permissions.includes(`${ORIGIN}/*`));
  assert.equal(manifest.host_permissions?.some(host => host.includes("gamemonetize")) ?? false, false);
  assert.deepEqual(manifest.permissions, ["sidePanel", "storage", "activeTab", "scripting"]);
  assert.ok(!manifest.permissions.includes("downloads"));
});
