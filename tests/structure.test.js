import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { platforms } from "../src/platforms/index.js";

const root = new URL("../", import.meta.url);

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
