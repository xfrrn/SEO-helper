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
