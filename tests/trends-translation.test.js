import test from "node:test";
import assert from "node:assert/strict";
import { translateKeyword } from "../src/platforms/google-trends/page-actions/translation.js";

test("online translation sends only a validated keyword to Google and joins all segments", async () => {
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async (value, options) => {
    called = true;
    const url = new URL(value);
    assert.equal(url.origin + url.pathname, "https://translate.googleapis.com/translate_a/single");
    assert.equal(url.searchParams.get("q"), "C++ & Scheduler/#?");
    assert.equal(url.searchParams.get("sl"), "auto");
    assert.equal(url.searchParams.get("tl"), "zh-CN");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json([[["C++ 与", "C++ &"], ["调度程序", "Scheduler/#?"]]]);
  };
  try {
    await assert.rejects(translateKeyword(""));
    await assert.rejects(translateKeyword("x".repeat(151)));
    assert.equal(called, false);
    assert.equal(await translateKeyword("C++ & Scheduler/#?"), "C++ 与调度程序");
  } finally { globalThis.fetch = realFetch; }
});

test("translation exposes HTTP, malformed data, empty responses, network and timeout failures", async () => {
  const realFetch = globalThis.fetch;
  try {
    for (const status of [403, 429, 500]) {
      globalThis.fetch = async () => new Response("unavailable", { status });
      await assert.rejects(translateKeyword("scheduler"), new RegExp(`HTTP ${status}`));
    }
    for (const data of [null, {}, [], [[]], [[null]], [[[123]]], [[["a"], [null]]]]) {
      globalThis.fetch = async () => Response.json(data);
      await assert.rejects(translateKeyword("scheduler"), /无法识别/);
    }
    globalThis.fetch = async () => Response.json([[[" "]]]);
    await assert.rejects(translateKeyword("scheduler"), /未返回译文/);
    globalThis.fetch = async () => new Response("invalid json");
    await assert.rejects(translateKeyword("scheduler"), SyntaxError);
    for (const error of [new Error("offline"), new DOMException("timed out", "TimeoutError")]) {
      globalThis.fetch = async () => { throw error; };
      await assert.rejects(translateKeyword("scheduler"), error);
    }
  } finally { globalThis.fetch = realFetch; }
});
