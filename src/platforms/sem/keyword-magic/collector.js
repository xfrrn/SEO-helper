import { researchKey, researchUrl } from "./core.js";

// This function is serialized by chrome.scripting; keep its DOM helpers inside it.
export function readRenderedPage() {
  const visible = (node) => node.getClientRects().length > 0 &&
    getComputedStyle(node).visibility !== "hidden" && !node.closest('[hidden], [aria-hidden="true"]');
  const text = (node) => (node.innerText || node.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
  const body = document.body?.innerText || "";
  const lines = body.split(/\n/).map((line) => line.trim());
  const busy = [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')].some(visible);
  const summaryValue = (pattern) => body.match(pattern)?.[1] || null;
  const summary = {
    total_keywords: summaryValue(/(?:所有关键词|全部关键词|All keywords|Total keywords)\s*[:：]\s*([\d,.\s]+[KMB万亿]?)/i)?.trim() || null,
    total_volume: summaryValue(/(?:总搜索量|Total volume)\s*[:：]\s*([\d,.\s]+[KMB万亿]?)/i)?.trim() || null,
    average_kd: summaryValue(/(?:平均\s*KD|Average KD)\s*[:：]\s*([\d.]+\s*%?)/i),
  };
  const currentPage = document.querySelector('input[aria-label*="Page"], input[aria-label*="页"], [aria-current="page"]');
  const page = currentPage?.value || currentPage?.textContent?.trim() ||
    body.match(/(?:Page|页码)\s*:\s*(\d+)/i)?.[1] || new URL(location.href).searchParams.get("page") || "unknown";
  const base = { url: location.href, title: document.title, summary, page, busy };
  if ([...document.querySelectorAll('input[type="password"]')].some(visible)) {
    return { ...base, error: "需要登录。请先在 SEM 页面完成登录，再重新采集。", fatal: true };
  }
  const tables = [...document.querySelectorAll('table, [role="grid"], [role="table"], [data-ui-name="DataTable"]')].filter(visible);
  const candidates = [];
  for (const table of tables) {
    const headerNodes = [...table.querySelectorAll('thead th, [role="columnheader"], [data-ui-name="DataTable.Head"] [data-ui-name="DataTable.Cell"], [data-ui-name="DataTable.Column"]')];
    // Do not drop blank checkbox headers: their indexes must still line up with cells.
    const headers = headerNodes.map(text);
    const keywordIndex = headers.findIndex((header) => /^(关键词|关键字|keywords?)$/i.test(header));
    if (keywordIndex < 0 || !headers.some((header) => /搜索量|^volume$|search volume/i.test(header))) continue;
    const rows = [];
    for (const row of table.querySelectorAll('tbody tr, [role="row"], [data-ui-name="DataTable.Row"]')) {
      if (!visible(row) || row.querySelector('th, [role="columnheader"]')) continue;
      const cells = [...row.querySelectorAll('td, [role="gridcell"], [role="cell"], [data-ui-name="DataTable.Cell"]')];
      if (cells.length !== headers.length) continue;
      const values = cells.map(text);
      const keywordLink = [...cells[keywordIndex].querySelectorAll("a")].find((node) => visible(node) && text(node));
      if (keywordLink) values[keywordIndex] = text(keywordLink);
      if (values[keywordIndex]) rows.push(values);
    }
    const currency = headers.join(" ").match(/CPC\s*\(([A-Z]{3})\)/i)?.[1]?.toUpperCase() || null;
    candidates.push({ headers, rows, currency });
  }
  candidates.sort((a, b) => b.rows.length - a.rows.length);
  const table = candidates[0];
  if (table?.rows.length) return { ...base, ...table };
  if (lines.some((line) => /^(?:请完成验证码|请验证您是人类|Verify you are human|Checking your browser|加载失败|数据加载失败|Failed to load(?: data)?|Something went wrong)[.!。！…]*$/i.test(line))) {
    return { ...base, error: "页面出现验证或加载错误。请先在 SEM 页面处理后重试。", fatal: true };
  }
  const emptyMessage = lines.some((line) => /^(?:(?:没有找到|未找到|暂无)(?:任何|相关)?(?:关键词|结果|数据)|no (?:keywords|results|data) (?:found|match)|we (?:couldn't|could not) find any keywords)[.!。！]*$/i.test(line));
  const filterHint = lines.some((line) => /^(?:Try changing your filters|请(?:尝试)?(?:更改|调整|修改)筛选条件)[.!。！]*$/i.test(line));
  const clearFilters = [...document.querySelectorAll('button, a, [role="button"]')].some((node) => visible(node) && /^(Clear filters|清除筛选(?:条件)?)$/i.test(text(node)));
  // A disabled export button, a blank table or an empty sidebar alone is not proof.
  if (emptyMessage && (table || clearFilters) && (summary.total_keywords === "0" || (!summary.total_keywords && filterHint && clearFilters))) {
    return { ...base, empty: true, summary: { ...summary, total_keywords: "0" }, headers: table?.headers || ["关键词", "搜索量", "KD", "CPC"], rows: [] };
  }
  return { ...base, error: "尚未识别到关键词表格。请检查登录、加载状态或验证码；页面结构变化也可能导致识别失败。" };
}

export function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function assertSameQuery(actual, expected) {
  try { if (researchKey(actual) === researchKey(expected)) return; } catch { /* A login redirect is not a research page. */ }
  throw new Error("页面已跳转或筛选条件已改变。请确认 SEM 登录状态，并回到对应词根的结果页后重试。");
}

export async function collectTab(tabId, expectedUrl, { signal, settleMs = 3000, timeoutMs = 45000 } = {}) {
  const started = Date.now();
  let previous = "";
  let stableSince = 0;
  let completedSince = 0;
  let lastError = "页面加载超时。请在网站确认结果后重试。";
  while (Date.now() - started < timeoutMs) {
    signal?.throwIfAborted();
    const tab = await chrome.tabs.get(tabId);
    if (tab.status !== "complete" || tab.pendingUrl) {
      completedSince = 0;
      previous = "";
      await pause(500, signal);
      continue;
    }
    if (!completedSince) completedSince = Date.now();
    if (tab.url) assertSameQuery(tab.url, expectedUrl);
    let capture;
    try {
      const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: readRenderedPage });
      capture = injection?.result;
    } catch (error) {
      lastError = `无法读取页面：${error.message}`;
      await pause(500, signal);
      continue;
    }
    signal?.throwIfAborted();
    assertSameQuery(capture?.url || "", expectedUrl);
    if (capture.fatal) throw new Error(capture.error);
    if (capture.error || capture.busy) {
      lastError = capture.error || "表格仍在加载，请稍后重试。";
      previous = "";
    } else {
      const fingerprint = JSON.stringify([capture.headers, capture.rows, capture.summary, capture.page]);
      if (fingerprint !== previous) { previous = fingerprint; stableSince = Date.now(); }
      // ponytail: DOM stability is a heuristic; use a verified site signal if SEM exposes one.
      if (Date.now() - completedSince >= settleMs && Date.now() - stableSince >= 1500) {
        return { ...capture, url: researchUrl(capture.url).href, capturedAt: new Date().toISOString() };
      }
    }
    await pause(600, signal);
  }
  throw new Error(lastError);
}
