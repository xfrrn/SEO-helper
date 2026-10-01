export const DEFAULT_URL = "https://sem.3ue.co/analytics/keywordmagic/?q=Checker&db=us&type=all&mode=1&filter=H4sIAAAAAAAAA5WPzQoDIQyE3yVnD0t%2FDvVVlkVEYytkVfwrZem7V2vpqRQ2pyHMZL5soPwaMNtsvROEFQn4vDBQQTWxgXUVY0YN3EhKyMAHjLK7gZ8ZVEkFgU%2FPFtHWGKsK5ceuJPtvPX2th0tvCbcoEw7IoYV1iopGQf5qG%2FXEIGJqHGm4EsYgDMpc2vo32qdhXnpD9VRW3PHDcWrTk3cfdRLKF5ffx14v6rwpXgEAAA%3D%3D";

export function researchUrl(value) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error("请粘贴完整的 SEM 关键词魔法工具链接。"); }
  if (url.protocol !== "https:" || url.hostname !== "sem.3ue.co" || url.port ||
      !/^\/analytics\/keywordmagic\/?$/.test(url.pathname) || url.username || url.password) {
    throw new Error("目前只支持 https://sem.3ue.co/analytics/keywordmagic/ 页面。");
  }
  if (url.href.length > 20000 || !url.searchParams.get("q")?.trim()) {
    throw new Error("链接需要包含词根参数 q，且长度不能超过 20,000 字符。");
  }
  // Preserve opaque filter bytes; omit the gateway's temporary access marker.
  url.search = url.search.slice(1).split("&").filter((part) =>
    !["__gmitm"].includes(new URLSearchParams(part).keys().next().value)).join("&");
  url.hash = "";
  return url;
}

export function keywordUrl(template, root) {
  const url = researchUrl(template);
  const word = root.trim();
  if (!word || word.length > 150) throw new Error("每个词根需要 1–150 个字符。");
  const parts = url.search.slice(1).split("&").filter((part) =>
    !["q", "page"].includes(new URLSearchParams(part).keys().next().value));
  url.search = [`q=${encodeURIComponent(word)}`, ...parts].join("&");
  return url.href;
}

export function researchKey(value) {
  const url = researchUrl(value);
  url.searchParams.delete("page");
  url.searchParams.set("q", url.searchParams.get("q").toLowerCase());
  url.searchParams.sort();
  return url.href;
}

export function parseRoots(text) {
  const seen = new Set();
  const roots = text.split(/[\n,，;；]+/).map((word) => word.trim().replace(/\s+/g, " "))
    .filter((word) => {
      const key = word.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (roots.length > 200) throw new Error("一次最多 200 个词根，请分批处理。");
  if (roots.some((word) => word.length > 150)) throw new Error("单个词根不能超过 150 个字符。");
  return roots;
}

export function parseBatches(text) {
  const batches = text.split(/\r?\n/).map(parseRoots).filter((roots) => roots.length);
  if (batches.reduce((total, roots) => total + roots.length, 0) > 200) {
    throw new Error("词根总数最多 200 个，请减少行数或每行词根。");
  }
  return batches;
}

export function appendRootBatches(text, selected) {
  const batches = parseBatches(text);
  const firstBatch = batches.length;
  const existing = new Set(batches.flat().map((root) => root.toLowerCase()));
  const added = parseRoots(selected.join(",")).filter((root) => !existing.has(root.toLowerCase()));
  for (let index = 0; index < added.length; index += 5) batches.push(added.slice(index, index + 5));
  const roots = batches.map((batch) => batch.join(", ")).join("\n");
  parseBatches(roots); // Validate the total before changing the current list.
  return { roots, added: added.length, firstBatch };
}

export async function filterDescription(value) {
  const url = researchUrl(value);
  const encoded = url.searchParams.get("filter");
  if (!encoded) return `${url.searchParams.get("db") || "默认"} 数据库 · 未设置筛选`;
  try {
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    const reader = stream.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      size += chunk.length;
      if (size > 100000) { await reader.cancel(); throw new Error("筛选数据过大"); }
      chunks.push(chunk);
    }
    const filters = JSON.parse(await new Blob(chunks).text());
    const descriptions = [];
    for (const [key, label] of [["volume", "搜索量"], ["difficulty", "KD"], ["cpc", "CPC"]]) {
      for (const rule of filters[key] || []) {
        if (!rule.inverted && [4, 5].includes(rule.operation) && typeof rule.value === "number") {
          descriptions.push(`${label} ${rule.operation === 5 ? "≥" : "≤"} ${rule.value.toLocaleString("en-US")}`);
        }
      }
    }
    return `${(url.searchParams.get("db") || "默认").toUpperCase()} · ${descriptions.join(" · ") || "已保留筛选"}（其余条件同原页面）`;
  } catch {
    return "已保留原链接的完整筛选参数；以网站显示为准。";
  }
}

export function numericValue(text) {
  const value = String(text ?? "").trim().replace(/[,\s\u00a0]/g, "");
  const match = value.match(/^[$€£¥]?(\d+(?:\.\d+)?)([kmb万亿])?%?$/i);
  if (!match) return null;
  const factor = { k: 1000, m: 1000000, b: 1000000000, "万": 10000, "亿": 100000000 };
  return Number(match[1]) * (factor[match[2]?.toLowerCase()] || 1);
}

export function normalizeRows(capture) {
  const patterns = {
    keyword: /^(关键词|关键字|keywords?)$/i,
    intent: /意图|intent/i,
    volume: /搜索量|search volume|^volume$/i,
    kd: /^kd(?:\s*%|\s*\(%\))?$|关键词难度|keyword difficulty/i,
    cpc: /cpc|每次点击费用/i,
    serp_features: /serp/i,
    updated: /已更新|更新时间|updated/i,
  };
  const indexes = Object.fromEntries(Object.entries(patterns).map(([key, pattern]) =>
    [key, capture.headers.findIndex((header) => pattern.test(header.trim()))]));
  if (indexes.keyword < 0) throw new Error("表格缺少关键词列，未保存数据。");
  return capture.rows.map((cells) => {
    const raw = Object.fromEntries(Object.entries(indexes).map(([key, index]) => [key, index < 0 ? "" : (cells[index] || "")]));
    return { ...raw, volume: numericValue(raw.volume), kd: numericValue(raw.kd), cpc: numericValue(raw.cpc), raw_cells: cells };
  }).filter((row) => row.keyword);
}

export function mergeCapture(previous, capture) {
  const pages = [...(previous?.captures || [])];
  const index = pages.findIndex((page) => page.url === capture.url && page.page === capture.page &&
    (capture.page !== "unknown" || JSON.stringify(page.rows) === JSON.stringify(capture.rows)));
  if (index < 0) pages.push(capture); else pages[index] = capture;
  const rows = new Map();
  for (const page of pages) {
    for (const row of normalizeRows(page)) {
      rows.set(row.keyword.toLowerCase(), { ...row, currency: page.currency || null, source_url: page.url, captured_at: page.capturedAt });
    }
  }
  return { captures: pages, rows: [...rows.values()], summary: capture.summary };
}
