import { DEFAULT_URL, researchUrl, researchKey, keywordUrl, parseRoots, parseBatches, appendRootBatches, filterDescription, mergeCapture } from "./core.js";
import { PRESET_ROOTS } from "./root-library.js";
import { collectTab } from "./collector.js";
import { exportNativeFile, normalizeDownloadFolder } from "./native-export.js";

const $ = (id) => document.getElementById(id);
let state = { config: { templateUrl: DEFAULT_URL, filterTemplateId: "", roots: "Checker", batchIndex: 0, settleSeconds: 3, exportFormat: "CSV", exportFolder: "SEO-Helper" }, templates: [], rootLibrary: PRESET_ROOTS, records: {}, exports: {} };
const librarySelection = new Set();
let controller = null;
let savingConfig = false;
let notice = null;
let workTabId = null;
let saveTimer;

function status(message, error = false) {
  notice = { message, error };
  $("export-scope").textContent = message;
  $("export-scope").dataset.error = String(error);
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function batches(config = state.config) {
  const occurrences = new Map();
  return parseBatches(config.roots).map((roots) => {
    const identity = JSON.stringify(roots.map((root) => root.toLowerCase()));
    const occurrence = occurrences.get(identity) || 0;
    occurrences.set(identity, occurrence + 1);
    // Reordering distinct lines preserves progress; repeated lines remain separate batches.
    const batchKey = JSON.stringify([identity, occurrence]);
    return roots.map((root) => {
      const url = keywordUrl(config.templateUrl, root);
      return { root, url, key: JSON.stringify([batchKey, researchKey(url)]) };
    });
  });
}

function jobs(config = state.config) {
  return batches(config).flat();
}

function selectedJobs(groups = batches()) {
  return groups[state.config.batchIndex] || [];
}

function revealRange() {
  const first = $("root-list").querySelector('[data-selected="true"]');
  if (first) $("root-list").scrollTop = first.offsetTop;
}

async function persist(value = state) {
  try { await chrome.storage.local.set({ seoHelper: value }); }
  catch { throw new Error("本机进度保存失败，请保持侧边栏打开，并检查浏览器下载记录。"); }
}

function readConfig(templateValue = $("template-url").value, rootsValue = $("roots").value) {
  const templateUrl = researchUrl(templateValue).href;
  const groups = parseBatches(rootsValue);
  const roots = groups.map((group) => group.join(", ")).join("\n");
  const batchIndex = Math.min(state.config.batchIndex, Math.max(0, groups.length - 1));
  const settleSeconds = Number($("settle-seconds").value);
  const exportFormat = $("export-format").value;
  const exportFolder = normalizeDownloadFolder($("export-folder").value);
  if (!Number.isFinite(settleSeconds) || settleSeconds < 2 || settleSeconds > 30) throw new Error("等待时间应在 2–30 秒之间。");
  if (!["CSV", "XLSX", "CSV Semicolon"].includes(exportFormat)) throw new Error("请选择网站支持的导出格式。");
  const template = state.templates.find((item) => item.id === state.config.filterTemplateId);
  const filterTemplateId = template && researchKey(keywordUrl(template.url, "_")) === researchKey(keywordUrl(templateUrl, "_")) ? template.id : "";
  return { templateUrl, filterTemplateId, roots, batchIndex, settleSeconds, exportFormat, exportFolder };
}

function templateWithName() {
  const name = $("template-name").value.trim().toLowerCase();
  return state.templates.find((item) => item.name.toLowerCase() === name);
}

function renderTemplates() {
  const select = $("filter-template");
  const placeholder = element("option", "当前筛选（未保存模板）");
  placeholder.value = "";
  placeholder.disabled = true;
  select.replaceChildren(placeholder, ...state.templates.map((template) => {
    const option = element("option", template.name);
    option.value = template.id;
    return option;
  }));
  select.value = state.config.filterTemplateId || "";
  select.disabled = Boolean(controller) || savingConfig || !state.templates.length;
  $("delete-template").disabled = Boolean(controller) || savingConfig || !select.value;
  $("save-template").textContent = templateWithName() ? "更新模板" : "保存模板";
}

function visibleLibraryEntries() {
  const search = $("library-search").value.trim().toLowerCase();
  return state.rootLibrary.filter((item) => `${item.root} ${item.meaning} ${item.examples}`.toLowerCase().includes(search));
}

function updateLibrarySelection() {
  const busy = Boolean(controller) || savingConfig;
  $("library-selection-count").textContent = `已选 ${librarySelection.size} 个`;
  $("library-import").textContent = `加入待研究（${librarySelection.size}）`;
  $("library-import").disabled = busy || !librarySelection.size;
  $("library-clear-selection").disabled = busy || !librarySelection.size;
  $("library-select-all").disabled = busy || !visibleLibraryEntries().length;
}

function renderLibrary() {
  const valid = new Set(state.rootLibrary.map((item) => item.root.toLowerCase()));
  for (const root of librarySelection) if (!valid.has(root)) librarySelection.delete(root);
  const scrollTop = $("library-list").scrollTop;
  const entries = visibleLibraryEntries();
  $("library-list").replaceChildren(...entries.map((item) => {
    const row = element("li");
    const label = element("label", undefined, "library-choice");
    const checkbox = element("input");
    checkbox.type = "checkbox";
    checkbox.value = item.root;
    checkbox.checked = librarySelection.has(item.root.toLowerCase());
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) librarySelection.add(item.root.toLowerCase());
      else librarySelection.delete(item.root.toLowerCase());
      updateLibrarySelection();
    });
    const description = element("span");
    description.append(element("span", item.root, "library-word"), element("span", item.meaning || "自定义词根", "library-meaning"));
    if (item.examples) description.append(element("span", item.examples, "library-examples"));
    label.append(checkbox, description);
    const remove = element("button", "删除", "library-delete");
    remove.type = "button";
    remove.setAttribute("aria-label", `从词根库删除 ${item.root}`);
    remove.addEventListener("click", () => removeLibraryRoot(item.root));
    row.append(label, remove);
    return row;
  }));
  $("library-list").scrollTop = scrollTop;
  $("library-empty").hidden = Boolean(entries.length);
  $("library-count").textContent = `（${state.rootLibrary.length}）`;
  updateLibrarySelection();
}

