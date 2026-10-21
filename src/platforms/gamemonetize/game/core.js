import { readGamePage } from "./collector.js";

export const ORIGIN = "https://gamemonetize.com";
export const STORAGE_KEY = "seoHelper:gamemonetize:game";

export function isGameMonetizeUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === ORIGIN && !url.username && !url.password;
  } catch { return false; }
}

export function validateCapture(value) {
  if (!value || !/^[1-9]\d*$/.test(value.gameId) || typeof value.title !== "string" || !value.title.trim()
    || !isGameMonetizeUrl(value.pageUrl) || typeof value.xml !== "string" || !value.xml.trim()
    || ![true, false, null].includes(value.mobileReady) || !Number.isFinite(Date.parse(value.capturedAt))) {
    throw new Error("采集结果不完整，请重新采集当前游戏。");
  }
  return value;
}

export function mobileReadyLabel(value) {
  return value === true ? "支持（Yes）" : value === false ? "不支持（No）" : "未标注";
}

export async function permitGameMonetize() {
  if (!await chrome.permissions.request({ origins: [`${ORIGIN}/*`] })) {
    throw new Error("请允许访问 GameMonetize，以便读取游戏信息和 XML。");
  }
}

export async function currentGameTab() {
  await permitGameMonetize();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.pendingUrl) throw new Error("当前网页正在跳转，请等待加载完成后再操作。");
  if (!tab?.id || !isGameMonetizeUrl(tab.url)) {
    throw new Error("请先切换到 GameMonetize 游戏详情页，再操作当前网页。");
  }
  return tab;
}

export async function collectCurrentGame() {
  const tab = await currentGameTab();
  const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readGamePage, args: [tab.url] });
  const result = injection?.result;
  if (result?.error) throw new Error(result.error);
  validateCapture(result);
  if (result.pageUrl !== tab.url || (await chrome.tabs.get(tab.id)).url !== tab.url) {
    throw new Error("采集期间页面已切换，请在当前游戏页面重新采集。");
  }
  return result;
}
