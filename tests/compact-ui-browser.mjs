// Isolated extension UI checks; external requests are blocked, no account or user profile.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, cp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { platforms } from "../src/platforms/index.js";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "output/compact-ui");
const extension = join(output, "extension");
await mkdir(extension, { recursive: true });
await cp(join(root, "manifest.json"), join(extension, "manifest.json"));
await cp(join(root, "src"), join(extension, "src"), { recursive: true });
const context = await chromium.launchPersistentContext(join(output, `profile-${Date.now()}`), {
  executablePath: process.env.CHROME_EXECUTABLE || undefined,
  headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const errors = [];
try {
  await context.route("https://**/*", route => route.abort());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const base = `chrome-extension://${new URL(worker.url()).hostname}/`;
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  const pages = ["src/app/sidepanel.html", ...platforms.flatMap(p => p.features.map(f => f.page))];
  for (const width of [280, 380, 560]) {
    await page.setViewportSize({ width, height: 800 });
    for (const [index, path] of pages.entries()) {
      await page.goto(base + path);
      await page.locator(index === 0 ? ".open-tool" : "#feature-home").first().waitFor();
      const layout = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        color: getComputedStyle(document.documentElement).color,
        background: getComputedStyle(document.documentElement).backgroundColor,
        fontSize: getComputedStyle(document.body).fontSize,
      }));
      assert.equal(layout.overflow, false, `${width}px overflow: ${path}`);
      assert.equal(layout.color, "rgb(33, 38, 48)", path);
      assert.equal(layout.background, "rgb(255, 255, 255)", path);
      assert.equal(layout.fontSize, "13px", path);
      if (index === 0) {
        assert.equal(await page.locator(".open-tool").count(), 5);
        assert.equal(await page.locator(".brand").evaluate(e => e.getBoundingClientRect().height), 48);
        assert.equal(await page.locator(".open-tool").last().evaluate(e => {
          const main = document.querySelector("main").getBoundingClientRect();
          return e.getBoundingClientRect().bottom <= main.bottom;
        }), true, `${width}px should show every tool without scrolling`);
        await page.locator("#search").fill("does-not-exist");
        await page.locator("#no-results").waitFor();
        await page.locator("#search").fill("Google");
        assert.equal(await page.locator(".open-tool").count(), 2);
        await page.locator(".platform-description summary").click();
        assert.match(await page.locator(".platform-description").innerText(), /发送给 Google/);
        await page.locator("#search").fill("");
        await page.locator("#search").focus();
        await page.keyboard.press("Tab");
        assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), "分组对比");
        assert.notEqual(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), "none");
      }
      await page.screenshot({ path: join(output, `${width}-${index}.png`) });
      if (index > 0) {
        await page.locator("#feature-home").click();
        await page.locator("#platforms").waitFor();
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log("PASS: six pages at 280/380/560px; compact palette, no horizontal overflow, all home tools visible, search, privacy disclosure, keyboard focus and return navigation.");
} finally {
  await context.close();
}
