import { initResearchPanel } from "../../../shared/research-panel.js";
import * as core from "./core.js";
import { collectTab } from "./collector.js";

await initResearchPanel({ platform: "SIM", storageKey: core.STORAGE_KEY, core, collectTab });
