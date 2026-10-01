import { platforms } from "../platforms/index.js";

for (const platform of platforms) {
  const section = document.createElement("section");
  const heading = document.createElement("h2");
  heading.textContent = platform.name;
  section.append(heading);
  for (const feature of platform.features) {
    const link = document.createElement("a");
    link.href = chrome.runtime.getURL(feature.page);
    link.textContent = feature.name;
    const description = document.createElement("p");
    description.textContent = feature.description;
    section.append(link, description);
  }
  document.getElementById("platforms").append(section);
}