async function describeFilter() {
  const url = state.config.templateUrl;
  $("database").textContent = (new URL(url).searchParams.get("db") || "默认").toUpperCase();
  const description = await filterDescription(url);
  if (state.config.templateUrl === url) $("filter-description").textContent = description;
}

function setBusy(busy) {
  $("feature-home").disabled = busy;
  $("config-fields").disabled = busy;
  $("export-format").disabled = busy;
  $("export-folder").disabled = busy;
  $("download-settings").disabled = busy;
  render();
}

function alreadyExported(job, config = state.config) {
  const file = state.exports[job.key];
  return file?.state === "done" && file.format === config.exportFormat && (file.folder || "") === config.exportFolder;
}

function render() {
  renderTemplates();
  renderLibrary();
  const groups = batches();
  const list = groups.flat();
  const selected = selectedJobs(groups);
  const busy = Boolean(controller) || savingConfig;
  $("range-previous").disabled = busy || state.config.batchIndex <= 0;
  $("range-next").disabled = busy || state.config.batchIndex >= groups.length - 1;
  $("range-description").textContent = groups.length ? `第 ${state.config.batchIndex + 1} / ${groups.length} 批` : "尚无词根";
  $("open-selected").textContent = `打开本批（${selected.length} 个词根）`;
  $("open-selected").disabled = busy || !selected.length;
  $("export-batch").textContent = controller ? "停止任务" : `导出本批（${selected.length}）`;
  $("export-settings-summary").textContent = `· ${state.config.exportFormat} · ${state.config.exportFolder || "下载目录"}`;
  const scrollTop = $("root-list").scrollTop;
  const rows = groups.map((group, index) => {
    const row = element("li");
    row.dataset.selected = String(index === state.config.batchIndex);
    const link = element("button", group.map((job) => job.root).join(", "), "root-link");
    link.type = "button";
    link.disabled = busy;
    link.title = `选择第 ${index + 1} 批（${group.length} 个词根）`;
    link.setAttribute("aria-pressed", row.dataset.selected);
    link.addEventListener("click", () => selectBatch(index));
    const completed = group.filter((job) => alreadyExported(job)).length;
    const empty = group.filter((job) => state.exports[job.key]?.state === "empty").length;
    const working = group.some((job) => state.exports[job.key]?.state === "working");
    const failed = group.some((job) => state.exports[job.key]?.state === "error");
    const label = working ? "导出中" : failed ? "失败" : `${completed + empty}/${group.length}${empty ? ` · 无结果 ${empty}` : ""}`;
    const progress = element("span", label, "root-state");
    progress.title = `本批已处理 ${completed + empty} / ${group.length} 个词根：已导出 ${completed}，无结果 ${empty}`;
    progress.dataset.state = completed + empty === group.length ? "done" : failed ? "error" : "pending";
    row.append(element("span", `${index + 1}.`, "root-number"), link, progress);
    return row;
  });
  $("root-list").replaceChildren(...rows);
  $("root-list").scrollTop = scrollTop;
  $("root-list-empty").hidden = Boolean(list.length);
  const opened = new Set([...$("results").querySelectorAll("details[open]")].map((node) => node.dataset.key));
  $("results").replaceChildren();
  $("root-count").textContent = `${groups.length} 批 · ${list.length} 词`;
  let completed = 0;
  let empty = 0;
  for (const job of selected) {
    const record = state.records[job.key];
    const exported = state.exports[job.key];
    if (alreadyExported(job)) completed++;
    if (exported?.state === "empty") empty++;
    const detail = element("details", undefined, "result");
    detail.dataset.key = job.key;
    detail.open = opened.has(job.key);
    const heading = element("summary", job.root);
    let description = alreadyExported(job) ? "已导出" : exported?.state === "empty" ? "已检查" : "待导出";
    if (record?.state === "working") description = "正在加载与采集…";
    else if (record?.state === "error") description = record.error + (record.captures?.length ? "（已保留上次结果）" : "");
    else if (record?.state === "done") {
      const total = record.summary?.total_keywords;
      description = record.empty ? "当前筛选下无结果" : `已采集 ${record.rows.length} 行${total ? ` / 网站报告 ${total} 个关键词` : ""}`;
    }
    const label = element("span", description, "result-status");
    label.dataset.state = record?.state || "pending";
    heading.append(label);
    if (exported) {
      const downloadStatus = exported.state === "done" ? `原生文件已下载：${exported.filename}`
        : exported.state === "empty" ? "当前筛选下无结果，已跳过下载。可再次点击“原生导出”检查。"
        : exported.state === "working" ? "正在原生导出…" : exported.error;
      const downloadLabel = element("span", downloadStatus, "result-status");
      downloadLabel.dataset.state = exported.state;
      heading.append(downloadLabel);
    }
    detail.append(heading);
    const actions = element("div", undefined, "actions");
    const view = element("button", "打开结果");
    view.disabled = busy;
    view.addEventListener("click", () => openResult(job.url).catch((error) => status(error.message, true)));
    const capture = element("button", record?.captures?.length ? "刷新预览" : "读取预览");
    capture.disabled = busy;
    capture.addEventListener("click", () => runJobs([job]));
    const native = element("button", "原生导出");
    native.disabled = busy;
    native.addEventListener("click", () => runNativeExports([job]));
    actions.append(view, capture, native);
    if (exported?.state === "done") {
      const reveal = element("button", "打开所在文件夹");
      reveal.title = exported.path || exported.filename;
      reveal.addEventListener("click", async () => {
        try {
          const [file] = await chrome.downloads.search({ id: exported.downloadId });
          if (!file?.exists) throw new Error("文件已移动、删除，或下载记录已清除。");
          chrome.downloads.show(exported.downloadId);
        } catch (error) { status(`无法打开文件位置：${error.message}`, true); }
      });
      actions.append(reveal);
    }
    detail.append(actions);
    if (exported?.path) detail.append(element("p", `保存位置：${exported.path}`, "hint saved-path"));
    if (record?.captures?.length) {
      const counts = record.summary || {};
      const metrics = [counts.total_volume && `总搜索量 ${counts.total_volume}`, counts.average_kd && `平均 KD ${counts.average_kd}`].filter(Boolean);
      if (metrics.length) detail.append(element("p", metrics.join(" · "), "hint"));
      if (record.rows.length) {
        const wrap = element("div", undefined, "table-wrap");
        const table = element("table");
        const head = element("tr");
        for (const title of ["关键词", "搜索量", "KD", "CPC"]) head.append(element("th", title));
        const thead = element("thead");
        thead.append(head);
        const tbody = element("tbody");
        for (const row of record.rows.slice(0, 8)) {
          const tr = element("tr");
          for (const key of ["keyword", "volume", "kd", "cpc"]) tr.append(element("td", row[key] == null ? "—" : String(row[key])));
          tbody.append(tr);
        }
        table.append(thead, tbody);
        wrap.append(table);
        detail.append(wrap);
      }
      detail.append(element("p", `${record.captures.length} 次页面快照 · ${record.rows.length} 行去重数据。${record.rows.length > 8 ? "此处预览前 8 行。" : ""}仅覆盖已加载行。`, "hint"));
    }
    $("results").append(detail);
  }
  $("empty").hidden = list.length > 0;
  const progress = `${completed} / ${selected.length} 已导出${empty ? ` · ${empty} 无结果` : ""}`;
  $("progress").textContent = progress;
  $("export-current").disabled = busy;
  $("export-batch").disabled = savingConfig || (!controller && !selected.length);
  $("export-scope").textContent = notice?.message || (groups.length ? `本批 ${progress} · SEM 范围：所有` : "每行一批，选择一行开始。");
  $("export-scope").dataset.error = String(notice?.error || false);
}

