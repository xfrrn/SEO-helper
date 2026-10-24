import { normalizeKeyword } from "../analysis/core.js";

export async function translateKeyword(value) {
  const keyword = normalizeKeyword(value);
  // shortcut: Google 的免 Key 网页接口没有稳定性承诺，失效时改接有合同的翻译 API。
  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.search = new URLSearchParams({ client: "gtx", sl: "auto", tl: "zh-CN", dt: "t", q: keyword });
  const response = await fetch(url, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Google 翻译返回 HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data?.[0]) || !data[0].length || data[0].some(part => !Array.isArray(part) || typeof part[0] !== "string")) {
    throw new Error("Google 翻译返回了无法识别的数据");
  }
  const translation = data[0].map(part => part[0]).join("").trim();
  if (!translation) throw new Error("Google 翻译未返回译文");
  return translation;
}
