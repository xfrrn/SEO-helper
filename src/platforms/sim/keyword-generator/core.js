export { parseRoots, parseBatches, appendRootBatches } from "../../../shared/root-batches.js";

export const STORAGE_KEY = "seoHelper:sim:keyword-generator";
export const initialRoot = "calculator";
export const reloadOnQueryChange = true;
export const DEFAULT_URL = "https://sim.3ue.co/#/digitalsuite/acquisition/findkeywords/keyword-generator-tool/999/28d?searchEngine=google&keyword=calculator&webSource=Total&isWWW=*&tab=phraseMatch&volumeFromValue=30000&difficultyFromValue=1&difficultyToValue=30";
export const previewColumns = [["keyword", "关键词"], ["volume", "期间搜索量"], ["average_volume", "平均搜索量"], ["kd", "KD"], ["cpc", "CPC"]];

function hashParts(url) {
  const separator = url.hash.indexOf("?");
  return { path: url.hash.slice(1, separator), params: new URLSearchParams(url.hash.slice(separator + 1)) };
}

export function researchUrl(value) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error("请粘贴完整的 SIM 关键词生成器链接。"); }
  if (url.origin !== "https://sim.3ue.co" || url.pathname !== "/" || url.username || url.password ||
      !/^#\/digitalsuite\/acquisition\/findkeywords\/keyword-generator-tool\/\d+\/[^/?#]+\?/.test(url.hash)) {
    throw new Error("目前只支持 https://sim.3ue.co/#/digitalsuite/acquisition/findkeywords/keyword-generator-tool/ 页面。");
  }
  const { params } = hashParts(url);
  if (url.href.length > 20000 || params.getAll("keyword").length !== 1 || !params.get("keyword")?.trim()) {
    throw new Error("链接需要包含一个非空 keyword 参数，且长度不能超过 20,000 字符。");
  }
  url.searchParams.delete("__gmitm");
  const separator = url.hash.indexOf("?");
  url.hash = url.hash.slice(0, separator + 1) + url.hash.slice(separator + 1).split("&").filter(part =>
    new URLSearchParams(part).keys().next().value !== "__gmitm").join("&");
  return url;
}

export function keywordUrl(template, root) {
  const url = researchUrl(template);
  const word = root.trim();
  if (!word || word.length > 150) throw new Error("每个词根需要 1–150 个字符。");
  const separator = url.hash.indexOf("?");
  const parts = url.hash.slice(separator + 1).split("&").filter((part) =>
    !["keyword", "page", "pageIndex", "__gmitm"].includes(new URLSearchParams(part).keys().next().value));
  url.hash = `${url.hash.slice(0, separator)}?keyword=${encodeURIComponent(word)}&${parts.join("&")}`;
  return url.href;
}

export function rootFromUrl(value) {
  return hashParts(researchUrl(value)).params.get("keyword");
}

export function researchKey(value) {
  const url = researchUrl(value);
  const { path, params } = hashParts(url);
  for (const key of ["page", "pageIndex", "__gmitm"]) params.delete(key);
  params.set("keyword", params.get("keyword").toLowerCase());
  params.sort();
  url.searchParams.sort();
  url.hash = `${path}?${params}`;
  return url.href;
}

export function filterDescription(value) {
  const { path, params } = hashParts(researchUrl(value));
  const [, region, period] = path.match(/\/([^/]+)\/([^/]+)$/);
  const tabs = { phraseMatch: "语句匹配", relatedKeywords: "相关关键词", trendingKeywords: "热门关键词", questions: "问题查询" };
  const descriptions = [params.get("searchEngine") || "默认搜索引擎", region === "999" ? "全球" : `地区 ${region}`, period === "28d" ? "最近 28 天" : `时间 ${period}`, tabs[params.get("tab")] || params.get("tab")];
  for (const [key, label] of [["volumeFromValue", "搜索量 ≥"], ["volumeToValue", "搜索量 ≤"], ["difficultyFromValue", "KD ≥"], ["difficultyToValue", "KD ≤"], ["cpcFromValue", "CPC ≥"], ["cpcToValue", "CPC ≤"]]) {
    if (params.has(key) && params.get(key) !== "") descriptions.push(`${label} ${Number.isFinite(Number(params.get(key))) ? Number(params.get(key)).toLocaleString("en-US") : params.get(key)}`);
  }
  return `${descriptions.filter(Boolean).join(" · ")}（其余条件同原页面）`;
}

export function numericValue(text) {
  const match = String(text ?? "").replace(/[,\s\u00a0]/g, "").match(/^[$€£¥]?(\d+(?:\.\d+)?)([kmb万亿])?%?$/i);
  return match ? Number(match[1]) * ({ k: 1e3, m: 1e6, b: 1e9, 万: 1e4, 亿: 1e8 }[match[2]?.toLowerCase()] || 1) : null;
}

export function mergeCapture(previous, capture) {
  const patterns = {
    keyword: /^(关键词|关键字|keywords?)(?:\s*[（(][\d,.]+[)）])?$/i,
    volume: /^(?:\d+\s*天的?体量|期间搜索量|搜索量|(?:\d+\s*days?\s*)?(?:search\s*)?volume)$/i,
    average_volume: /平均体量|平均搜索量|average.*volume|avg.*volume/i,
    kd: /^KD$|关键词难度|keyword difficulty/i,
    cpc: /CPC/i,
  };
  const indexes = Object.fromEntries(Object.entries(patterns).map(([key, pattern]) => [key, capture.headers.findIndex(header => pattern.test(header.trim()))]));
  if (indexes.keyword < 0 || indexes.volume < 0) throw new Error("表格缺少关键词或期间搜索量列，未保存预览。");
  const captures = [...(previous?.captures || []).filter(item => item.url !== capture.url), capture];
  const rows = capture.rows.map(cells => Object.fromEntries(Object.entries(indexes).map(([key, index]) =>
    [key, key === "keyword" ? (cells[index] || "").trim() : numericValue(cells[index])]))).filter(row => row.keyword);
  return { captures, rows: [...new Map(rows.map(row => [row.keyword.toLowerCase(), row])).values()], summary: capture.summary };
}