async function openResult(url) {
  if (workTabId !== null) {
    try { await chrome.tabs.get(workTabId); }
    catch { workTabId = null; }
  }
  const tab = workTabId === null
    ? await chrome.tabs.create({ url, active: true })
    : await chrome.tabs.update(workTabId, { url, active: true });
  workTabId = tab.id;
  return tab.id;
}

async function openSelectedResults() {
  if (controller || savingConfig) return;
  clearTimeout(saveTimer);
  let opened = 0;
  try {
    state.config = readConfig();
    const selected = selectedJobs();
    if (!selected.length) return;
    controller = new AbortController();
    setBusy(true);
    await persist();
    for (const job of selected) {
      controller.signal.throwIfAborted();
      await chrome.tabs.create({ url: job.url, active: false });
      opened++;
    }
    status(`已在新标签页打开 ${opened} 个 SEM 筛选结果。`);
  } catch (error) {
    status(controller?.signal.aborted ? `已停止打开，已打开 ${opened} 个结果。` : error.message, !controller?.signal.aborted);
  } finally { controller = null; setBusy(false); }
}

async function selectBatch(index) {
  if (controller || savingConfig) return;
  clearTimeout(saveTimer);
  if (await saveConfig(index)) revealRange();
}

async function permit(downloads = false) {
  if (!await chrome.permissions.request({ origins: ["https://sem.3ue.co/*"], ...(downloads ? { permissions: ["downloads"] } : {}) })) {
    throw new Error(downloads ? "原生导出需要 SEM 页面权限及下载权限，用于确认网站文件下载完成。" : "需要允许读取 sem.3ue.co，才能预览关键词表格。");
  }
}

