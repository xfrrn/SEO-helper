import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { rateLimitDelay } from "../src/platforms/gamemonetize/game/batch.js";

const page = "https://gamemonetize.com/limited-game";
const now = Date.parse("2026-10-21T00:00:00Z");
const freshBatch = name => import(`../src/platforms/gamemonetize/game/batch.js?${name}`);
const limited = retryAfter => ({ ok: false, status: 429, headers: new Headers({ "Retry-After": retryAfter }) });
const unavailable = { ok: false, status: 503 };

test("rate limits accept Retry-After seconds and HTTP dates, with backoff for missing or invalid headers", () => {
  assert.equal(rateLimitDelay(" 120 ", 0, now), 120000);
  assert.equal(rateLimitDelay("0", 0, now), 0);
  assert.equal(rateLimitDelay(new Date(now + 90000).toUTCString(), 0, now), 90000);
  assert.equal(rateLimitDelay(new Date(now - 1000).toUTCString(), 0, now), 0);
  for (const header of [undefined, null, "", "invalid", "-1", "1.5"]) {
    assert.equal(rateLimitDelay(header, 0, now), 60000);
    assert.equal(rateLimitDelay(header, 1, now), 120000);
  }
});

test("batch games are paced and ordinary HTTP failures are not automatically retried", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  const { collectGameUrl } = await freshBatch("pacing");
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async () => { calls.push(Date.now()); return unavailable; };
  try {
    await assert.rejects(collectGameUrl(page), /HTTP 503/);
    const second = assert.rejects(collectGameUrl(page), /HTTP 503/);
    await setImmediate();
    assert.equal(calls.length, 1);
    t.mock.timers.tick(2999);
    await setImmediate();
    assert.equal(calls.length, 1);
    t.mock.timers.tick(1);
    await second;
    assert.deepEqual(calls, [now, now + 3000]);
  } finally { globalThis.fetch = previous; }
});

test("HTTP 429 waits for both Retry-After formats without spending the request timeout on the cooldown", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  const { collectGameUrl } = await freshBatch("retry-after");
  const previous = globalThis.fetch;
  const calls = [];
  const waits = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(Date.now());
    assert.equal(options.credentials, "include");
    assert.equal(options.signal.aborted, false);
    return calls.length === 1 ? limited("60") : calls.length === 2 ? limited(new Date(now + 150000).toUTCString()) : unavailable;
  };
  try {
    const done = assert.rejects(collectGameUrl(page, undefined, (seconds, limited) => waits.push({ seconds, limited })), /HTTP 503/);
    await setImmediate();
    t.mock.timers.tick(59999);
    await setImmediate();
    assert.equal(calls.length, 1);
    t.mock.timers.tick(1);
    await setImmediate();
    assert.equal(calls.length, 2);
    t.mock.timers.tick(89999);
    await setImmediate();
    assert.equal(calls.length, 2);
    t.mock.timers.tick(1);
    await done;
    assert.deepEqual(calls, [now, now + 60000, now + 150000]);
    assert.ok(waits.some(wait => wait.limited && wait.seconds === 60));
    assert.ok(waits.some(wait => wait.limited && wait.seconds === 90));
  } finally { globalThis.fetch = previous; }
});

test("stopping cancels the cooldown immediately and resuming still honors the remaining wait", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  const { collectGameUrl } = await freshBatch("abort-wait");
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? limited("60") : unavailable;
  try {
    const controller = new AbortController();
    const stopped = assert.rejects(collectGameUrl(page, controller.signal), { name: "AbortError" });
    await setImmediate();
    controller.abort();
    await stopped;
    const resumed = assert.rejects(collectGameUrl(page), /HTTP 503/);
    await setImmediate();
    t.mock.timers.tick(59999);
    await setImmediate();
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    await resumed;
    assert.equal(calls, 2);
  } finally { globalThis.fetch = previous; }
});

test("persistent HTTP 429 has a bounded retry count and never makes an immediate retry", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  const { collectGameUrl } = await freshBatch("retry-limit");
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async () => { calls.push(Date.now()); return limited("0"); };
  try {
    const done = assert.rejects(collectGameUrl(page), error => error.status === 429);
    await setImmediate();
    for (let attempt = 0; attempt < 2; attempt++) {
      t.mock.timers.tick(2999);
      await setImmediate();
      assert.equal(calls.length, attempt + 1);
      t.mock.timers.tick(1);
      await setImmediate();
    }
    await done;
    t.mock.timers.tick(3600000);
    await setImmediate();
    assert.deepEqual(calls, [now, now + 3000, now + 6000]);
  } finally { globalThis.fetch = previous; }
});
