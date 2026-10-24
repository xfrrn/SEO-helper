import { TRENDS_ORIGIN, isTrendsUrl, exploreUrl } from "../explore.js";
import { normalizeKeyword } from "../analysis/core.js";

export const SETTINGS_KEY = "seoHelper:google-trends:page-actions";
export const DEFAULT_SETTINGS = { baselines: ["happy birthday images", "GPTs"] };
export const SCRIPT_ID = "seo-helper-trends-actions";
export const ANALYSIS_PAGE = "src/platforms/google-trends/analysis/sidepanel.html";
export const TRANSLATION_PERMISSION = "https://translate.googleapis.com/*";
export const requestKey = windowId => `seoHelper:trends:request:${windowId}`;
export const comparisonKey = windowId => `seoHelper:trends:comparison:${windowId}`;

export function isExploreUrl(value) {
  return isTrendsUrl(value) && ["/explore", "/explore/", "/trends/explore", "/trends/explore/"].includes(new URL(value).pathname);
}

export function validateSettings(value) {
  if (!value || !Array.isArray(value.baselines) || value.baselines.length !== 2) {
    throw new Error("快捷按钮设置无效，请重新保存。");
  }
  const baselines = value.baselines.map(normalizeKeyword);
  if (baselines[0].toLowerCase() === baselines[1].toLowerCase()) throw new Error("两个基准词不能相同。");
  return { baselines };
}

export function sourceTab(sender) {
  if (sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || !Number.isInteger(sender.tab?.windowId) || !isTrendsUrl(sender.url) || !isExploreUrl(sender.tab.url)) {
    throw new Error("仅支持 Google Trends 探索页的查询列表。");
  }
  if (sender.documentLifecycle && sender.documentLifecycle !== "active") throw new Error("来源页面已失效，请在当前探索页重试。");
  // SPA navigation changes tab.url while sender.url keeps the document's initial URL.
  if (sender.tab.pendingUrl && sender.tab.pendingUrl !== sender.tab.url) throw new Error("页面正在跳转，请加载完成后重试。");
  return sender.tab;
}

export function quickComparisonUrl(keyword, settings, sourceUrl) {
  if (!isExploreUrl(sourceUrl)) throw new Error("来源页面无效。");
  const config = validateSettings(settings);
  const words = [...config.baselines, normalizeKeyword(keyword)];
  const unique = words.filter((word, index) => words.findIndex(other => other.toLowerCase() === word.toLowerCase()) === index);
  const source = new URL(sourceUrl);
  return exploreUrl(unique.join(","), {
    date: source.searchParams.get("date") ?? "today 12-m",
    geo: source.searchParams.get("geo") ?? "",
  }, sourceUrl);
}

const comparisonQueues = new Map();
export function openQuickComparison(keyword, settings, source) {
  const url = quickComparisonUrl(keyword, settings, source.url);
  const pending = (comparisonQueues.get(source.windowId) ?? Promise.resolve()).catch(() => {}).then(() => openComparisonTab(url, source));
  comparisonQueues.set(source.windowId, pending);
  const cleanup = () => { if (comparisonQueues.get(source.windowId) === pending) comparisonQueues.delete(source.windowId); };
  pending.then(cleanup, cleanup);
  return pending;
}

async function openComparisonTab(url, source) {
  const key = comparisonKey(source.windowId);
  const saved = (await chrome.storage.session.get(key))[key];
  let tab;
  if (Number.isInteger(saved) && saved !== source.id) {
    try { tab = await chrome.tabs.get(saved); }
    catch (error) {
      if (!/No tab with id|Invalid tab ID/i.test(error.message)) throw error;
    }
  }
  if (tab?.windowId !== source.windowId || !isExploreUrl(tab?.pendingUrl || tab?.url)) tab = null;
  const result = tab ? await chrome.tabs.update(tab.id, { url, active: true })
    : await chrome.tabs.create({ windowId: source.windowId, url, active: true });
  await chrome.storage.session.set({ [key]: result.id });
  return result;
}

export const ORIGIN_PERMISSION = `${TRENDS_ORIGIN}/*`;
