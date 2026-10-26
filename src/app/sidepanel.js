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
    for (const feature of platform.features) {
      const link = element("a", "open-tool", "");
      link.href = chrome.runtime.getURL(feature.page);
      link.setAttribute("aria-label", feature.name);
      link.title = feature.description;
      const content = element("span", "tool-content", "");
      content.append(element("strong", "", feature.name));
      content.append(element("span", "capabilities", feature.capabilities?.join(" · ") || feature.description));
      const arrow = element("span", "tool-arrow", "→");
      arrow.setAttribute("aria-hidden", "true");
      link.append(content, arrow);
      card.append(link);
    }
    if (platform.description) {
      const disclosure = element("details", "platform-description", "");
      disclosure.append(element("summary", "", "使用说明与隐私"));
      disclosure.append(element("p", "", platform.description));
      card.append(disclosure);
    }
    container.append(card);
  }
}

document.getElementById("version").textContent = `v${chrome.runtime.getManifest().version}`;
document.getElementById("search").addEventListener("input", render);
render();
