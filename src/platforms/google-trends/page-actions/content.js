(() => {
  const existing = globalThis.seoHelperTrendsActions;
  if (existing) { existing.refresh(); return; }
  if (window !== top || !/^\/(?:trends\/)?explore\/?$/.test(location.pathname)) return;
  let stopped = false;
  let scheduled = false;
  let translating = false;
  let translationFailed = false;
  const translations = new Map();
  const decorated = new Map();
  const host = document.createElement("div");
  host.dataset.seoHelper = "trends-actions";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>
    :host{all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;font:13px/1.4 Arial,sans-serif;color:#19252c}
    #actions{position:absolute;display:flex;gap:4px;padding:4px;background:#fff;border:1px solid #bdcac0;border-radius:5px;pointer-events:auto;box-shadow:0 2px 8px #0002}
    button{font:inherit;min-height:28px;padding:3px 9px;border:1px solid #bdcac0;border-radius:4px;background:#fff;color:#275f40;cursor:pointer;white-space:nowrap}
    button:hover{background:#edf3ed}button:focus-visible{outline:2px solid #275f40;outline-offset:1px}button:disabled{opacity:.5;cursor:default}
    #notice{position:absolute;bottom:16px;left:16px;max-width:min(420px,calc(100vw - 32px));padding:10px 12px;background:white;border:1px solid #bdcac0;border-radius:5px;pointer-events:auto;box-shadow:0 2px 8px #0002}
    #notice[data-error=true]{color:#a12f29}#notice button{margin-left:8px}[hidden]{display:none!important}
  </style><div id="actions" role="group" aria-label="关键词快捷操作" hidden><button data-action="copy">复制</button><button data-action="compare">对比</button><button data-action="analyze">分析</button></div>
  <div id="notice" role="status" hidden><span></span><button id="retry-translation" hidden>重试翻译</button><button id="dismiss" aria-label="关闭提示">关闭</button></div>`;
  const actions = shadow.getElementById("actions");
  const notice = shadow.getElementById("notice");
  let active;
  document.documentElement.append(host);

  function notify(text, error = false, retry = false) {
    notice.querySelector("span").textContent = text;
    notice.dataset.error = String(error);
    shadow.getElementById("retry-translation").hidden = !retry;
    notice.hidden = false;
  }
  shadow.getElementById("dismiss").onclick = () => { notice.hidden = true; };

  function queryContainers() {
    const containers = new Set(document.querySelectorAll('trends-widget[widget-name="RELATED_QUERIES"], [data-query-list], related-queries'));
    // New Explore uses a rank column followed by the query, without an Explore link.
    for (const table of document.querySelectorAll("table")) {
      const headings = [...table.querySelectorAll("th")].map(node => node.textContent.trim());
      if (headings.some(text => /^(查询|Query|Search term)$/i.test(text)) && headings.some(text => /搜索热度|Search interest/i.test(text))) containers.add(table);
    }
    for (const heading of document.querySelectorAll('h2,h3,[role="heading"],.fe-atoms-generic-title')) {
      if (!/^(热门查询|热度上升的查询|相关查询|Top queries|Rising queries|Related queries|What people searched for)$/i.test(heading.textContent.trim())) continue;
      let parent = heading.parentElement;
      for (let depth = 0; parent && depth < 6; depth++, parent = parent.parentElement) {
        if (parent.querySelector('a[href*="explore?q"],a[href*="explore?"],tr,[data-query],[data-keyword]')) { containers.add(parent); break; }
      }
    }
    return containers;
  }

  function originalText(node) {
    const copy = node.cloneNode(true);
    for (const translation of copy.querySelectorAll("[data-seo-helper-translation]")) translation.remove();
    return copy.textContent.trim();
  }

  function entries() {
    const result = [];
    for (const container of queryContainers()) {
      if (container.closest('trends-widget[widget-name="RELATED_TOPICS"],[data-topic-list]')) continue;
      for (const node of container.querySelectorAll('a[href*="explore"], [data-query], [data-keyword], tr')) {
        if (node.closest('[role="menu"],.item-menu') || node.getAttribute("role") === "menuitem") continue;
        let keyword;
        let text;
        if (node.matches("a")) {
          let url;
          try { url = new URL(node.href, location.href); }
          catch { continue; }
          if (url.origin !== location.origin) continue;
          keyword = url.searchParams.get("q");
          text = node.querySelector('.label-text,[data-query-text],.query-text') || node;
        } else {
          text = node.querySelector('[data-query-text],.query-text,td:nth-child(2),[role="cell"]:nth-child(2)');
          keyword = node.dataset.query || node.dataset.keyword || (text && originalText(text.querySelector("div > span") || text));
        }
        if (!keyword || /^(\/m\/|\/g\/)/.test(keyword) || keyword.includes(",") || !text || !node.getClientRects().length) continue;
        // Prefer the rendered keyword; URL data only disambiguates rank and heat labels.
        const displayed = originalText(text.querySelector('[ng-bind="bidiText"]') || text);
        if (!displayed.includes(keyword) && displayed !== keyword) continue;
        if (result.some(entry => entry.node.contains(node) || node.contains(entry.node))) continue;
        result.push({ node, text, keyword });
      }
    }
    return result;
  }

  function show(entry) {
    if (stopped) return;
    active = entry;
    actions.hidden = false;
    const rect = entry.node.getBoundingClientRect();
    const width = actions.getBoundingClientRect().width;
    const height = actions.getBoundingClientRect().height;
    actions.style.left = `${Math.max(4, Math.min(rect.right - width, innerWidth - width - 4))}px`;
    // Place outside the row so keywords, values and the site's menu remain readable.
    actions.style.top = `${rect.top >= height + 4 ? rect.top - height : rect.bottom}px`;
  }

  function refresh() {
    if (scheduled || stopped) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const current = entries();
      for (const [node, entry] of decorated) {
        if (!current.some(next => next.node === node && next.text === entry.text && next.keyword === entry.keyword)) {
          if (active === entry) { actions.hidden = true; active = null; }
          clearTranslation(entry);
          node.removeEventListener("pointerenter", entry.show);
          node.removeEventListener("focusin", entry.show);
          if (entry.addedTabIndex) node.removeAttribute("tabindex");
          decorated.delete(node);
        }
      }
      for (const entry of current) {
        if (decorated.has(entry.node)) continue;
        const translation = document.createElement("span");
        translation.dataset.seoHelperTranslation = "";
        translation.lang = "zh-CN";
        translation.style.cssText = "display:block;font:12px/1.4 Arial,sans-serif;color:#536559;white-space:normal;overflow-wrap:anywhere";
        const showEntry = () => show(entry);
        if (!entry.node.matches('a,button,[tabindex]')) { entry.node.tabIndex = 0; entry.addedTabIndex = true; }
        Object.assign(entry, { translation, show: showEntry });
        entry.node.addEventListener("pointerenter", showEntry);
        entry.node.addEventListener("focusin", showEntry);
        decorated.set(entry.node, entry);
        if (active?.node === entry.node) show(entry);
      }
      translateEntries();
    });
  }

  function clearTranslation(entry) {
    entry.translation.remove();
    if (!entry.originalLayout) return;
    for (const [property, value, priority] of entry.originalLayout) {
      if (value) entry.text.style.setProperty(property, value, priority);
      else entry.text.style.removeProperty(property);
    }
    entry.originalLayout = null;
  }

  function showTranslation(entry) {
    // Classic query rows inherit a fixed 63px line-height, which clips a second line.
    if (entry.text.matches(".label-text") && !entry.originalLayout) {
      const layout = { display: "flex", height: "100%", "line-height": "1.25", "flex-direction": "column", "justify-content": "center" };
      entry.originalLayout = Object.keys(layout).map(property => [property, entry.text.style.getPropertyValue(property), entry.text.style.getPropertyPriority(property)]);
      for (const [property, value] of Object.entries(layout)) entry.text.style.setProperty(property, value);
    }
    entry.text.append(entry.translation);
  }

  async function translateEntries() {
    if (translating || translationFailed || stopped) return;
    translating = true;
    try {
      for (const entry of decorated.values()) {
        if (stopped) break;
        if (!/[a-z]/i.test(entry.keyword) || /[\u3400-\u9fff]/.test(entry.keyword)) continue;
        if (!translations.has(entry.keyword)) {
          const response = await chrome.runtime.sendMessage({ type: "trends:translate", keyword: entry.keyword });
          if (!response?.ok || typeof response.translation !== "string" || !response.translation.trim()) throw new Error(response?.error || "翻译服务没有返回译文");
          translations.set(entry.keyword, response.translation);
        }
        if (stopped || decorated.get(entry.node) !== entry || !entry.node.isConnected) continue;
        entry.translation.textContent = translations.get(entry.keyword);
        if (entry.translation.textContent && !entry.translation.isConnected) showTranslation(entry);
      }
    } catch (error) {
      if (!stopped) {
        translationFailed = true;
        notify(`关键词翻译失败：${error.message}`, true, true);
      }
    }
    finally { translating = false; }
  }
  shadow.getElementById("retry-translation").onclick = () => { translationFailed = false; notice.hidden = true; translateEntries(); };

  actions.addEventListener("click", async event => {
    const button = event.target.closest("button[data-action]");
    if (!button || !active) return;
    const keyword = active.keyword;
    try {
      if (button.dataset.action === "copy") {
        await navigator.clipboard.writeText(keyword);
        notify(`已复制：${keyword}`);
      } else {
        const response = await chrome.runtime.sendMessage({ type: `trends:${button.dataset.action}`, keyword });
        if (!response?.ok) throw new Error(response?.error || "扩展未响应，请刷新页面后重试。");
        actions.hidden = true;
        notice.hidden = true;
      }
    } catch (error) { notify(`${button.dataset.action === "copy" ? "复制失败：" : ""}${error.message}`, true); }
  });
  function hide(event) {
    if (host.contains(event.target) || active?.node.contains(event.target)) return;
    if (event.type === "pointermove" && active && !actions.hidden) {
      const row = active.node.getBoundingClientRect();
      const toolbar = actions.getBoundingClientRect();
      if (event.clientX >= Math.min(row.left, toolbar.left) && event.clientX <= Math.max(row.right, toolbar.right)
        && event.clientY >= Math.min(row.top, toolbar.top) && event.clientY <= Math.max(row.bottom, toolbar.bottom)) return;
    }
    actions.hidden = true;
  }
  function scroll() { if (active && !actions.hidden) show(active); }
  document.addEventListener("pointermove", hide);
  document.addEventListener("focusin", hide);
  document.addEventListener("scroll", scroll, true);
  function escape(event) { if (event.key === "Escape") { active?.node.focus(); actions.hidden = true; } }
  document.addEventListener("keydown", escape);
  // Tab from a query goes to its toolbar, which lives in an isolated shadow root.
  function keyboard(event) {
    if (event.key === "Tab" && !event.shiftKey && active?.node.contains(event.target) && !actions.hidden) {
      event.preventDefault(); actions.querySelector("button").focus();
    }
  }
  document.addEventListener("keydown", keyboard);
  actions.addEventListener("keydown", event => {
    const buttons = [...actions.querySelectorAll("button")];
    if (event.key !== "Tab" || !active || (event.shiftKey ? event.target !== buttons[0] : event.target !== buttons.at(-1))) return;
    const focusable = [...document.querySelectorAll('a[href],button,input,[tabindex]')].filter(node => node.tabIndex >= 0 && !node.disabled && node.getClientRects().length);
    const next = event.shiftKey ? active.node : focusable[focusable.indexOf(active.node) + 1];
    if (next) { event.preventDefault(); next.focus(); }
  });
  function cleanup() {
    stopped = true;
    observer.disconnect();
    host.remove();
    for (const entry of decorated.values()) {
      clearTranslation(entry);
      entry.node.removeEventListener("pointerenter", entry.show);
      entry.node.removeEventListener("focusin", entry.show);
      if (entry.addedTabIndex) entry.node.removeAttribute("tabindex");
    }
    document.removeEventListener("pointermove", hide);
    document.removeEventListener("focusin", hide);
    document.removeEventListener("scroll", scroll, true);
    document.removeEventListener("keydown", escape);
    document.removeEventListener("keydown", keyboard);
    chrome.runtime.onMessage.removeListener(message);
    delete globalThis.seoHelperTrendsActions;
  }
  function message(value) { if (value?.type === "trends:cleanup") cleanup(); }
  const observer = new MutationObserver(records => {
    if (records.some(record => !host.contains(record.target) && !record.target.closest?.('[data-seo-helper-translation]'))) refresh();
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  chrome.runtime.onMessage.addListener(message);
  globalThis.seoHelperTrendsActions = { refresh() { translationFailed = false; refresh(); } };
  refresh();
})();