async function saveCapture(job, capture, append) {
  const data = mergeCapture(append ? state.records[job.key] : undefined, capture);
  state.records[job.key] = { root: job.root, url: job.url, state: "done", ...data, empty: Boolean(capture.empty) };
  if (data.rows.length && state.exports[job.key]?.state === "empty") delete state.exports[job.key];
  await persist();
}

async function runJobs(selected) {
  if (controller || savingConfig) return;
  clearTimeout(saveTimer);
  try {
    state.config = readConfig();
    const candidates = selected ? jobs().filter((job) => selected.some((item) => item.key === job.key)) : selectedJobs();
    const pending = candidates.filter((job) => selected || state.records[job.key]?.state !== "done");
    if (!pending.length) return;
    controller = new AbortController();
    setBusy(true);
    await permit();
    await persist();
    let finished = 0;
    for (const job of pending) {
      controller.signal.throwIfAborted();
      state.records[job.key] = { ...state.records[job.key], root: job.root, url: job.url, state: "working" };
      status(`正在采集 ${job.root}（${finished + 1}/${pending.length}），请不要切换研究标签页的查询。`);
      render();
      try {
        const tabId = await openResult(job.url);
        controller.signal.throwIfAborted();
        const capture = await collectTab(tabId, job.url, { signal: controller.signal, settleMs: state.config.settleSeconds * 1000 });
        await saveCapture(job, capture, false);
      } catch (error) {
        state.records[job.key].state = "error";
        state.records[job.key].error = controller.signal.aborted ? "已停止，可重新采集。" : error.message;
        await persist();
        // Stop on login, navigation, parsing or quota errors instead of burning more queries.
        throw error;
      }
      finished++;
      render();
    }
    status(`已完成 ${finished} 个词根的预览。`);
  } catch (error) {
    status(controller?.signal.aborted ? "采集已停止，已完成的结果已保留。" : error.message, !controller?.signal.aborted);
  } finally {
    controller = null;
    setBusy(false);
  }
}

