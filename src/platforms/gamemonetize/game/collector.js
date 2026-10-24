// Also runs in the extension for batch HTML; keep this function self-contained for chrome.scripting.
export async function readGamePage(expectedUrl, html, signal) {
  try {
    const rendered = html === undefined;
    const pageUrl = rendered ? location.href : expectedUrl;
    const url = new URL(pageUrl);
    if (url.origin !== "https://gamemonetize.com" || url.username || url.password || pageUrl !== expectedUrl) {
      throw new Error("页面已切换，请回到 GameMonetize 游戏详情页重新采集。");
    }
    const page = rendered ? document : new DOMParser().parseFromString(html, "text/html");
    const button = page.querySelector('.product-feed .XMLOrJson[id^="XML-"]');
    const gameId = button?.id.match(/^XML-([1-9]\d*)$/)?.[1];
    if (!gameId) throw new Error("未找到游戏 XML 按钮，请打开游戏详情页并等待加载完成。");

    const mobileText = [...page.querySelectorAll(".dev-platform__item p")]
      .map(node => node.textContent.replace(/\s+/g, " ").trim())
      .find(text => /^Mobile Ready\s*:/i.test(text));
    const mobile = mobileText?.match(/^Mobile Ready\s*:\s*(Yes|No)$/i);
    if (mobileText && !mobile) throw new Error(`无法识别手机支持标记：${mobileText}`);
    const mobileReady = mobile ? mobile[1].toLowerCase() === "yes" : null;

    const feedUrl = new URL("/feed.php", url.origin);
    feedUrl.searchParams.set("format", "1");
    feedUrl.searchParams.set("id", gameId);
    const timeout = AbortSignal.timeout(15000);
    const response = await fetch(feedUrl.href, { credentials: "include", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (response.status === 429) return {
      error: "XML 请求被网站限流（HTTP 429），请等待后重试。",
      status: 429, retryAfter: response.headers.get("Retry-After"),
    };
    if (!response.ok) throw new Error(`XML 请求失败（HTTP ${response.status}），请在网站确认后重试。`);
    const xml = await response.text();
    const parsed = new DOMParser().parseFromString(xml, "application/xml");
    if (parsed.querySelector("parsererror") || parsed.documentElement.localName !== "rss") {
      throw new Error("网站没有返回有效的游戏 XML，请检查登录、验证或网站状态后重试。");
    }
    const items = parsed.querySelectorAll("channel > item");
    if (items.length !== 1 || items[0].querySelector("id")?.textContent.trim() !== gameId) {
      throw new Error("XML 中的游戏 ID 与当前页面不一致，请重新采集。");
    }
    const title = items[0].querySelector("title")?.textContent.trim();
    if (!title) throw new Error("游戏 XML 缺少标题，请在网站确认后重试。");
    if (rendered && (location.href !== pageUrl || document.querySelector('.product-feed .XMLOrJson[id^="XML-"]')?.id !== button.id)) {
      throw new Error("采集期间页面已切换，请在当前游戏页面重新采集。");
    }
    return { gameId, title, pageUrl, mobileReady, xml, capturedAt: new Date().toISOString() };
  } catch (error) {
    return { error: error.name === "TimeoutError" ? "XML 请求超过 15 秒，请检查网络后重试。" : error.message };
  }
}
