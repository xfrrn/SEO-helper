import { initResearchPanel } from "../../../shared/research-panel.js";
import * as core from "./core.js";
import { collectTab } from "./collector.js";
import * as nativeExport from "./native-export.js";

await initResearchPanel({ platform: "SEM", storageKey: "seoHelper", core, collectTab, nativeExport });