async function saveConfig(batchIndex) {
  if (controller || savingConfig) return false;
  try {
    const config = readConfig();
    if (Number.isInteger(batchIndex)) config.batchIndex = Math.max(0, Math.min(batchIndex, batches(config).length - 1));
    return await commitConfig(config);
  } catch (error) { status(error.message, true); return false; }
}

async function commitConfig(config, { templates = state.templates, rootLibrary = state.rootLibrary } = {}) {
  try {
    const keys = new Set(jobs(config).map((job) => job.key));
    const next = { ...state, config, templates, rootLibrary };
    if (config.roots !== state.config.roots) {
      next.records = Object.fromEntries(Object.entries(state.records).filter(([key]) => keys.has(key)));
      next.exports = Object.fromEntries(Object.entries(state.exports).filter(([key]) => keys.has(key)));
    }
    savingConfig = true;
    setBusy(true);
    await persist(next);
    state = next;
    notice = null;
    await describeFilter();
    return true;
  } catch (error) { status(error.message, true); return false; }
  finally { savingConfig = false; setBusy(false); }
}

async function saveTemplate() {
  if (controller || savingConfig) return;
  clearTimeout(saveTimer);
  try {
    const name = $("template-name").value.trim();
    if (!name || name.length > 60) throw new Error("请输入 1–60 个字符的模板名称。");
    const config = readConfig();
    const existing = templateWithName();
    const url = keywordUrl(config.templateUrl, new URL(config.templateUrl).searchParams.get("q"));
    const template = { id: existing?.id || crypto.randomUUID(), name, url };
    const templates = existing ? state.templates.map((item) => item.id === existing.id ? template : item) : [...state.templates, template];
    if (await commitConfig({ ...config, templateUrl: url, filterTemplateId: template.id }, { templates })) {
      $("template-url").value = url;
      $("template-name").value = name;
      renderTemplates();
      status(`已${existing ? "更新" : "保存"}模板「${name}」。下次从筛选模板中选择即可。`);
    }
  } catch (error) { status(error.message, true); }
}

