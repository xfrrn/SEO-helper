// Navigation metadata only. Business modules are loaded by their own feature pages.
export const platforms = [
  {
    id: "google-trends",
    name: "Google Trends",
    domain: "trends.google.com",
    description: "网页自动显示中文翻译，悬停关键词可复制 / 对比 / 分析。在线翻译会将当前显示的外文关键词发送给 Google。",
    features: [
      {
        id: "compare",
        name: "分组对比",
        description: "点一组词，在新版探索页一键填入对比。",
        capabilities: ["分组词库", "时间 / 地区", "一键对比"],
        page: "src/platforms/google-trends/compare/sidepanel.html",
      },
      {
        id: "analysis",
        name: "词义分析",
        description: "查询词义、时间趋势与地区热度，查看域名和关键词机会。",
        capabilities: ["搜索结果", "时间 / 地区", "域名查询"],
        page: "src/platforms/google-trends/analysis/sidepanel.html",
      },
    ],
  },
  {
    id: "sem",
    name: "SEM",
    domain: "sem.3ue.co",
    features: [
      {
        id: "keyword-magic",
        name: "词根研究",
        description: "管理词根与筛选条件，批量导出关键词。",
        capabilities: ["词根库", "筛选模板", "批量导出"],
        page: "src/platforms/sem/keyword-magic/sidepanel.html",
      },
    ],
  },
  {
    id: "sim",
    name: "SIM",
    domain: "sim.3ue.co",
    features: [
      {
        id: "keyword-generator",
        name: "词根研究",
        description: "保留关键词生成器筛选，分批打开词根并查看预览。",
        capabilities: ["词根库", "筛选模板", "分批查看"],
        page: "src/platforms/sim/keyword-generator/sidepanel.html",
      },
    ],
  },
  {
    id: "gamemonetize",
    name: "GameMonetize",
    domain: "gamemonetize.com",
    features: [
      {
        id: "game",
        name: "游戏采集",
        description: "读取游戏 XML 和手机支持状态，支持粘贴链接批量采集。",
        capabilities: ["完整 XML", "手机支持", "批量 / ZIP"],
        page: "src/platforms/gamemonetize/game/sidepanel.html",
      },
    ],
  },
];

export function filterPlatforms(items, query) {
  const text = query.trim().toLowerCase();
  return items.map((platform) => ({
    ...platform,
    features: platform.features.filter((feature) =>
      [platform.name, platform.domain, feature.name, feature.description, ...(feature.capabilities || [])]
        .join(" ").toLowerCase().includes(text)),
  })).filter((platform) => platform.features.length);
}
