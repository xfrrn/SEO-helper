import { STORAGE_KEY, collectCurrentGame, currentGameTab, validateCapture, mobileReadyLabel, permitGameMonetize } from "./core.js";
import { BATCH_STORAGE_KEY, MAX_BATCH_URLS, inspectGameUrls, appendGameUrl, parseGameUrls, collectGameUrl, validateBatch } from "./batch.js";
import { buildBatchZip } from "./archive.js";

const $ = id => document.getElementById(id);
let result = null;
let busy = true;
let batch = { input: "", rows: [] };
let batchController = null;
let activeBatchIndex = -1;

function status(message, error = false) {
  $("status").textContent = message;
  $("status").dataset.error = String(error);
}

function setBusy(value) {
  busy = value;
  for (const id of ["collect", "feature-home", "copy-all", "copy-xml", "download-xml", "mode-current", "mode-batch", "batch-urls", "batch-start", "batch-add-current"]) $(id).disabled = value;
  $("collect").textContent = value ? "正在采集…" : "采集当前游戏";
  $("batch-download").disabled = value || !batch.rows.some(row => row.status === "success");
  $("batch-stop").hidden = !batchController;
  $("batch-stop").disabled = !batchController || batchController.signal.aborted;
}

function matchingBatch(urls) {
  return batch.rows.length === urls.length && batch.rows.every((row, index) => row.inputUrl === urls[index]);
}

function matchingPendingBatch(urls) {
  return matchingBatch(urls) && batch.rows.some(row => row.status === "pending");
}

function renderBatch() {
  const success = batch.rows.filter(row => row.status === "success").length;
  const failed = batch.rows.filter(row => row.status === "error").length;
  $("batch-progress").textContent = batch.rows.length
    ? `${success + failed} / ${batch.rows.length} 已处理 · ${success} 成功 · ${failed} 失败 · ${batch.rows.length - success - failed} 未完成`
    : "尚未开始批量采集。";
  $("batch-results").replaceChildren(...batch.rows.map((row, index) => {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.textContent = row.capture?.title || row.inputUrl;
    link.href = row.inputUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const state = document.createElement("span");
    state.className = "batch-state";
    state.dataset.error = String(row.status === "error");
    state.textContent = index === activeBatchIndex ? "正在采集…" : row.status === "success"
      ? `成功 · 手机：${mobileReadyLabel(row.capture.mobileReady)}` : row.status === "error" ? `失败：${row.error}` : "未采集";
    item.append(link, state);
    return item;
  }));
  updateBatchStart();
  setBusy(busy);
}

function updateBatchStart() {
  const { urls, duplicates, invalid } = inspectGameUrls($("batch-urls").value);
  const count = `不重复链接：${urls.length} 个${duplicates ? ` · 重复 ${duplicates} 个` : ""}${invalid.length ? ` · 无效 ${invalid.length} 行` : ""}`;
  if ($("batch-url-count").textContent !== count) $("batch-url-count").textContent = count;
  $("batch-url-count").dataset.error = String(urls.length > MAX_BATCH_URLS);
  const valid = !invalid.length && urls.length > 0 && urls.length <= MAX_BATCH_URLS;
  const matches = valid && matchingBatch(urls);
  const pending = valid && matchingPendingBatch(urls);
  const edited = batch.rows.length > 0 && !matches;
  $("batch-start").textContent = pending ? "继续未完成项" : edited ? "开始新批次" : batch.rows.length ? "重新采集全部" : "开始批量采集";
  $("batch-download").textContent = edited ? "下载上次 ZIP" : "下载 ZIP";
  $("batch-input-note").hidden = !edited;
}

function tidyBatchInput() {
  const inspection = inspectGameUrls($("batch-urls").value);
  $("batch-urls").value = inspection.cleaned;
  updateBatchStart();
  if (inspection.duplicates) status(`已自动去除 ${inspection.duplicates} 个重复链接。`);
}

async function saveBatch() {
  batch.input = $("batch-urls").value;
  try { await chrome.storage.local.set({ [BATCH_STORAGE_KEY]: batch }); }
  catch { throw new Error("批量记录保存失败，当前结果仍可下载 ZIP，请下载后重试。"); }
}

function render() {
  $("empty").hidden = Boolean(result);
  $("result").hidden = !result;
  $("xml").value = result?.xml || "";
  if (!result) return;
  $("game-title").textContent = result.title;
  $("game-id").textContent = result.gameId;
  $("mobile-ready").textContent = mobileReadyLabel(result.mobileReady);
  $("captured-at").textContent = new Date(result.capturedAt).toLocaleString();
  $("source").href = result.pageUrl;
}

async function run(action) {
  if (busy) return;
  setBusy(true);
  try { await action(); }
  catch (error) { status(error.message, true); }
  finally { setBusy(false); }
}