async function applyTemplate() {
  if (controller || savingConfig) return;
  clearTimeout(saveTimer);
  const template = state.templates.find((item) => item.id === $("filter-template").value);
  if (!template) return;
  try {
    const config = { ...readConfig(template.url), filterTemplateId: template.id };
    if (await commitConfig(config)) {
      $("template-url").value = template.url;
      $("template-name").value = template.name;
      renderTemplates();
      status(`已使用模板「${template.name}」。`);
    }
  } catch (error) { status(error.message, true); renderTemplates(); }
}

async function deleteTemplate() {
  if (controller || savingConfig) return;
  clearTimeout(saveTimer);
  const template = state.templates.find((item) => item.id === $("filter-template").value);
  if (!template) return;
  try {
    const config = { ...readConfig(), filterTemplateId: "" };
    if (await commitConfig(config, { templates: state.templates.filter((item) => item.id !== template.id) })) {
      $("template-name").value = "";
      renderTemplates();
      status(`已删除模板「${template.name}」，当前筛选条件继续保留。`);
    }
  } catch (error) { status(error.message, true); }
}

async function addLibraryRoots() {
  if (controller || savingConfig) return;
  clearTimeout(saveTimer);
  try {
    const roots = parseRoots($("library-add-input").value);
    if (!roots.length) throw new Error("请输入要添加的词根，多个词根用逗号分隔。");
    const existing = new Set(state.rootLibrary.map((item) => item.root.toLowerCase()));
    const added = roots.filter((root) => !existing.has(root.toLowerCase())).map((root) =>
      PRESET_ROOTS.find((item) => item.root.toLowerCase() === root.toLowerCase()) || { root, meaning: "", examples: "" });
    if (!added.length) { status("这些词根已在词库中，可以直接勾选。"); return; }
    if (await commitConfig(readConfig(), { rootLibrary: [...state.rootLibrary, ...added] })) {
      for (const item of added) librarySelection.add(item.root.toLowerCase());
      $("library-add-input").value = "";
      $("library-search").value = "";
      renderLibrary();
      $("library-list").scrollTop = $("library-list").scrollHeight;
      $("library-add-input").focus();
      status(`已添加 ${added.length} 个词根到词库，勾选后可加入待研究。`);
    }
  } catch (error) { status(error.message, true); }
}

async function removeLibraryRoot(root) {
  if (controller || savingConfig) return;
  clearTimeout(saveTimer);
  try {
    if (await commitConfig(readConfig(), { rootLibrary: state.rootLibrary.filter((item) => item.root !== root) })) {
      status(`已从词根库删除「${root}」。`);
    }
  } catch (error) { status(error.message, true); }
}

async function importLibraryRoots() {
  if (controller || savingConfig) return;
  clearTimeout(saveTimer);
  try {
    const selected = state.rootLibrary.filter((item) => librarySelection.has(item.root.toLowerCase())).map((item) => item.root);
    const added = appendRootBatches($("roots").value, selected);
    if (!added.added) { status("所选词根已在待研究列表中。请勾选其他词根。"); return; }
    const config = { ...readConfig(undefined, added.roots), batchIndex: added.firstBatch };
    if (await commitConfig(config)) {
      $("roots").value = config.roots;
      librarySelection.clear();
      renderLibrary();
      $("root-library").open = false;
      $("root-editor").open = false;
      revealRange();
      $("root-list").focus();
      status(`已加入 ${added.added} 个词根，生成 ${Math.ceil(added.added / 5)} 批。`);
    }
  } catch (error) { status(error.message, true); }
}

