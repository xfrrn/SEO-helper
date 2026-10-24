export const TRENDS_ORIGIN = "https://trends.google.com";
export const COMPARE_STORAGE_KEY = "seoHelper:google-trends:compare";

export function isTrendsUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === TRENDS_ORIGIN && !url.username && !url.password;
  } catch { return false; }
}

export function validateDate(date) {
  if (typeof date === "string" && /^(now (1|4)-H|now (1|7)-d|today (1|3|12)-m|today 5-y|all)$/.test(date)) return;
  const range = typeof date === "string" && date.match(/^(\d{4}-\d{2}-\d{2}) (\d{4}-\d{2}-\d{2})$/);
  if (!range) throw new Error("请选择有效的时间范围，或填写开始和结束日期。");
  for (const day of range.slice(1)) {
    const timestamp = Date.parse(`${day}T00:00:00Z`);
    if (!Number.isFinite(timestamp) || day < "2004-01-01" || new Date(timestamp).toISOString().slice(0, 10) !== day) {
      throw new Error("请输入有效日期，最早从 2004 年 1 月 1 日开始。");
    }
  }
  if (range[1] > range[2]) throw new Error("开始日期不能晚于结束日期。");
}

export function exploreUrl(query, { date = "today 1-m", geo = "" } = {}, currentUrl) {
  if (typeof query !== "string" || !query.trim()) throw new Error("请输入关键词。");
  validateDate(date);
  if (typeof geo !== "string" || !/^(?:[A-Z]{2}(?:-[A-Z0-9]{1,3})?)?$/.test(geo)) throw new Error("地区代码无效。");
  // Both features navigate to the new Explore page, even when replacing a classic tab.
  const url = new URL("/explore", TRENDS_ORIGIN);
  if (isTrendsUrl(currentUrl)) {
    const current = new URL(currentUrl);
    for (const key of ["cat", "gprop", "hl"]) {
      if (current.searchParams.has(key)) url.searchParams.set(key, current.searchParams.get(key));
    }
  }
  url.searchParams.set("q", query);
  url.searchParams.set("date", date);
  if (geo) url.searchParams.set("geo", geo);
  return url.href;
}
