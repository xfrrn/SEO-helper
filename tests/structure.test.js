import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { platforms, filterPlatforms } from "../src/platforms/index.js";

const root = new URL("../", import.meta.url);

test("homepage search matches platforms and features without changing the registry", () => {
  const items = [{ name: "SEM", domain: "sem.3ue.co", features: [
    { name: "词根研究", description: "关键词", capabilities: ["批量导出"] },
    { name: "其他工具", description: "其他" },
  ] }];
  assert.deepEqual(filterPlatforms(items, "  "), items);
  assert.equal(filterPlatforms(items, " SeM ")[0].features.length, 2);
  assert.equal(filterPlatforms(items, "3ue.co").length, 1);
  assert.equal(filterPlatforms(items, "批量导出")[0].features.length, 1);
  assert.equal(filterPlatforms(items, "词根")[0].features[0].name, "词根研究");
  assert.deepEqual(filterPlatforms(items, "不存在"), []);
  assert.equal(items[0].features.length, 2);
});

test("extension entries and registered feature assets exist with unique platform/feature IDs", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
  await access(new URL(manifest.background.service_worker, root));
  const pages = [manifest.side_panel.default_path];
  const ids = new Set();
  for (const platform of platforms) {
    assert.ok(platform.id && platform.name && platform.features.length);
    assert.ok(!ids.has(platform.id), `duplicate platform: ${platform.id}`);
    ids.add(platform.id);
    const features = new Set();
    for (const feature of platform.features) {
      assert.ok(feature.id && feature.name && feature.description);
      assert.ok(!features.has(feature.id), `duplicate feature: ${feature.id}`);
      features.add(feature.id);
      assert.equal(feature.page, `src/platforms/${platform.id}/${feature.id}/sidepanel.html`);
      pages.push(feature.page);
    }
  }
  for (const page of pages) {
    const url = new URL(page, root);
    const html = await readFile(url, "utf8");
    for (const [, asset] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      await access(new URL(asset, url));
    }
  }
});