async function runNativeExports(selected, current = false) {
  if (controller || savingConfig) return;
  clearTimeout(saveTimer);
  try {
    state.config = readConfig();
    const candidates = selected ? jobs().filter((job) => selected.some((item) => item.key === job.key)) : selectedJobs();
    let pending = candidates.filter((job) => selected || (!alreadyExported(job) && state.exports[job.key]?.state !== "empty"));
    if (!current && !pending.length) {
      const empty = candidates.filter((job) => state.exports[job.key]?.state === "empty").length;
      status(empty ? `本批已全部处理：已导出 ${candidates.length - empty} 个，无结果 ${empty} 个。展开词根可重新检查。` : "本批已全部导出，可切换下一批；展开词根可再次导出。");
      return;
    }
    controller = new AbortController();
    setBusy(true);
    await permit(true);
    if (current) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = researchUrl(tab?.url || "").href;
      const matchingJob = selectedJobs().find((job) => researchKey(job.url) === researchKey(url));
      pending = [{ root: new URL(url).searchParams.get("q"), url, key: matchingJob?.key || researchKey(url), tabId: tab.id }];
    }
    let finished = 0;
    let empty = 0;
    for (const job of pending) {
      controller.signal.throwIfAborted();
      state.exports[job.key] = { root: job.root, url: job.url, state: "working" };
      await persist();
      status(`正在原生导出 ${job.root}（${finished + 1}/${pending.length}）：网站“所有” → ${state.config.exportFormat}，等待下载完成…`);
      render();
      try {
        const tabId = job.tabId ?? await openResult(job.url);
        const file = await exportNativeFile(tabId, job.url, { format: state.config.exportFormat, folder: state.config.exportFolder, signal: controller.signal, settleMs: state.config.settleSeconds * 1000 });
        state.exports[job.key] = { root: job.root, url: job.url, state: file.empty ? "empty" : "done", ...file };
        if (file.empty) empty++;
        if (file.empty || state.records[job.key]?.empty) delete state.records[job.key];
        await persist();
      } catch (error) {
        state.exports[job.key].state = "error";
        state.exports[job.key].error = controller.signal.aborted ? "任务已停止；重试前请检查浏览器下载记录。" : error.message;
        await persist();
        throw error;
      }
      finished++;
      render();
    }
    status(empty ? `已处理 ${finished} 个词根：已导出 ${finished - empty} 个，无结果 ${empty} 个（已跳过下载）。`
      : `已完成 ${finished} 个词根的原生导出。SEM 原始文件已下载，可直接交给 Agent 分析。`);
  } catch (error) {
    status(controller?.signal.aborted ? "任务已停止。已开始的浏览器下载可能继续，请查看下载记录。" : error.message, !controller?.signal.aborted);
  } finally {
    controller = null;
    setBusy(false);
  }
}

