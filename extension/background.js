/**
 * background.js – persistent background script for the tab-mcp extension.
 *
 * The toolbar button lets the user choose which tab is exposed:
 *   • Clicking the button on an unexposed tab  → selects it (icon turns green)
 *   • Clicking the button on the already-exposed tab → deselects it (icon turns blue)
 *
 * The native messaging host receives a "tab_selected" notification whenever the
 * selection changes so the MCP server can proactively push fresh data.
 *
 * MCP tool requests handled from the native host:
 *   get_title      – title of the selected tab
 *   get_screenshot – PNG data-URL of the selected tab
 *   get_html       – full outer-HTML of the selected tab
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {number|null} Tab ID currently exposed via MCP (null = none selected). */
let selectedTabId = null;

// ---------------------------------------------------------------------------
// Native messaging
// ---------------------------------------------------------------------------

let nativePort = null;

function connect() {
  try {
    nativePort = browser.runtime.connectNative("tab_mcp_host");
    nativePort.onMessage.addListener(handleNativeMessage);
    nativePort.onDisconnect.addListener(() => {
      nativePort = null;
      setTimeout(connect, 3000);
    });
  } catch (err) {
    console.error("tab-mcp: failed to connect to native host", err);
    setTimeout(connect, 5000);
  }
}

function reply(id, result) {
  if (nativePort) {
    nativePort.postMessage({ id, result });
  }
}

// ---------------------------------------------------------------------------
// Toolbar button
// ---------------------------------------------------------------------------

const ICON_INACTIVE = {
  16: "icons/icon-16.png",
  48: "icons/icon-48.png",
  96: "icons/icon-96.png",
};
const ICON_ACTIVE = {
  16: "icons/icon-16-active.png",
  48: "icons/icon-48-active.png",
  96: "icons/icon-96-active.png",
};

/** Set the toolbar icon + badge for a specific tab. */
function setButtonState(tabId, isSelected) {
  browser.browserAction.setIcon({
    tabId,
    path: isSelected ? ICON_ACTIVE : ICON_INACTIVE,
  });
  browser.browserAction.setBadgeText({
    tabId,
    text: isSelected ? "ON" : "",
  });
  if (isSelected) {
    browser.browserAction.setBadgeBackgroundColor({ tabId, color: "#22c55e" });
  }
  browser.browserAction.setTitle({
    tabId,
    title: isSelected
      ? "tab-mcp: this tab is exposed — click to deselect"
      : "tab-mcp: click to expose this tab",
  });
}

/** Push a snapshot of the selected tab to the native host asynchronously. */
async function pushTabSnapshot(tab) {
  if (!nativePort) return;
  try {
    const [htmlResults, dataUrl] = await Promise.all([
      browser.tabs.executeScript(tab.id, {
        code: "document.documentElement.outerHTML",
      }).catch(() => [""]),
      browser.tabs.captureVisibleTab(tab.windowId, { format: "png" }).catch(() => null),
    ]);
    nativePort.postMessage({
      type: "tab_selected",
      tab: {
        id: tab.id,
        url: tab.url,
        title: tab.title || "",
        html: (htmlResults && htmlResults[0]) || "",
        screenshotDataUrl: dataUrl || null,
      },
    });
  } catch (err) {
    console.error("tab-mcp: failed to push snapshot", err);
  }
}

/** Handle toolbar button click. */
browser.browserAction.onClicked.addListener(async (clickedTab) => {
  const prevId = selectedTabId;

  if (selectedTabId === clickedTab.id) {
    // Deselect
    selectedTabId = null;
    setButtonState(clickedTab.id, false);
    if (nativePort) {
      nativePort.postMessage({ type: "tab_deselected" });
    }
    return;
  }

  // Deselect previous tab's button state (if it still exists)
  if (prevId !== null) {
    browser.tabs.get(prevId).then(() => setButtonState(prevId, false)).catch(() => {});
  }

  selectedTabId = clickedTab.id;
  setButtonState(clickedTab.id, true);

  await pushTabSnapshot(clickedTab);
});

// If the selected tab is closed or navigates, clear the selection.
browser.tabs.onRemoved.addListener((tabId) => {
  if (tabId === selectedTabId) {
    selectedTabId = null;
  }
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === selectedTabId && changeInfo.status === "loading") {
    // Tab navigated – update the native host with blank data while loading.
    if (nativePort) {
      nativePort.postMessage({ type: "tab_navigating", tabId });
    }
  }
});

// ---------------------------------------------------------------------------
// MCP tool handlers (requests coming from the native host)
// ---------------------------------------------------------------------------

async function getSelectedTab() {
  if (selectedTabId === null) return null;
  try {
    return await browser.tabs.get(selectedTabId);
  } catch {
    selectedTabId = null;
    return null;
  }
}

async function handleNativeMessage(message) {
  const { id, type } = message;

  if (type === "get_title") {
    const tab = await getSelectedTab();
    if (!tab) {
      reply(id, { error: "No tab selected. Click the tab-mcp toolbar button to expose a tab." });
      return;
    }
    reply(id, { title: tab.title || "" });
    return;
  }

  if (type === "get_screenshot") {
    const tab = await getSelectedTab();
    if (!tab) {
      reply(id, { error: "No tab selected. Click the tab-mcp toolbar button to expose a tab." });
      return;
    }
    try {
      const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      reply(id, { dataUrl });
    } catch (err) {
      reply(id, { error: err.message });
    }
    return;
  }

  if (type === "get_html") {
    const tab = await getSelectedTab();
    if (!tab) {
      reply(id, { error: "No tab selected. Click the tab-mcp toolbar button to expose a tab." });
      return;
    }
    try {
      const results = await browser.tabs.executeScript(tab.id, {
        code: "document.documentElement.outerHTML",
      });
      reply(id, { html: results ? (results[0] || "") : "" });
    } catch (err) {
      reply(id, { error: err.message });
    }
    return;
  }

  reply(id, { error: `Unknown message type: ${type}` });
}

connect();

