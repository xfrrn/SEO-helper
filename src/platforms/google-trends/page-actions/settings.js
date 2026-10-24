import { SETTINGS_KEY, DEFAULT_SETTINGS, validateSettings } from "./core.js";

export async function initPageSettings() {
  const $ = id => document.getElementById(id);
  function status(text, error = false) {
    $("settings-status").textContent = text;
    $("settings-status").dataset.error = String(error);
  }
  function render(settings) {
    [$("baseline-one").value, $("baseline-two").value] = settings.baselines;
  }
  try {
    const saved = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
    const settings = validateSettings(saved ?? DEFAULT_SETTINGS);
    render(settings);
  } catch (error) { status(error.message, true); }
  $("settings-form").addEventListener("submit", async event => {
    event.preventDefault();
    const controls = [...$("settings-form").querySelectorAll("input,button")];
    for (const control of controls) control.disabled = true;
    try {
      const next = validateSettings({ baselines: [$("baseline-one").value, $("baseline-two").value] });
      await chrome.storage.local.set({ [SETTINGS_KEY]: next });
      render(next);
      status("已保存基准词。");
    } catch (error) { status(`保存失败：${error.message}`, true); }
    finally { for (const control of controls) control.disabled = false; }
  });
}