$("collect").addEventListener("click", () => run(async () => {
  result = null;
  render();
  status("正在读取当前游戏和 XML…");
  result = await collectCurrentGame();
  render();
  try { await chrome.storage.local.set({ [STORAGE_KEY]: result }); }
  catch { throw new Error("采集完成，但保存失败；当前结果仍可复制或下载，请重试采集以保存。"); }
  status(`已采集 ${result.title}，手机支持：${mobileReadyLabel(result.mobileReady)}。`);
}));

async function copy(value, message) {
  try { await navigator.clipboard.writeText(value); }
  catch { throw new Error("复制失败，请从 XML 文本框手动复制，或点击“下载 XML”。"); }
  status(message);
}
$("copy-all").addEventListener("click", () => run(() => copy(JSON.stringify(result, null, 2), "全部游戏信息已复制（JSON）。")));
$("copy-xml").addEventListener("click", () => run(() => copy(result.xml, "原始 XML 已复制。")));
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("download-xml").addEventListener("click", () => run(async () => {
  downloadBlob(new Blob([result.xml], { type: "application/xml;charset=utf-8" }), `gamemonetize-${result.gameId}.xml`);
  status("已发起 XML 下载，请在浏览器下载列表确认。");
}));

for (const mode of ["current", "batch"]) $("mode-" + mode).addEventListener("click", () => run(async () => {
  await saveBatch();
  for (const value of ["current", "batch"]) {
    $(value + "-panel").hidden = value !== mode;
    $("mode-" + value).setAttribute("aria-pressed", String(value === mode));
  }
  status(mode === "batch" ? "每行粘贴一个游戏链接，采集后可打包下载。" : "切换到游戏详情页后，点击“采集当前游戏”。");
}));
$("batch-urls").addEventListener("input", event => {
  if (["insertFromPaste", "insertFromDrop"].includes(event.inputType)) tidyBatchInput();
  else updateBatchStart();
});
$("batch-urls").addEventListener("change", tidyBatchInput);
$("batch-add-current").addEventListener("click", () => run(async () => {
  const tab = await currentGameTab();
  const next = appendGameUrl($("batch-urls").value, tab.url);
  $("batch-urls").value = next.cleaned;
  updateBatchStart();
  await saveBatch();
  status(next.added ? `当前网页已添加，不重复链接共 ${next.urls.length} 个。` : "当前网页已在列表中，未重复添加。");
}));
$("batch-start").addEventListener("click", () => run(async () => {
  tidyBatchInput();
  const urls = parseGameUrls($("batch-urls").value);
  await permitGameMonetize();
  if (!matchingPendingBatch(urls)) batch.rows = urls.map(inputUrl => ({ inputUrl, status: "pending" }));
  renderBatch();
  await saveBatch();
  const controller = new AbortController();
  batchController = controller;
  try {
    for (const [index, row] of batch.rows.entries()) {
      if (controller.signal.aborted) break;
      if (row.status !== "pending") continue;
      activeBatchIndex = index;
      renderBatch();
      status(`正在采集第 ${index + 1} / ${batch.rows.length} 个游戏…`);
      try {
        const capture = await collectGameUrl(row.inputUrl, controller.signal);
        batch.rows[index] = { inputUrl: row.inputUrl, status: "success", capture };
      } catch (error) {
        if (controller.signal.aborted) break;
        batch.rows[index] = { inputUrl: row.inputUrl, status: "error", error: error.message };
      }
      activeBatchIndex = -1;
      renderBatch();
      await saveBatch();
    }
    status(`${controller.signal.aborted ? "已停止，未完成项可继续采集。" : "批量采集结束。"}${$("batch-progress").textContent}`);
  } finally {
    batchController = null;
    activeBatchIndex = -1;
    renderBatch();
  }
}));
$("batch-stop").addEventListener("click", () => {
  batchController?.abort();
  $("batch-stop").disabled = true;
  status("正在停止，已完成的结果会保留。");
});
$("batch-download").addEventListener("click", () => run(async () => {
  downloadBlob(buildBatchZip(batch.rows), "gamemonetize-games.zip");
  status("已发起 ZIP 下载，请在浏览器下载列表确认；失败和未完成项见 manifest.json。");
}));
$("feature-home").addEventListener("click", () => run(async () => {
  await saveBatch();
  location.href = chrome.runtime.getURL("src/app/sidepanel.html");
}));

try {
  const saved = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (saved) result = validateCapture(saved);
  status(result ? "已恢复上次采集；采集时间和来源见上方，可点击按钮重新采集。" : "切换到 GameMonetize 游戏详情页后，点击“采集当前游戏”。");
} catch (error) { status(`无法恢复上次采集：${error.message}`, true); }
try {
  const saved = (await chrome.storage.local.get(BATCH_STORAGE_KEY))[BATCH_STORAGE_KEY];
  if (saved) batch = validateBatch(saved);
} catch (error) { status(`无法恢复批量记录：${error.message}`, true); }
$("batch-urls").value = inspectGameUrls(batch.input).cleaned;
render();
renderBatch();
setBusy(false);
