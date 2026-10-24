import { PRESET_ROOTS } from "../../../shared/root-library.js";
import { TRENDS_ORIGIN, isTrendsUrl, exploreUrl } from "../explore.js";

export { COMPARE_STORAGE_KEY as STORAGE_KEY, TRENDS_ORIGIN, isTrendsUrl, validateDate } from "../explore.js";
export const DEFAULT_GROUPS = Array.from({ length: Math.ceil(PRESET_ROOTS.length / 5) }, (_, index) =>
  PRESET_ROOTS.slice(index * 5, index * 5 + 5).map(({ root }) => root).join(", ")).join("\n");
export const DEFAULT_CONFIG = { groups: DEFAULT_GROUPS, date: "today 1-m", geo: "", selectedIndex: -1 };

export function parseGroups(text) {
  if (typeof text !== "string" || text.length > 32000) throw new Error("分组内容应为文本，最多 32,000 个字符。");
  const groups = [];
  let count = 0;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const seen = new Set();
    const words = line.split(/[,，;；]/).map((word) => word.trim().replace(/\s+/g, " ")).filter((word) => {
      const key = word.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (words.length > 8) throw new Error(`第 ${index + 1} 行超过 8 个词，请拆成多行。`);
    if (words.some((word) => word.length > 150)) throw new Error(`第 ${index + 1} 行存在超过 150 字符的词。`);
    count += words.length;
    if (count > 200) throw new Error("最多保存 200 个词，请减少分组。");
    if (words.length) groups.push(words);
  }
  return groups;
}

export function compareUrl(words, config, currentUrl) {
  if (!Array.isArray(words) || !words.length || words.some((word) => typeof word !== "string" || /[\r\n,，;；]/.test(word))) {
    throw new Error("请选择有效的一组词。");
  }
  const [group] = parseGroups(words.join(","));
  if (!group?.length) throw new Error("请选择至少一个词。");
  return exploreUrl(group.join(","), config, currentUrl);
}

export async function findTrendsTab() {
  const tabs = await chrome.tabs.query({ currentWindow: true, url: `${TRENDS_ORIGIN}/*` });
  const matches = tabs.filter((tab) => isTrendsUrl(tab.pendingUrl || tab.url));
  return matches.find((tab) => tab.active) || matches[0];
}

export async function openComparison(words, config) {
  compareUrl(words, config); // Validate before querying or changing browser tabs.
  const tab = await findTrendsTab();
  const url = compareUrl(words, config, tab?.pendingUrl || tab?.url);
  return tab ? chrome.tabs.update(tab.id, { url, active: true }) : chrome.tabs.create({ url, active: true });
}