$("feature-home").addEventListener("click", async () => {
  if (controller || savingConfig) return;
  clearTimeout(saveTimer);
  if (await saveConfig()) location.href = chrome.runtime.getURL("src/app/sidepanel.html");
});
$("config-form").addEventListener("submit", (event) => { event.preventDefault(); clearTimeout(saveTimer); saveConfig(); });
$("library-search").addEventListener("input", renderLibrary);
$("library-select-all").addEventListener("click", () => { for (const item of visibleLibraryEntries()) librarySelection.add(item.root.toLowerCase()); renderLibrary(); });
$("library-clear-selection").addEventListener("click", () => { librarySelection.clear(); renderLibrary(); });
$("library-import").addEventListener("click", importLibraryRoots);
$("library-add").addEventListener("click", addLibraryRoots);
$("library-add-input").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); addLibraryRoots(); } });
$("save-template").addEventListener("click", saveTemplate);
$("filter-template").addEventListener("change", applyTemplate);
$("delete-template").addEventListener("click", deleteTemplate);
$("template-name").addEventListener("input", () => { $("save-template").textContent = templateWithName() ? "更新模板" : "保存模板"; });
$("template-name").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); saveTemplate(); } });
$("export-current").addEventListener("click", () => runNativeExports(undefined, true));
$("export-batch").addEventListener("click", () => controller ? controller.abort() : runNativeExports());
$("open-selected").addEventListener("click", openSelectedResults);
$("range-previous").addEventListener("click", () => selectBatch(state.config.batchIndex - 1));
$("range-next").addEventListener("click", () => selectBatch(state.config.batchIndex + 1));
$("apply-roots").addEventListener("click", async () => {
  clearTimeout(saveTimer);
  if (await saveConfig()) {
    $("roots").value = state.config.roots;
    $("root-editor").open = !state.config.roots;
    if (state.config.roots) $("root-list").focus();
  }
});
$("download-settings").addEventListener("click", async () => {
  try {
    const browser = /Edg\//.test(navigator.userAgent) ? "edge" : "chrome";
    await chrome.tabs.create({ url: `${browser}://settings/downloads` });
    status("在浏览器下载设置中更改“位置”，或开启“下载前询问保存位置”。这是浏览器的全局下载设置。");
  } catch (error) { status(`无法打开下载设置：${error.message}`, true); }
});
for (const id of ["roots", "template-url", "settle-seconds", "export-format", "export-folder"]) {
  $(id).addEventListener("input", () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveConfig, 400); });
}
$("use-current").addEventListener("click", async () => {
  try {
    await permit();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    $("template-url").value = researchUrl(tab?.url || "").href;
    if (await saveConfig()) status("已保存当前页的数据库和筛选条件。切换词根时将从首页开始。");
  } catch (error) { status(error.message, true); }
});

try {
  const { seoHelper } = await chrome.storage.local.get("seoHelper");
  if (seoHelper?.config) {
    researchUrl(seoHelper.config.templateUrl);
    const groups = parseBatches(seoHelper.config.roots);
    const oldSelection = seoHelper.config.batchIndex ?? ((seoHelper.config.rangeStart ?? 1) - 1);
    const batchIndex = Math.max(0, Math.min(Number.isInteger(oldSelection) ? oldSelection : 0, groups.length - 1));
    const exportFolder = normalizeDownloadFolder(seoHelper.config.exportFolder ?? "SEO-Helper");
    state = seoHelper;
    state.templates = Array.isArray(state.templates) ? state.templates : [];
    state.rootLibrary = Array.isArray(state.rootLibrary) ? state.rootLibrary : PRESET_ROOTS;
    state.config.filterTemplateId ||= "";
    state.records ||= {};
    state.exports ||= {};
    state.config.exportFormat ||= "CSV";
    state.config.exportFolder = exportFolder;
    const legacy = state.config.batchIndex === undefined;
    state.config.batchIndex = batchIndex;
    state.config.roots = groups.map((group) => group.join(", ")).join("\n");
    delete state.config.rangeStart;
    delete state.config.rangeCount;
    if (legacy) {
      for (const job of jobs()) {
        const oldKey = researchKey(job.url);
        for (const data of [state.records, state.exports]) {
          if (data[oldKey]) { data[job.key] = data[oldKey]; delete data[oldKey]; }
        }
      }
      await persist();
    }
    for (const record of Object.values(state.records)) {
      if (record.state === "working") { record.state = "error"; record.error = "上次采集已中断，可重新开始。"; }
    }
    for (const record of Object.values(state.exports)) {
      if (record.state === "working") { record.state = "error"; record.error = "上次原生导出已中断；重试前请检查浏览器下载记录。"; }
    }
  }
} catch (error) { status(`无法恢复本机配置：${error.message}`, true); }
$("template-url").value = state.config.templateUrl;
$("template-name").value = state.templates.find((item) => item.id === state.config.filterTemplateId)?.name || "";
$("roots").value = state.config.roots;
$("root-editor").open = !state.config.roots;
$("settle-seconds").value = state.config.settleSeconds;
$("export-format").value = state.config.exportFormat;
$("export-folder").value = state.config.exportFolder;
render();
await describeFilter();
