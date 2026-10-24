import "../platforms/google-trends/page-actions/background.js";

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("无法启用侧边栏：", error));
