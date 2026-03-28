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

// Large content is split into chunks so each native messaging message stays
// within Firefox's 1 MB limit.  700 KB per chunk leaves enough headroom for
// the JSON envelope and metadata fields.
const CHUNK_SIZE = 700_000;

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
    // Re-sync: if a tab was already selected, push its snapshot to the
    // (re-)connected host so the MCP cache is not stale after a restart.
    if (selectedTabId !== null) {
      browser.tabs.get(selectedTabId).then(pushTabSnapshot).catch(() => {
        selectedTabId = null;
      });
    }
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

/**
 * Send `data` as a series of tab_chunk messages (push path, no request id).
 * The receiver must know the field name to reassemble the chunks.
 */
function sendPushChunks(field, data) {
  const total = Math.max(1, Math.ceil(data.length / CHUNK_SIZE));
  for (let i = 0; i < total; i++) {
    nativePort.postMessage({
      type: "tab_chunk",
      field,
      index: i,
      total,
      data: data.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
    });
  }
}

/**
 * Reply to a request with large data sent as individual chunks followed by a
 * completion signal.  The host reassembles chunks before resolving the request.
 */
function replyChunked(id, field, data) {
  if (!nativePort) return;
  const total = Math.max(1, Math.ceil(data.length / CHUNK_SIZE));
  for (let i = 0; i < total; i++) {
    nativePort.postMessage({
      id,
      chunk: i,
      total,
      field,
      data: data.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
    });
  }
  // Final signal: empty result tells the host all chunks have been sent.
  nativePort.postMessage({ id, result: {} });
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

    const html = (htmlResults && htmlResults[0]) || "";
    const screenshotDataUrl = dataUrl || "";

    // Send lightweight metadata first, then stream content in chunks.
    nativePort.postMessage({
      type: "tab_selected_start",
      tab: { id: tab.id, url: tab.url, title: tab.title || "" },
    });

    sendPushChunks("html", html);

    if (screenshotDataUrl) {
      sendPushChunks("screenshot", screenshotDataUrl);
    }

    // Signal that the snapshot is complete and the host can commit it.
    nativePort.postMessage({ type: "tab_selected_end" });
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

// If the selected tab is closed, clear the selection and notify the native host.
browser.tabs.onRemoved.addListener((tabId) => {
  if (tabId === selectedTabId) {
    selectedTabId = null;
    if (nativePort) {
      nativePort.postMessage({ type: "tab_deselected" });
    }
    if (nativePort) {
      nativePort.postMessage({ type: "tab_deselected" });
    }
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
      // captureVisibleTab captures the active (visible) tab in the window, not
      // an arbitrary tab by id.  Only proceed when the selected tab is active;
      // otherwise the caller should use the cached snapshot from tab selection.
      if (!tab.active) {
        reply(id, { error: "Cannot capture screenshot: selected tab is not currently visible. Switch to the tab first, or use the cached snapshot captured at selection time." });
        return;
      }
      const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      replyChunked(id, "dataUrl", dataUrl);
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
      const html = results ? (results[0] || "") : "";
      replyChunked(id, "html", html);
    } catch (err) {
      reply(id, { error: err.message });
    }
    return;
  }

  reply(id, { error: `Unknown message type: ${type}` });
}

connect();

