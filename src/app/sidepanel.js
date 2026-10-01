import { platforms, filterPlatforms } from "../platforms/index.js";

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function render() {
  const visible = filterPlatforms(platforms, document.getElementById("search").value);
  const container = document.getElementById("platforms");
  container.replaceChildren();
  document.getElementById("platform-count").textContent = `${visible.length} 个平台`;
  document.getElementById("no-results").hidden = visible.length > 0;
  for (const platform of visible) {
    for (const feature of platform.features) {
      const card = element("article", "tool-card", "");
      const heading = element("div", "tool-heading", "");
      const mark = element("span", "platform-mark", platform.name.slice(0, 1));
      mark.setAttribute("aria-hidden", "true");
      const details = element("div", "tool-details", "");
      details.append(element("h3", "", `${platform.name} · ${feature.name}`));
      if (platform.domain) details.append(element("p", "domain", platform.domain));
      details.append(element("p", "description", feature.description));
      heading.append(mark, details);
      card.append(heading);
      if (feature.capabilities?.length) {
        const capabilities = element("ul", "capabilities", "");
        for (const name of feature.capabilities) capabilities.append(element("li", "", name));
        card.append(capabilities);
      }
      const link = element("a", "open-tool", `打开${feature.name}`);
      link.href = chrome.runtime.getURL(feature.page);
      link.setAttribute("aria-label", feature.name);
      const arrow = element("span", "", "→");
      arrow.setAttribute("aria-hidden", "true");
      link.append(arrow);
      card.append(link);
      container.append(card);
    }
  }
}

document.getElementById("version").textContent = `v${chrome.runtime.getManifest().version}`;
document.getElementById("search").addEventListener("input", render);
render();
