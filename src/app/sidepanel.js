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
    const card = element("article", "tool-card", "");
    card.dataset.platform = platform.id;
    const heading = element("div", "tool-heading", "");
    const mark = element("span", "platform-mark", platform.name.slice(0, 1));
    mark.setAttribute("aria-hidden", "true");
    const details = element("div", "tool-details", "");
    details.append(element("h3", "", platform.name));
    if (platform.domain) details.append(element("p", "domain", platform.domain));
    heading.append(mark, details);
    card.append(heading);
    if (platform.description) card.append(element("p", "description", platform.description));
    for (const feature of platform.features) {
      const section = element("section", "tool-feature", "");
      section.append(element("h4", "", feature.name));
      section.append(element("p", "description", feature.description));
      if (feature.capabilities?.length) {
        const capabilities = element("ul", "capabilities", "");
        for (const name of feature.capabilities) capabilities.append(element("li", "", name));
        section.append(capabilities);
      }
      const link = element("a", "open-tool", `打开${feature.name}`);
      link.href = chrome.runtime.getURL(feature.page);
      link.setAttribute("aria-label", feature.name);
      const arrow = element("span", "", "→");
      arrow.setAttribute("aria-hidden", "true");
      link.append(arrow);
      section.append(link);
      card.append(section);
    }
    container.append(card);
  }
}

document.getElementById("version").textContent = `v${chrome.runtime.getManifest().version}`;
document.getElementById("search").addEventListener("input", render);
render();
