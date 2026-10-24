import { COMPARE_STORAGE_KEY } from "../explore.js";
import { STORAGE_KEY, PROVIDERS, normalizeKeyword, analysisTarget } from "./core.js";
import { initPageSettings } from "../page-actions/settings.js";
import { requestKey } from "../page-actions/core.js";
import { panelActivity } from "../../../shared/panel-activity.js";

const $ = (id) => document.getElementById(id);
const reportActivity = panelActivity();
let state = { keyword: "", provider: "google" };
let target;
let busy = true;
let restored = false;

function status(message, error = false, visible = error) {
  $("status").textContent = message;
  $("status").dataset.error = String(error);
  $("status").parentElement.hidden = !visible;
}

function setBusy(value) {
  reportActivity(value);
  busy = value;
  for (const id of ["keyword", "analyze", "reload", "copy-keyword"]) $(id).disabled = value;
  $("feature-home").disabled = value && restored;
  $("feature-compare").setAttribute("aria-disabled", String(value && restored));
  for (const button of $("providers").children) button.disabled = value;
}

function selectProvider() {
  for (const button of $("providers").children) {
    const active = button.dataset.provider === state.provider;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  }
  $("analysis-result").setAttribute("aria-labelledby", `provider-${state.provider}`);
}

function renderResult() {
  $("result-frame").replaceChildren();
  $("analysis-form").hidden = Boolean(target);
  $("result-toolbar").hidden = !target;
  $("external-result").hidden = !target || Boolean(target.frameUrl);
  if (!target) return;
  $("open-result").href = target.url;
  $("reload").hidden = !target.frameUrl;
  const trends = state.provider === "time" || state.provider === "geo";
  if (!target.frameUrl) return;
  const frame = document.createElement("iframe");
  frame.title = `${target.title}：${target.keyword}`;
  frame.referrerPolicy = "no-referrer";
  // The official chart's own links open classic Explore. Disable its popups;
  // our visible jump link above always opens /explore instead.
  frame.setAttribute("sandbox", `allow-scripts allow-same-origin allow-forms${trends ? "" : " allow-popups allow-popups-to-escape-sandbox"}`);
  frame.src = target.frameUrl;
  $("result-frame").append(frame);
}

async function run(action) {
  if (busy) return;
  const focus = document.activeElement;
  setBusy(true);
  try { await action(); }
  catch (error) { status(error.message, true); }
  finally {
    setBusy(false);
    if (document.activeElement === document.body && focus?.isConnected) focus.focus();
  }
}

async function save(next) {
  try { await chrome.storage.local.set({ [STORAGE_KEY]: next }); }
  catch { throw new Error("保存失败，输入内容已保留，请重试。"); }
  state = next;
}

function analyze(provider = state.provider) {
  return run(async () => {
    const keyword = normalizeKeyword($("keyword").value);
    const saved = (await chrome.storage.local.get(COMPARE_STORAGE_KEY))[COMPARE_STORAGE_KEY];
    const nextTarget = analysisTarget(provider, keyword, { date: saved?.date ?? "today 1-m", geo: saved?.geo ?? "" });
    await save({ keyword, provider });
    $("keyword").value = keyword;
    target = nextTarget;
    selectProvider();
    renderResult();
    status(`当前查询：${keyword} · ${target.title}`);
  });
}

for (const { id, label, title } of PROVIDERS) {
  const button = document.createElement("button");
  button.id = `provider-${id}`;
  button.type = "button";
  button.dataset.provider = id;
  button.textContent = label;
  button.title = title;
  button.setAttribute("role", "tab");
  button.setAttribute("aria-controls", "analysis-result");
  button.addEventListener("click", () => {
    if ($("keyword").value.trim()) { analyze(id); return; }
    run(async () => {
      await save({ keyword: "", provider: id });
      target = null;
      selectProvider();
      renderResult();
      status("输入关键词后点击“分析”。");
    });
  });
  $("providers").append(button);
}
$("providers").addEventListener("keydown", (event) => {
  const buttons = [...$("providers").children];
  const index = buttons.indexOf(event.target);
  if (index < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
    : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next].focus(); // Manual tab activation: Enter/Space loads the chosen source.
});
$("analysis-form").addEventListener("submit", (event) => { event.preventDefault(); analyze(); });
$("reload").addEventListener("click", () => analyze());
$("copy-keyword").addEventListener("click", () => run(async () => {
  try { await navigator.clipboard.writeText(target.keyword); }
  catch { throw new Error(`复制失败，请点击“跳转”后手动输入：${target.keyword}`); }
  status("关键词已复制，点击“跳转”到 Ahrefs 粘贴查询。", false, true);
}));

function navigate(url) {
  if (!restored) { location.href = url; return; }
  run(async () => {
    const keyword = $("keyword").value.trim() ? normalizeKeyword($("keyword").value) : "";
    await save({ ...state, keyword });
    location.href = url;
  });
}
$("feature-home").addEventListener("click", () => navigate(chrome.runtime.getURL("src/app/sidepanel.html")));
$("feature-compare").addEventListener("click", (event) => { event.preventDefault(); navigate(event.currentTarget.href); });

try {
  const saved = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (saved) {
    if (!PROVIDERS.some(({ id }) => id === saved.provider)) throw new Error("保存的分析方式无效。");
    state = { keyword: saved.keyword === "" ? "" : normalizeKeyword(saved.keyword), provider: saved.provider };
  }
  restored = true;
  status("输入关键词后点击“分析”；只有选中的来源会接收关键词。");
} catch (error) { status(`无法恢复设置，请重新打开侧栏后重试：${error.message}`, true); }
$("keyword").value = state.keyword;
selectProvider();
setBusy(!restored);
await initPageSettings();

const params = new URLSearchParams(location.search);
const windowId = Number(params.get("windowId"));
const requestId = params.get("request");
let consuming = false;
async function consumeRequest() {
  if (!restored || busy || consuming || !Number.isInteger(windowId) || !requestId) return;
  consuming = true;
  try {
    const key = requestKey(windowId);
    const request = (await chrome.storage.session.get(key))[key];
    if (request?.id !== requestId) return;
    $("keyword").value = normalizeKeyword(request.keyword);
    await analyze("google");
    // Consume even on display errors: reopening must not silently resend a query.
    const current = (await chrome.storage.session.get(key))[key];
    if (current?.id === requestId) await chrome.storage.session.remove(key);
  } catch (error) { status(error.message, true); }
  finally { consuming = false; }
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes[requestKey(windowId)]) consumeRequest();
});
await consumeRequest();
