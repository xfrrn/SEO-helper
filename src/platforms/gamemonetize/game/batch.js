import { isGameMonetizeUrl, validateCapture } from "./core.js";
import { readGamePage } from "./collector.js";

export const BATCH_STORAGE_KEY = "seoHelper:gamemonetize:batch";
export const MAX_BATCH_URLS = 200;

function normalizeUrl(value) {
  if (!isGameMonetizeUrl(value)) throw new Error("请使用 https://gamemonetize.com/ 下的游戏详情页链接。");
  const url = new URL(value);
  url.hash = "";
  return url.href;
}

export function inspectGameUrls(text) {
  const urls = new Set();
  const cleaned = [];
  const invalid = [];
  let duplicates = 0;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const url = normalizeUrl(line.trim());
      if (urls.has(url)) { duplicates++; continue; }
      urls.add(url);
      cleaned.push(url);
    } catch (error) {
      invalid.push({ line: index + 1, message: error.message });
      cleaned.push(line.trim());
    }
  }
  return { urls: [...urls], cleaned: cleaned.join("\n"), duplicates, invalid };
}

export function parseGameUrls(text) {
  const { urls, invalid } = inspectGameUrls(text);
  if (invalid.length) throw new Error(`第 ${invalid[0].line} 行：${invalid[0].message}`);
  if (!urls.length) throw new Error("请粘贴至少一个游戏详情页链接，每行一个。");
  if (urls.length > MAX_BATCH_URLS) throw new Error(`每批最多 ${MAX_BATCH_URLS} 个不同链接，请分批采集。`);
  return urls;
}

export function appendGameUrl(text, value) {
  const url = normalizeUrl(value);
  const existing = inspectGameUrls(text);
  const result = inspectGameUrls(`${text}\n${url}`);
  if (result.urls.length > MAX_BATCH_URLS) throw new Error(`每批最多 ${MAX_BATCH_URLS} 个不同链接，请分批采集。`);
  return { ...result, added: !existing.urls.includes(url) };
}

export function validateBatch(value) {
  if (!value || typeof value.input !== "string" || !Array.isArray(value.rows) || value.rows.length > MAX_BATCH_URLS) {
    throw new Error("批量采集记录无效，请重新粘贴链接开始采集。");
  }
  const seen = new Set();
  const rows = value.rows.map(row => {
    if (!row || normalizeUrl(row.inputUrl) !== row.inputUrl || seen.has(row.inputUrl)
      || !["pending", "success", "error"].includes(row.status)) throw new Error("批量采集记录无效，请重新采集。");
    seen.add(row.inputUrl);
    if (row.status === "success") return { inputUrl: row.inputUrl, status: row.status, capture: validateCapture(row.capture) };
    if (row.status === "error") {
      if (typeof row.error !== "string" || !row.error.trim()) throw new Error("批量失败记录缺少原因，请重新采集。");
      return { inputUrl: row.inputUrl, status: row.status, error: row.error };
    }
    return { inputUrl: row.inputUrl, status: "pending" };
  });
  return { input: value.input, rows };
}

export async function collectGameUrl(inputUrl, signal) {
  const url = normalizeUrl(inputUrl);
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(15000);
  let response;
  let html;
  try {
    response = await fetch(url, { credentials: "include", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) throw new Error(`游戏页面请求失败（HTTP ${response.status}）。`);
    if (!isGameMonetizeUrl(response.url)) throw new Error("游戏页面已跳转到其他网站，请检查原链接。");
    html = await response.text();
  } catch (error) {
    if (error.name === "TimeoutError") throw new Error("游戏页面请求超过 15 秒，请检查网络后重试。");
    throw error;
  }
  signal?.throwIfAborted();
  const result = await readGamePage(response.url, html, signal);
  signal?.throwIfAborted();
  if (result.error) throw new Error(result.error);
  return validateCapture(result);
}
