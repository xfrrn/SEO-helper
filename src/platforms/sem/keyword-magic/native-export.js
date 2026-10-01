import { researchKey } from "./core.js";
import { assertSameQuery, pause, readRenderedPage } from "./collector.js";

export function normalizeDownloadFolder(value = "") {
  if (typeof value !== "string") throw new Error("导出文件夹必须是文本。");
  let folder = value.trim().replaceAll("\\", "/");
  if (/^(\/|[a-z]:)/i.test(folder)) throw new Error("这里只填写下载目录内的子文件夹；保存到磁盘完整路径，请点击“更改下载位置”。");
  folder = folder.replace(/\/+$/, "");
  if (!folder) return "";
  if (folder.length > 180 || folder.split("/").some((part) => !part || part === "." || part === ".." ||
      /[<>:"|?*\u0000-\u001f\u007f]/.test(part) || /[. ]$/.test(part) ||
      /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) {
    throw new Error("文件夹名称无效。请使用类似 SEO-Helper/项目A 的路径，不能含 .. 或特殊路径字符，最长 180 字符。");
  }
  return folder;
}

// Injected into the page: clicks SEM controls only. It never builds a data file.
export function clickNativeExport({ phase, format, expectedUrl }) {
  const key = (value) => {
    const url = new URL(value);
    url.hash = "";
    for (const name of ["page", "__gmitm"]) url.searchParams.delete(name);
    url.searchParams.set("q", (url.searchParams.get("q") || "").toLowerCase());
    url.searchParams.sort();
    return url.href;
  };
  if (key(location.href) !== key(expectedUrl)) return { error: "页面查询已改变，已停止原生导出。" };
  const visible = (node) => node.getClientRects().length > 0 &&
    getComputedStyle(node).visibility !== "hidden" && !node.closest('[hidden], [aria-hidden="true"]');
  const name = (node) => [node.innerText, node.getAttribute("aria-label"), node.getAttribute("title"),
    ...(node.getAttribute("aria-labelledby") || "").split(/\s+/).map((id) => document.getElementById(id)?.textContent)]
    .filter(Boolean).map((value) => value.replace(/\s+/g, " ").trim());
  const enabled = (node) => !node.disabled && !node.closest('[aria-disabled="true"]');
  const controls = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"]')].filter(visible);
  const formatPattern = /^(XLSX|CSV|CSV Semicolon)$/i;
  const formats = controls.filter((node) => name(node).some((value) => formatPattern.test(value)));
  let menu;
  for (const button of formats) {
    for (let parent = button.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      if (parent.querySelector('input[type="radio"], [role="radio"]') &&
          formats.filter((item) => parent.contains(item)).length >= 2 &&
          /导出数据|Export data/i.test(parent.innerText)) { menu = parent; break; }
    }
    if (menu) break;
  }
  if (phase === "probe" || phase === "open") {
    if (menu) return { ready: true, opened: true };
    const buttons = controls.filter((node) =>
      name(node).some((value) => /^(导出(?:数据|关键词)?|Export(?: data| keywords)?)$/i.test(value)) ||
      node.querySelector('svg[data-name="ExportM"], svg[data-name="ExportS"], [data-ui-name="ExportM"], [data-ui-name="ExportS"]'));
    if (buttons.length !== 1) return { waiting: buttons.length ? "发现多个导出入口，请在网站打开词表的导出菜单后重试。" : "没有识别到词表的原生导出按钮。请在网站打开导出菜单后重试。" };
    if (!enabled(buttons[0])) return { waiting: "网站导出按钮不可用，请检查结果、登录或导出额度。" };
    if (phase === "open") buttons[0].click();
    return { ready: true, opened: phase === "open" };
  }
  if (!menu) return { waiting: "未识别到网站的“导出数据”菜单。请打开右上角导出菜单后重试。" };
  const radios = [...menu.querySelectorAll('input[type="radio"], [role="radio"]')];
  const choices = radios.map((radio) => ({ radio, labels: [
    ...name(radio), ...[...(radio.labels || [])].map((label) => label.innerText), radio.closest("label")?.innerText,
  ].filter(Boolean).map((label) => label.replace(/\s+/g, " ").trim()) }));
  const allPattern = /^(所有|全部|所有关键词|全部关键词|All(?: keywords)?)(?:\s*[（(][\d, .KM万亿]+[）)])?$/i;
  const all = choices.filter((choice) => choice.labels.some((label) => allPattern.test(label)));
  if (all.length !== 1 || !enabled(all[0].radio)) return { error: "无法确认网站的“所有”导出范围，已停止。请检查导出菜单和账号额度。" };
  if (!all[0].radio.checked && all[0].radio.getAttribute("aria-checked") !== "true") {
    all[0].radio.click();
    return { waiting: "正在选择“所有”…" };
  }
  const scopeLabel = all[0].labels.find((label) => allPattern.test(label));
  const options = formats.filter((node) => menu.contains(node) && name(node).some((value) => value.toLowerCase() === format.toLowerCase()));
  if (options.length !== 1 || !enabled(options[0])) return { error: `网站的 ${format} 导出选项不可用。` };
  if (phase === "format") options[0].click();
  return { ready: true, scopeLabel, clicked: phase === "format" };
}

function matchesDownloadSource(item, expectedUrl, startedAt) {
  if (Date.parse(item.startTime) < startedAt || !Number.isFinite(Date.parse(item.startTime))) return false;
  const expected = new URL(expectedUrl);
  let sourceMatches = false;
  for (const value of [item.url, item.finalUrl, item.referrer]) {
    try { if (new URL(value).origin === expected.origin) sourceMatches = true; } catch { /* Empty referrer. */ }
  }
  if (!sourceMatches) return false;
  let referrer;
  try { referrer = new URL(item.referrer); } catch { /* Blob downloads may omit the referrer. */ }
  if (referrer?.searchParams.has("q")) {
    try { if (researchKey(item.referrer) !== researchKey(expectedUrl)) return false; }
    catch { return false; }
  }
  return true;
}

export function matchesNativeDownload(item, expectedUrl, format, startedAt) {
  if (!matchesDownloadSource(item, expectedUrl, startedAt)) return false;
  const filename = item.filename || "";
  const mime = item.mime || "";
  return format === "XLSX"
    ? /\.xlsx$/i.test(filename) || /spreadsheetml/.test(mime)
    : /\.csv$/i.test(filename) || /(?:text|application)\/csv/.test(mime);
}

// ponytail: downloads has no source tab ID. Serialize exports and match origin,
// format and referrer; use a site export ID if concurrent SEM exports are needed.
export function watchNativeDownload(expectedUrl, format, { signal, folder = "", timeoutMs = 120000 } = {}) {
  folder = normalizeDownloadFolder(folder);
  const startedAt = Date.now();
  const candidates = new Set();
  let armed = false;
  let downloadId = null;
  let resolveResult;
  let rejectResult;
  let settled = false;
  const promise = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  // Attach a handler immediately while the caller is still interacting with the menu.
  promise.catch(() => {});
  const finish = (error, item) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    chrome.downloads.onCreated.removeListener(created);
    chrome.downloads.onChanged.removeListener(changed);
    if (folder) chrome.downloads.onDeterminingFilename.removeListener(determineFilename);
    signal?.removeEventListener("abort", abort);
    if (error) rejectResult(error); else resolveResult(item);
  };
  const inspect = (item) => {
    if (!armed || settled || !item) return;
    if (item.state === "interrupted" && !item.filename && !item.mime && matchesDownloadSource(item, expectedUrl, startedAt)) {
      finish(new Error(`网站下载在获取文件信息前中断：${item.error || "请查看浏览器下载记录"}`));
      return;
    }
    if (downloadId === null && matchesNativeDownload(item, expectedUrl, format, startedAt)) downloadId = item.id;
    if (item.id !== downloadId) return;
    if (item.state === "complete") finish(null, item);
    else if (item.state === "interrupted") finish(new Error(`网站文件下载中断：${item.error || "请查看浏览器下载记录"}`));
  };
  const refresh = (id) => chrome.downloads.search({ id }).then(([item]) => inspect(item)).catch((error) => finish(error));
  const created = (item) => {
    if (!armed) return;
    // Never inspect pre-existing download history or unrelated download items.
    const origins = [item.url, item.finalUrl, item.referrer].some((value) => {
      try { return new URL(value).origin === new URL(expectedUrl).origin; } catch { return false; }
    });
    if (!origins) return;
    candidates.add(item.id);
    inspect(item);
    if (!settled) refresh(item.id);
  };
  const changed = (delta) => { if (candidates.has(delta.id)) refresh(delta.id); };
  const determineFilename = (item, suggest) => {
    if (armed && !settled && (downloadId === null || downloadId === item.id) && matchesNativeDownload(item, expectedUrl, format, startedAt)) {
      const name = item.filename.split(/[\\/]/).pop();
      if (name && name !== "." && name !== "..") {
        downloadId = item.id;
        candidates.add(item.id);
        suggest({ filename: `${folder}/${name}`, conflictAction: "uniquify" });
        return;
      }
    }
    // Every event must be released, including unrelated browser downloads.
    suggest();
  };
  const abort = () => finish(signal.reason);
  const timer = setTimeout(() => finish(new Error("未确认网站文件下载完成。请查看浏览器下载记录、保存对话框或网站导出限制，再决定是否重试。")), timeoutMs);
  chrome.downloads.onCreated.addListener(created);
  chrome.downloads.onChanged.addListener(changed);
  if (folder) chrome.downloads.onDeterminingFilename.addListener(determineFilename);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return { promise, arm: () => { armed = true; }, cancel: (error) => finish(error || new Error("导出已停止。")) };
}

export async function exportNativeFile(tabId, expectedUrl, { format = "CSV", folder = "", signal, settleMs = 3000 } = {}) {
  if (!["CSV", "XLSX", "CSV Semicolon"].includes(format)) throw new Error("不支持的原生导出格式。");
  folder = normalizeDownloadFolder(folder);
  const step = async (phase) => {
    signal?.throwIfAborted();
    const tab = await chrome.tabs.get(tabId);
    if (tab.status !== "complete" || tab.pendingUrl) return { waiting: "页面仍在加载…" };
    assertSameQuery(tab.url, expectedUrl);
    const [page] = await chrome.scripting.executeScript({ target: { tabId }, func: readRenderedPage });
    signal?.throwIfAborted();
    assertSameQuery(page?.result?.url || "", expectedUrl);
    if (page.result.fatal) throw new Error(page.result.error);
    if (page.result.busy) return { waiting: "词表仍在加载…" };
    if (page.result.empty) return { empty: true, checkedAt: new Date().toISOString() };
    // Unknown table markup must not block otherwise usable native export controls.
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: clickNativeExport, args: [{ phase, format, expectedUrl }] });
    if (result?.error) throw new Error(result.error);
    return result || { waiting: "无法读取网站导出控件。" };
  };
  const waitStep = async (phase, timeoutMs) => {
    const start = Date.now();
    let waiting = "网站导出控件尚未就绪。";
    let readySince = 0;
    let previous = "";
    while (Date.now() - start < timeoutMs) {
      const result = await step(phase);
      signal?.throwIfAborted();
      const outcome = result.empty ? "empty" : result.ready ? "ready" : "";
      if (outcome) {
        if (previous !== outcome) readySince = Date.now();
        const delay = result.empty ? Math.max(1500, settleMs) : phase === "probe" ? settleMs : 0;
        if (Date.now() - readySince >= delay) return result;
        waiting = result.empty ? "正在确认当前筛选下无结果…" : waiting;
      } else { waiting = result.waiting; }
      previous = outcome;
      await pause(300, signal);
    }
    throw new Error(waiting);
  };
  const probe = await waitStep("probe", 45000);
  if (probe.empty) return probe;
  const opened = await waitStep("open", 10000);
  if (opened.empty) return opened;
  const scope = await waitStep("scope", 10000);
  if (scope.empty) return scope;
  const download = watchNativeDownload(expectedUrl, format, { signal, folder });
  try {
    signal?.throwIfAborted();
    download.arm();
    const clicked = await waitStep("format", 10000);
    if (clicked.empty) return clicked;
    if (!clicked.clicked) throw new Error(clicked.waiting || "网站导出选项发生变化，请重试。");
    const file = await download.promise;
    return { downloadId: file.id, filename: file.filename.split(/[\\/]/).pop(), path: file.filename, folder, format, scopeLabel: scope.scopeLabel, completedAt: file.endTime || new Date().toISOString() };
  } finally { download.cancel(); }
}
