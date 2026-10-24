import { researchKey, researchUrl } from "./core.js";

// Serialized into the page by chrome.scripting. Read only the rendered table.
export function readRenderedPage() {
  const visible = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden" && !node.closest('[hidden], [aria-hidden="true"]');
  const text = node => (node.innerText || node.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
  const body = document.body?.innerText || "";
  const base = { url: location.href, title: document.title, page: "visible", summary: {}, busy: [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"], .loading, .swSpinner')].some(visible) };
  if ([...document.querySelectorAll('input[type="password"]')].some(visible) || /登录过期|登录无效|请重新登录|session expired/i.test(body)) {
    return { ...base, fatal: true, error: "请先在 SIM 页面完成登录，再读取预览。" };
  }
  if (/^(?:请验证您是人类|请完成验证码|Verify you are human|Checking your browser|加载失败|数据加载失败|Failed to load(?: data)?|Something went wrong)[.!。！…]*$/im.test(body)) {
    return { ...base, fatal: true, error: "SIM 页面出现验证或加载错误，请在网站处理后重试。" };
  }
  const tables = [...document.querySelectorAll('table, [role="grid"], [role="table"], .swReactTable')].filter(visible);
  const candidates = [];
  for (const table of tables) {
    const headers = [...table.querySelectorAll('thead th, [role="columnheader"], .swReactTable-headerCell')].map(text);
    const keyword = headers.findIndex(header => /^(关键词|关键字|keywords?)(?:\s*[（(][\d,.]+[)）])?$/i.test(header));
    if (keyword < 0 || !headers.some(header => /体量|搜索量|volume/i.test(header))) continue;
    const rows = [];
    for (const row of table.querySelectorAll('tbody tr, [role="row"], .swReactTable-row')) {
      if (!visible(row) || row.querySelector('th, [role="columnheader"], .swReactTable-headerCell')) continue;
      const cells = [...row.querySelectorAll('td, [role="cell"], [role="gridcell"], .swReactTable-cell')];
      if (cells.length !== headers.length) continue;
      const values = cells.map(text);
      const link = [...cells[keyword].querySelectorAll('a')].find(node => visible(node) && text(node));
      if (link) values[keyword] = text(link);
      if (values[keyword]) rows.push(values);
    }
    const count = headers[keyword].match(/[（(]([\d,]+)[)）]/)?.[1]?.replaceAll(",", "");
    candidates.push({ headers, rows, summary: { total_keywords: count || null } });
  }
  const table = candidates.sort((a, b) => b.rows.length - a.rows.length)[0];
  if (table?.rows.length) return { ...base, ...table };
  const empty = /^(?:(?:未找到|没有找到|暂无)(?:任何|相关)?(?:关键词|结果|数据)|No (?:results|data|keywords)(?: found)?)[.!。！]*$/im.test(body);
  if (empty && table?.summary.total_keywords === "0") return { ...base, ...table, empty: true };
  return { ...base, error: "尚未识别到 SIM 关键词表格。请确认登录和加载状态；可先使用“打开本批”在网站查看。" };
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function assertSameQuery(actual, expected) {
  try { if (researchKey(actual) === researchKey(expected)) return; } catch { /* Login redirects are not results. */ }
  throw new Error("SIM 页面已跳转或筛选条件已改变。请确认登录并回到对应词根结果页后重试。");
}

export async function collectTab(tabId, expectedUrl, { signal, settleMs = 3000, timeoutMs = 45000 } = {}) {
  const started = Date.now();
  let fingerprint = "";
  let stableSince = 0;
  let lastError = "SIM 页面加载超时，请在网站确认结果后重试。";
  while (Date.now() - started < timeoutMs) {
    signal?.throwIfAborted();
    const tab = await chrome.tabs.get(tabId);
    if (tab.status !== "complete" || tab.pendingUrl) { fingerprint = ""; await pause(500, signal); continue; }
    assertSameQuery(tab.url, expectedUrl);
    let capture;
    try {
      const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: readRenderedPage });
      capture = result?.result;
    } catch (error) { lastError = `无法读取 SIM 页面：${error.message}`; await pause(500, signal); continue; }
    signal?.throwIfAborted();
    assertSameQuery(capture?.url, expectedUrl);
    if (capture.fatal) throw new Error(capture.error);
    if (capture.error || capture.busy) { lastError = capture.error || "SIM 表格仍在加载。"; fingerprint = ""; }
    else {
      const next = JSON.stringify([capture.headers, capture.rows, capture.summary]);
      if (fingerprint !== next) { fingerprint = next; stableSince = Date.now(); }
      // ponytail: DOM stability is heuristic; use a verified site loading signal when available.
      if (Date.now() - stableSince >= Math.max(1500, settleMs)) return { ...capture, url: researchUrl(capture.url).href, capturedAt: new Date().toISOString() };
    }
    await pause(500, signal);
  }
  throw new Error(lastError);
}
