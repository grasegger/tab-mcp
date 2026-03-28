/**
 * background.js – persistent background script for the tab-mcp extension.
 *
 * Connects to the native messaging host (tab_mcp_host) and handles requests
 * forwarded from the MCP server:
 *   get_title      – active tab title
 *   get_screenshot – PNG data-URL of the visible tab
 *   get_html       – full outer-HTML of the active tab
 */

let nativePort = null;

function connect() {
  try {
    nativePort = browser.runtime.connectNative("tab_mcp_host");
    nativePort.onMessage.addListener(handleNativeMessage);
    nativePort.onDisconnect.addListener(() => {
      nativePort = null;
      // Reconnect after a short delay so the MCP server stays reachable.
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

async function handleNativeMessage(message) {
  const { id, type } = message;

  if (type === "get_title") {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    reply(id, { title: tab ? (tab.title || "") : "" });
    return;
  }

  if (type === "get_screenshot") {
    try {
      const dataUrl = await browser.tabs.captureVisibleTab(null, { format: "png" });
      reply(id, { dataUrl });
    } catch (err) {
      reply(id, { error: err.message });
    }
    return;
  }

  if (type === "get_html") {
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (!tab) {
        reply(id, { html: "" });
        return;
      }
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
