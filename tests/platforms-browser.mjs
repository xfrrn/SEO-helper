// Regression for platform grouping and actual SEM/SIM saved state, no network or user profile.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, cp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as sem from "../src/platforms/sem/keyword-magic/core.js";
import * as sim from "../src/platforms/sim/keyword-generator/core.js";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "output/platforms");
const extension = join(output, "extension");
await mkdir(extension, { recursive: true });
await cp(join(root, "manifest.json"), join(extension, "manifest.json"));
await cp(join(root, "src"), join(extension, "src"), { recursive: true });
const context = await chromium.launchPersistentContext(join(output, `profile-${Date.now()}`), {
  executablePath: process.env.CHROME_EXECUTABLE || undefined, headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  viewport: { width: 380, height: 900 },
});
const errors = [];
context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
function savedState(core, name, volume) {
  const url = core.keywordUrl(core.DEFAULT_URL, "calculator");
  const batchKey = JSON.stringify([JSON.stringify(["calculator"]), 0]);
  const key = JSON.stringify([batchKey, core.researchKey(url)]);
  return {
    config: { templateUrl: url, filterTemplateId: name, roots: "calculator", batchIndex: 0, settleSeconds: 3, ...(name === "SEM" ? { exportFormat: "CSV", exportFolder: "SEO-Helper" } : {}) },
    templates: [{ id: name, name: `${name} 专属模板`, url }],
    rootLibrary: [{ root: `${name}-only`, meaning: `${name} 专属词根`, examples: "" }],
    records: { [key]: { root: "calculator", url, state: "done", captures: [{ url }], rows: [{ keyword: `${name} 独立结果`, volume, kd: 12, cpc: 0.2 }], summary: {} } },
    exports: {},
  };
}
try {
  await context.route("https://**/*", route => route.abort());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const id = new URL(worker.url()).hostname;
  const home = `chrome-extension://${id}/src/app/sidepanel.html`;
  const panel = await context.newPage();
  await panel.goto(home);
  const google = panel.locator('[data-platform="google-trends"]');
  assert.equal(await panel.locator(".tool-card").count(), 4);
  assert.equal(await panel.locator('[data-platform="gamemonetize"]').getByRole("link", { name: "游戏采集", exact: true }).count(), 1);
  assert.equal(await google.count(), 1);
  assert.equal(await google.getByRole("link").count(), 2);
  assert.equal(await google.locator("h3").textContent(), "Google Trends");
  await panel.locator("#search").fill("词义分析");
  assert.equal(await panel.locator(".tool-card").count(), 1);
  assert.equal(await google.getByRole("link").count(), 1);
  await panel.locator("#search").fill("");
  await panel.setViewportSize({ width: 300, height: 800 });
  assert.equal(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await panel.screenshot({ path: join(output, "platforms-narrow.png"), fullPage: true });
  const states = { seoHelper: savedState(sem, "SEM", 11111), [sim.STORAGE_KEY]: savedState(sim, "SIM", 99999) };
  await panel.evaluate(value => chrome.storage.local.set(value), states);
  const readAll = () => panel.evaluate(keys => chrome.storage.local.get(keys), Object.keys(states));
  async function checkPlatform(name) {
    await panel.locator(`[data-platform="${name.toLowerCase()}"] .open-tool`).click();
    await panel.locator("#results summary").click();
    const text = await panel.locator("#results").innerText();
    const other = name === "SEM" ? "SIM" : "SEM";
    assert.ok(text.includes(`${name} 独立结果`));
    assert.ok(!text.includes(`${other} 独立结果`));
    assert.equal(await panel.locator("#filter-template option:checked").textContent(), `${name} 专属模板`);
    assert.equal(await panel.locator("#roots").inputValue(), "calculator");
    await panel.locator("#root-library > summary").click();
    assert.ok((await panel.locator("#library-list").innerText()).includes(`${name}-only`));
    assert.ok(!(await panel.locator("#library-list").innerText()).includes(`${other}-only`));
  }
  for (const name of ["SEM", "SIM", "SEM", "SIM"]) {
    await checkPlatform(name);
    assert.deepEqual(await readAll(), states);
    await panel.locator("#feature-home").click();
    await panel.locator("#platforms").waitFor();
    assert.deepEqual(await readAll(), states);
  }
  await checkPlatform("SIM");
  await panel.locator("#library-add-input").fill("Only-added-in-SIM");
  await panel.locator("#library-add").click();
  await panel.locator("#export-scope").filter({ hasText: "已添加 1 个词根" }).waitFor();
  assert.deepEqual((await readAll()).seoHelper, states.seoHelper);
  panel.once("dialog", dialog => dialog.accept());
  await panel.locator("#clear-research").click();
  await panel.locator("#export-scope").filter({ hasText: "已清空待研究" }).waitFor();
  assert.deepEqual((await readAll()).seoHelper, states.seoHelper);
  assert.deepEqual((await readAll())[sim.STORAGE_KEY].records, {});
  await panel.locator("#feature-home").click();
  await checkPlatform("SEM");
  await panel.reload();
  await panel.locator("#results summary").click();
  assert.ok((await panel.locator("#results").innerText()).includes("SEM 独立结果"));
  assert.deepEqual((await readAll()).seoHelper, states.seoHelper);
  assert.deepEqual(errors, []);
  console.log("PASS: one card per platform, Google Trends two features, narrow layout, same-root distinct SEM/SIM records/templates/libraries, repeated navigation/reload, SIM edit/clear preserves SEM.");
} catch (error) {
  for (const page of context.pages()) console.error(await page.locator("body").innerText().catch(() => ""));
  console.error(errors);
  throw error;
} finally { await context.close(); }
