import { normalizeKeyword } from "../analysis/core.js";
import { SETTINGS_KEY, DEFAULT_SETTINGS, SCRIPT_ID, ANALYSIS_PAGE, ORIGIN_PERMISSION, TRANSLATION_PERMISSION, isExploreUrl, validateSettings, sourceTab, requestKey, openQuickComparison } from "./core.js";
import { translateKeyword } from "./translation.js";

const activities = new Map();
let enabled = false;
let synchronizing = Promise.resolve();
const contentFile = "src/platforms/google-trends/page-actions/content.js";

async function sync() {
  enabled = await chrome.permissions.contains({ origins: [ORIGIN_PERMISSION] });
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (enabled && !registered.length) {
    await chrome.scripting.registerContentScripts([{ id: SCRIPT_ID, matches: [ORIGIN_PERMISSION], js: [contentFile], runAt: "document_idle" }]);
  } else if (!enabled && registered.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  // Revocation hides tab URLs; sending cleanup to IDs still reaches our own scripts.
  const tabs = await chrome.tabs.query(enabled ? { url: ORIGIN_PERMISSION } : {});
  await Promise.all(tabs.filter(tab => !enabled || isExploreUrl(tab.url)).map(async tab => {
    try {
      if (enabled) await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [contentFile] });
      else await chrome.tabs.sendMessage(tab.id, { type: "trends:cleanup" });
    } catch (error) {
      // A closed/navigating tab or a page predating the script has nothing to clean up.
      if (!/No tab with id|No frame with id|Receiving end does not exist|Cannot access|Frame with ID|page was closed/i.test(error.message)) throw error;
    }
  }));
}

function synchronize() {
  synchronizing = synchronizing.catch(() => {}).then(sync);
  return synchronizing;
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "seoHelper:panel-activity" || port.sender?.id !== chrome.runtime.id) return;
  port.onMessage.addListener(value => {
    if (Number.isInteger(value.windowId) && typeof value.busy === "boolean") activities.set(port, value);
  });
  port.onDisconnect.addListener(() => activities.delete(port));
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (typeof message?.type !== "string" || !message.type.startsWith("trends:")) return;
  if (message.type === "trends:sync") {
    if (sender.id !== chrome.runtime.id || ![ANALYSIS_PAGE, "src/app/sidepanel.html"].some(page => sender.url?.split("?")[0] === chrome.runtime.getURL(page))) return;
    synchronize().then(() => respond({ ok: true, enabled }), error => respond({ ok: false, error: error.message }));
    return true;
  }
  if (!["trends:compare", "trends:analyze", "trends:translate"].includes(message.type)) return;
  try {
    const tab = sourceTab(sender);
    const keyword = normalizeKeyword(message.keyword);
    const checkPageAccess = async () => {
      if (!await chrome.permissions.contains({ origins: [ORIGIN_PERMISSION] })) throw new Error("请在扩展管理页允许 SEO Helper 访问 Google Trends。");
    };
    if (message.type === "trends:translate") {
      (async () => {
        await checkPageAccess();
        if (!await chrome.permissions.contains({ origins: [TRANSLATION_PERMISSION] })) throw new Error("请在扩展管理页允许 SEO Helper 访问 Google 翻译服务。");
        return translateKeyword(keyword);
      })().then(translation => respond({ ok: true, translation }), error => respond({ ok: false, error: error.message }));
    } else if (message.type === "trends:compare") {
      (async () => {
        await checkPageAccess();
        const settings = validateSettings((await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] ?? DEFAULT_SETTINGS);
        await openQuickComparison(keyword, settings, tab);
      })().then(() => respond({ ok: true }), error => respond({ ok: false, error: error.message }));
    } else {
      if ([...activities.values()].some(activity => activity.windowId === tab.windowId && activity.busy)) {
        throw new Error("侧栏任务正在运行或保存，请完成后再分析关键词。");
      }
      const request = { id: crypto.randomUUID(), keyword };
      const path = `${ANALYSIS_PAGE}?windowId=${tab.windowId}&request=${request.id}`;
      // Keep both calls in the click message's user gesture, before any await.
      const saving = checkPageAccess().then(() => chrome.storage.session.set({ [requestKey(tab.windowId)]: request }));
      const configuring = chrome.sidePanel.setOptions({ tabId: tab.id, path, enabled: true });
      const opening = chrome.sidePanel.open({ tabId: tab.id });
      Promise.all([saving, configuring, opening]).then(() => respond({ ok: true }), error => respond({ ok: false, error: error.message }));
    }
  } catch (error) { respond({ ok: false, error: error.message }); }
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[SETTINGS_KEY]) synchronize().catch(error => console.error("Trends 快捷按钮配置失败：", error));
});
chrome.permissions.onAdded.addListener(() => synchronize().catch(error => console.error("Trends 权限同步失败：", error)));
chrome.permissions.onRemoved.addListener(() => synchronize().catch(error => console.error("Trends 权限同步失败：", error)));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (enabled && change.url && isExploreUrl(change.url)) {
    chrome.scripting.executeScript({ target: { tabId }, files: [contentFile] })
      .catch(error => console.error("Trends 页面快捷按钮加载失败：", error));
  }
});
synchronize().catch(error => console.error("Trends 快捷按钮初始化失败：", error));
