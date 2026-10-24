import { STORAGE_KEY, TRENDS_ORIGIN, DEFAULT_CONFIG, parseGroups, compareUrl, findTrendsTab, openComparison } from "./core.js";
import { panelActivity } from "../../../shared/panel-activity.js";

const $ = (id) => document.getElementById(id);
const reportActivity = panelActivity();
let config = { ...DEFAULT_CONFIG };
let busy = true;
let restored = false;
const year = new Date().getFullYear();
for (const value of [year, year - 1]) {
  $("date").add(new Option(`${value}年`, `${value}-01-01 ${value}-12-31`), $("custom-option"));
}

function status(message, error = false) {
  $("status").textContent = message;
  $("status").dataset.error = String(error);
}

function setBusy(value) {
  reportActivity(value);
  busy = value;
  $("controls").disabled = value;
  $("feature-home").disabled = value;
  $("feature-analysis").setAttribute("aria-disabled", String(value));
}

function selectValue(id, value) {
  const select = $(id);
  if (id === "date") {
    const known = [...select.options].some((option) => option.value === value);
    select.value = known ? value : "custom";
    $("custom-date").hidden = known;
    if (!known) [$("date-start").value, $("date-end").value] = value.split(" ");
    return;
  }
  if (![...select.options].some((option) => option.value === value)) select.add(new Option(`页面设置：${value}`, value));
  select.value = value;
}

function render() {
  const groups = parseGroups(config.groups);
  $("group-count").textContent = `${groups.length} 组 · ${groups.flat().length} 词`;
  $("empty").hidden = groups.length > 0;
  $("group-list").replaceChildren(...groups.map((words, index) => {
    const row = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "group";
    button.setAttribute("aria-pressed", String(index === config.selectedIndex));
    button.title = `在新版 Google Trends 对比第 ${index + 1} 组`;
    const number = document.createElement("span");
    number.className = "group-number";
    number.textContent = `${index + 1}.`;
    const label = document.createElement("span");
    label.className = "group-words";
    label.textContent = words.join(", ");
    button.append(number, label);
    button.addEventListener("click", () => compare(index, words));
    row.append(button);
    return row;
  }));
}

function validate(value) {
  const groups = parseGroups(value.groups);
  compareUrl(["validation"], value);
  const selectedIndex = Number.isInteger(value.selectedIndex) && value.selectedIndex >= 0 && value.selectedIndex < groups.length
    ? value.selectedIndex : -1;
  return { groups: groups.map((words) => words.join(", ")).join("\n"), date: value.date, geo: value.geo, selectedIndex };
}

function readDate() {
  return $("date").value === "custom" ? `${$("date-start").value} ${$("date-end").value}` : $("date").value;
}

function readConfig() {
  const next = validate({ ...config, groups: $("groups").value, date: readDate(), geo: $("geo").value });
  if (next.groups !== config.groups || next.date !== config.date || next.geo !== config.geo) next.selectedIndex = -1;
  return next;
}

async function save(next) {
  try { await chrome.storage.local.set({ [STORAGE_KEY]: next }); }
  catch { throw new Error("分组或设置保存失败，请保留编辑内容后重试。"); }
  config = next;
  render();
}

async function run(action) {
  if (busy) return;
  setBusy(true);
  try { await action(); }
  catch (error) { status(error.message, true); }
  finally { setBusy(false); }
}

async function checkPageAccess() {
  if (!await chrome.permissions.contains({ origins: [`${TRENDS_ORIGIN}/*`] })) {
    throw new Error("请在扩展管理页允许 SEO Helper 访问 Google Trends。");
  }
}

function compare(index, words) {
  return run(async () => {
    const next = readConfig();
    if (next.groups !== config.groups) throw new Error("请先保存编辑的分组，再点击词组开始对比。");
    await checkPageAccess();
    await save({ ...next, selectedIndex: index });
    status(`正在打开第 ${index + 1} 组…`);
    await openComparison(words, config);
    status(`已将第 ${index + 1} 组 ${words.length} 个词交给新版探索页，等待网站加载。`);
  });
}

$("save-groups").addEventListener("click", () => run(async () => {
  await save(readConfig());
  $("groups").value = config.groups;
  $("group-editor").open = !config.groups;
  status("分组已保存，点击任意一组开始对比。");
}));

function saveSettings() {
  return run(async () => {
    await save(validate({ ...config, date: readDate(), geo: $("geo").value, selectedIndex: -1 }));
    status("设置已保存，下次点击词组时应用。");
  });
}

for (const id of ["date", "geo"]) {
  $(id).addEventListener("change", () => {
    if (id === "date") {
      $("custom-date").hidden = $("date").value !== "custom";
      if ($("date").value === "custom") {
        status("选择开始和结束日期后，点击“应用日期”。");
        $("date-start").focus();
        return;
      }
    }
    saveSettings();
  });
}
$("apply-date").addEventListener("click", saveSettings);

$("use-current").addEventListener("click", () => run(async () => {
  await checkPageAccess();
  const tab = await findTrendsTab();
  if (!tab) throw new Error("请先在当前窗口打开 Google Trends 页面。");
  const url = new URL(tab.pendingUrl || tab.url);
  const next = validate({ ...config, date: url.searchParams.get("date") || "today 12-m", geo: url.searchParams.get("geo") || "", selectedIndex: -1 });
  await save(next);
  selectValue("date", config.date);
  selectValue("geo", config.geo);
  status("已读取 Trends 页面时间与地区，点击词组即可应用。");
}));

function navigate(url) {
  if (busy && restored) return;
  if (!restored) { location.href = url; return; }
  run(async () => {
    await save(readConfig());
    location.href = url;
  });
}
$("feature-home").addEventListener("click", () => navigate(chrome.runtime.getURL("src/app/sidepanel.html")));
$("feature-analysis").addEventListener("click", (event) => {
  event.preventDefault();
  navigate(event.currentTarget.href);
});

try {
  const saved = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (saved) config = validate({ ...DEFAULT_CONFIG, ...saved });
  restored = true;
} catch (error) { status(`无法恢复分组，请重新打开侧栏后重试：${error.message}`, true); }
$("groups").value = config.groups;
$("group-editor").open = !config.groups;
selectValue("date", config.date);
selectValue("geo", config.geo);
render();
setBusy(!restored);
$("feature-home").disabled = false;
$("feature-analysis").setAttribute("aria-disabled", "false");
