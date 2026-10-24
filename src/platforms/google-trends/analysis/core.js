import { TRENDS_ORIGIN, exploreUrl } from "../explore.js";

export const STORAGE_KEY = "seoHelper:google-trends:analysis";
export const PROVIDERS = [
  { id: "google", label: "Google", title: "Google 搜索" },
  { id: "time", label: "Time", title: "时间趋势" },
  { id: "geo", label: "Geo", title: "地区热度" },
  { id: "bing", label: "Bing", title: "Bing 搜索" },
  { id: "domains", label: "Domains", title: "域名查询" },
  { id: "ahrefs", label: "Ahrefs", title: "Ahrefs 免费关键词工具" },
];

export function normalizeKeyword(value) {
  if (typeof value !== "string") throw new Error("请输入一个词或短语。");
  const keyword = value.trim().replace(/\s+/g, " ");
  if (!keyword || keyword.length > 150) throw new Error("请输入 1–150 个字符的词或短语。");
  if (/[\u0000-\u001f\u007f,，;；]/.test(keyword)) throw new Error("一次分析一个词或短语；多个词请使用分组对比。");
  return keyword;
}

export function analysisTarget(provider, value, filters = {}, timezone = new Date().getTimezoneOffset()) {
  const source = PROVIDERS.find(({ id }) => id === provider);
  if (!source) throw new Error("请选择有效的分析方式。");
  const keyword = normalizeKeyword(value);
  if (provider === "ahrefs") return { ...source, keyword, url: "https://ahrefs.com/keyword-generator", frameUrl: null };
  if (provider === "time" || provider === "geo") {
    const url = new URL(exploreUrl(keyword, filters));
    const frame = new URL(`/trends/embed/explore/${provider === "time" ? "TIMESERIES" : "GEO_MAP"}`, TRENDS_ORIGIN);
    frame.searchParams.set("req", JSON.stringify({
      comparisonItem: [{ keyword, geo: url.searchParams.get("geo") || "", time: url.searchParams.get("date") }],
      category: 0, property: "",
    }));
    frame.searchParams.set("tz", String(timezone));
    frame.searchParams.set("eq", url.searchParams.toString());
    return { ...source, keyword, url: url.href, frameUrl: frame.href };
  }
  const url = new URL({ google: "https://www.google.com/search", bing: "https://www.bing.com/search", domains: "https://instantdomainsearch.com/" }[provider]);
  url.searchParams.set("q", keyword);
  const frame = new URL(url);
  if (provider === "google") frame.searchParams.set("igu", "1");
  return { ...source, keyword, url: url.href, frameUrl: frame.href };
}
