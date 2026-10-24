import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_URL, researchUrl, keywordUrl, researchKey, rootFromUrl, filterDescription, mergeCapture, parseBatches, appendRootBatches } from "../src/platforms/sim/keyword-generator/core.js";
import { collectTab } from "../src/platforms/sim/keyword-generator/collector.js";

test("SIM replaces the hash keyword while preserving route and opaque filters", () => {
  const input = DEFAULT_URL.replace('/#', '/?__gmitm=temporary#') + '&page=3&pageIndex=2&custom=a%2Bb%2F%3D';
  const url = new URL(keywordUrl(input, "AI writer + 中文 & #"));
  const params = new URLSearchParams(url.hash.split('?')[1]);
  assert.equal(url.origin, "https://sim.3ue.co");
  assert.ok(url.hash.startsWith('#/digitalsuite/acquisition/findkeywords/keyword-generator-tool/999/28d?'));
  assert.equal(params.get('keyword'), 'AI writer + 中文 & #');
  assert.equal(params.get('volumeFromValue'), '30000');
  assert.equal(params.get('difficultyFromValue'), '1');
  assert.equal(params.get('difficultyToValue'), '30');
  assert.equal(params.get('webSource'), 'Total');
  assert.equal(params.get('isWWW'), '*');
  assert.equal(params.has('page'), false);
  assert.equal(params.has('pageIndex'), false);
  assert.equal(url.search, '');
  assert.equal(rootFromUrl(url.href), 'AI writer + 中文 & #');
  assert.equal(researchUrl(DEFAULT_URL + '&__gmitm=temporary').href.includes('__gmitm'), false);
  assert.ok(url.hash.includes('custom=a%2Bb%2F%3D'));
  assert.equal(researchKey(DEFAULT_URL), researchKey(keywordUrl(DEFAULT_URL, 'CALCULATOR') + '&page=4'));
  assert.notEqual(researchKey(DEFAULT_URL), researchKey(DEFAULT_URL.replace('/999/28d', '/840/3m')));
  assert.notEqual(researchKey(DEFAULT_URL), researchKey(DEFAULT_URL.replace('30000', '40000')));
  for (const input of ['https://sim.3ue.co.evil.test/' + new URL(DEFAULT_URL).hash, DEFAULT_URL.replace('https:', 'http:'), DEFAULT_URL.replace('/#', '/login#'), DEFAULT_URL.replace('keyword=calculator', 'keyword='), DEFAULT_URL + '&keyword=other', DEFAULT_URL.replace('sim.3ue.co', 'user:pass@sim.3ue.co')]) assert.throws(() => researchUrl(input));
  assert.throws(() => keywordUrl(DEFAULT_URL, 'x'.repeat(151)));
  assert.match(filterDescription(DEFAULT_URL), /全球.*最近 28 天.*语句匹配.*搜索量 ≥ 30,000.*KD ≥ 1.*KD ≤ 30/);
  assert.deepEqual(parseBatches('calculator, AI writer\ncalculator'), [['calculator', 'AI writer'], ['calculator']]);
  assert.equal(appendRootBatches('calculator', ['Calculator', 'Translator']).added, 1);
});

test("SIM preview keeps period volume distinct from average volume", () => {
  const capture = { url: DEFAULT_URL, headers: ['', '', '关键词 (60)', '28 天的体量', '平均体量', '年趋势', '零点击搜索', 'KD', '意图', 'CPC', '领先者'], rows: [['', '1', 'emi calculator', '1.4M', '1.6M', '', '23%', '25', 'NAV', '$0.14', 'groww.in']], summary: { total_keywords: '60' } };
  assert.deepEqual(mergeCapture(undefined, capture).rows, [{ keyword: 'emi calculator', volume: 1400000, average_volume: 1600000, kd: 25, cpc: 0.14 }]);
  assert.equal(mergeCapture(undefined, { ...capture, rows: [], empty: true }).rows.length, 0);
  assert.throws(() => mergeCapture(undefined, { ...capture, headers: ['wrong'] }));
});

test("SIM collection rejects changed filters and login redirects, and supports cancellation", async () => {
  globalThis.chrome = { tabs: { get: async () => ({ status: 'complete', url: DEFAULT_URL.replace('30000', '40000') }) } };
  try {
    await assert.rejects(collectTab(1, DEFAULT_URL), /已跳转或筛选条件已改变/);
    chrome.tabs.get = async () => ({ status: 'complete', url: 'https://sim.3ue.co/login' });
    await assert.rejects(collectTab(1, DEFAULT_URL), /已跳转或筛选条件已改变/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(collectTab(1, DEFAULT_URL, { signal: controller.signal }), /abort/i);
  } finally { delete globalThis.chrome; }
});
