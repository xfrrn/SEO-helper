// A tab-specific analysis panel must not interrupt another panel's running work.
export function panelActivity() {
  let busy = false;
  let port;
  let windowId;
  let closed = false;
  const publish = () => port?.postMessage({ windowId, busy });
  function connect() {
    if (closed) return;
    port = chrome.runtime.connect({ name: "seoHelper:panel-activity" });
    port.onDisconnect.addListener(() => { port = null; if (!closed) connect(); });
    publish();
  }
  chrome.windows.getCurrent().then(window => { windowId = window.id; connect(); })
    .catch(error => console.error("无法登记侧栏任务状态：", error));
  addEventListener("pagehide", () => { closed = true; port?.disconnect(); });
  return value => { busy = value; publish(); };
}
