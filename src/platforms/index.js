// Navigation metadata only. Business modules are loaded by their own feature pages.
export const platforms = [
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
