/**
 * index.js – tab-mcp native messaging host
 *
 * This process is launched by Firefox whenever the background script calls
 * browser.runtime.connectNative("tab_mcp_host").
 *
 * It does two things in parallel:
 *   1. Speaks the native-messaging wire protocol (4-byte LE length-prefix + JSON)
 *      on stdin/stdout so the extension can send tab data back.
 *   2. Runs an HTTP MCP server (Streamable-HTTP transport) on localhost:${PORT}
 *      so AI agents can connect and call the read-only tools:
 *        • get_title      – title of the tab selected by the user via the toolbar button
 *        • get_screenshot – base64-encoded PNG screenshot of the selected tab
 *        • get_html       – full outer-HTML of the selected tab
 *
 * When the user clicks the toolbar button, the extension sends a multi-message
 * chunked snapshot (tab_selected_start → tab_chunk… → tab_selected_end) with
 * the title, HTML, and screenshot.  This host reassembles the chunks and caches
 * the snapshot so MCP tools can serve it instantly.
 */

import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_PORT = 3712;

function getPortFromEnv() {
  const raw = process.env.TAB_MCP_PORT;
  if (!raw) return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    process.stderr.write(
      `[tab-mcp] Invalid TAB_MCP_PORT value "${raw}". Falling back to default port ${DEFAULT_PORT}.\n`
    );
    return DEFAULT_PORT;
  }
  return parsed;
}

const PORT = getPortFromEnv();

// ---------------------------------------------------------------------------
// Native-messaging bridge (stdin / stdout)
// ---------------------------------------------------------------------------

let msgBuffer = Buffer.alloc(0);
let nextId = 0;
/** @type {Map<number, { resolve: (v: any) => void, timer: ReturnType<typeof setTimeout> }>} */
const pending = new Map();

/**
 * Cached snapshot pushed by the extension when the user clicks the toolbar
 * button.  null = no tab selected yet.
 * @type {{ id: number, url: string, title: string, html: string, screenshotDataUrl: string|null }|null}
 */
let cachedTab = null;

// State for assembling the multi-message push snapshot (tab_selected_start/
// tab_chunk/tab_selected_end).
let pendingPushTab = null;
let pendingPushChunks = {};

// State for assembling chunked replies to live requests keyed by request id.
// Maps id → { field: string, chunks: string[] }
const pendingReplyChunks = new Map();

// Firefox writes binary to stdin; set it to read raw buffers.
process.stdin.resume();

process.stdin.on("data", (chunk) => {
  msgBuffer = Buffer.concat([msgBuffer, chunk]);
  drain();
});

process.stdin.on("end", () => {
  process.exit(0);
});

function drain() {
  while (msgBuffer.length >= 4) {
    const len = msgBuffer.readUInt32LE(0);
    if (msgBuffer.length < 4 + len) break;
    const json = msgBuffer.slice(4, 4 + len).toString("utf8");
    msgBuffer = msgBuffer.slice(4 + len);
    try {
      handleFromExtension(JSON.parse(json));
    } catch {
      // ignore malformed messages
    }
  }
}

function sendToExtension(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function handleFromExtension(msg) {
  // ---------------------------------------------------------------------------
  // Push protocol (no request id): tab_selected_start → tab_chunk… → tab_selected_end
  // ---------------------------------------------------------------------------
  if (msg.type === "tab_selected_start") {
    pendingPushTab = msg.tab;
    pendingPushChunks = {};
    return;
  }

  if (msg.type === "tab_chunk") {
    if (!pendingPushTab) {
      process.stderr.write("[tab-mcp] warning: received tab_chunk without tab_selected_start – ignoring\n");
      return; // unexpected chunk – ignore
    }
    const { field, index, total, data } = msg;
    if (!pendingPushChunks[field]) {
      pendingPushChunks[field] = new Array(total).fill("");
    }
    pendingPushChunks[field][index] = data;
    return;
  }

  if (msg.type === "tab_selected_end") {
    if (pendingPushTab) {
      cachedTab = {
        ...pendingPushTab,
        html: (pendingPushChunks.html || []).join(""),
        screenshotDataUrl: (() => {
          const s = pendingPushChunks.screenshot
            ? pendingPushChunks.screenshot.join("")
            : "";
          return s.length > 0 ? s : null;
        })(),
      };
      process.stderr.write(`[tab-mcp] tab selected: "${cachedTab.title}" (id=${cachedTab.id})\n`);
      pendingPushTab = null;
      pendingPushChunks = {};
    }
    return;
  }

  if (msg.type === "tab_deselected" || msg.type === "tab_navigating") {
    cachedTab = null;
    pendingPushTab = null;
    pendingPushChunks = {};
    process.stderr.write(`[tab-mcp] tab ${msg.type}\n`);
    return;
  }

  // ---------------------------------------------------------------------------
  // Reply protocol: chunked data then a completion signal { id, result: {} }
  // ---------------------------------------------------------------------------

  // Accumulate a data chunk for an in-flight request reply.
  if (msg.chunk !== undefined && msg.id !== undefined) {
    const { id, chunk, total, field, data } = msg;
    if (!pendingReplyChunks.has(id)) {
      pendingReplyChunks.set(id, { field, chunks: new Array(total).fill("") });
    }
    pendingReplyChunks.get(id).chunks[chunk] = data;
    return;
  }

  // Final reply signal: resolve the pending request, assembling any chunks.
  if (msg.id !== undefined && msg.result !== undefined) {
    const entry = pending.get(msg.id);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(msg.id);
      let result = msg.result;
      const replyChunks = pendingReplyChunks.get(msg.id);
      if (replyChunks) {
        result = { ...result, [replyChunks.field]: replyChunks.chunks.join("") };
        pendingReplyChunks.delete(msg.id);
      }
      entry.resolve(result);
    }
  }
}

/**
 * Ask the extension to perform `type` live and return the result.
 * Used as a fallback when no cached snapshot is available yet.
 * @param {"get_title"|"get_screenshot"|"get_html"} type
 * @returns {Promise<Record<string, any>>}
 */
function askExtension(type) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      pendingReplyChunks.delete(id);
      reject(new Error(`tab-mcp: request '${type}' timed out`));
    }, 15_000);
    pending.set(id, { resolve, timer });
    sendToExtension({ id, type });
  });
}

// ---------------------------------------------------------------------------
// MCP server definition
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "get_title",
    description:
      "Return the title of the browser tab currently exposed via the tab-mcp toolbar button.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_screenshot",
    description:
      "Capture a screenshot of the browser tab currently exposed via the tab-mcp toolbar button and return it as a base64-encoded PNG image.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_html",
    description:
      "Return the full outer-HTML of the browser tab currently exposed via the tab-mcp toolbar button.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

function createMcpServer() {
  const server = new Server(
    { name: "tab-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name } = req.params;

    if (name === "get_title") {
      // Use cached snapshot if available, otherwise ask live.
      if (cachedTab) {
        return { content: [{ type: "text", text: cachedTab.title }] };
      }
      const result = await askExtension("get_title");
      if (result.error) throw new Error(result.error);
      return { content: [{ type: "text", text: result.title ?? "" }] };
    }

    if (name === "get_screenshot") {
      if (cachedTab && cachedTab.screenshotDataUrl) {
        const base64 = cachedTab.screenshotDataUrl.replace(
          /^data:image\/\w+;base64,/,
          ""
        );
        return { content: [{ type: "image", data: base64, mimeType: "image/png" }] };
      }
      const result = await askExtension("get_screenshot");
      if (result.error) throw new Error(result.error);
      const base64 = result.dataUrl.replace(/^data:image\/\w+;base64,/, "");
      return { content: [{ type: "image", data: base64, mimeType: "image/png" }] };
    }

    if (name === "get_html") {
      if (cachedTab) {
        return { content: [{ type: "text", text: cachedTab.html }] };
      }
      const result = await askExtension("get_html");
      if (result.error) throw new Error(result.error);
      return { content: [{ type: "text", text: result.html ?? "" }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  return server;
}

// ---------------------------------------------------------------------------
// HTTP server (one stateless transport per request – simplest approach)
// ---------------------------------------------------------------------------

const app = express();

// CORS: only allow explicitly configured origins.
// Set TAB_MCP_ALLOWED_ORIGINS to a comma-separated list of allowed origins.
// If the variable is unset or empty, no CORS headers are sent (browser
// cross-origin requests will be blocked, which is the safe default).
const allowedOriginsEnv = process.env.TAB_MCP_ALLOWED_ORIGINS;
const allowedOrigins = allowedOriginsEnv
  ? allowedOriginsEnv.split(",").map((o) => o.trim()).filter(Boolean)
  : [];

if (allowedOrigins.length > 0) {
  app.use(
    cors({
      origin(origin, callback) {
        // Only allow explicitly configured origins. Requests without an Origin
        // header (e.g. non-browser clients such as curl) do not get CORS headers.
        if (!origin) {
          return callback(null, false);
        }
        if (allowedOrigins.includes(origin)) {
          return callback(null, true);
        }
        return callback(null, false);
      },
    })
  );
}

app.use(express.json({ limit: "256kb" }));

// Return clear 413/400 responses for oversized or malformed JSON bodies.
app.use((err, req, res, next) => {
  if (!err) return next();
  if (err.type === "entity.too.large") {
    if (!res.headersSent) return res.status(413).json({ error: "Request body too large" });
    return res.end();
  }
  if (err instanceof SyntaxError && "body" in err) {
    if (!res.headersSent) return res.status(400).json({ error: "Invalid JSON body" });
    return res.end();
  }
  return next(err);
});

app.all("/mcp", async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  res.on("close", () => {
    try {
      transport.close();
    } catch {
      // Ignore errors on close during connection teardown
    }
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    // Ensure errors from async handler do not become unhandled rejections
    const message =
      err && typeof err === "object" && "message" in err
        ? /** @type {{ message?: string }} */ (err).message || "Internal server error"
        : "Internal server error";

    try {
      if (!res.headersSent) {
        res.status(500).json({ error: message });
      } else {
        res.end();
      }
    } catch {
      // Ignore secondary errors while attempting to send error response
    }
  } finally {
    try {
      // Ensure transport is closed even if an error occurs
      await transport.close();
    } catch {
      // Ignore errors during transport close
    }
  }
});

// Health-check / discovery endpoint
app.get("/", (_req, res) => {
  res.json({
    name: "tab-mcp",
    version: "0.1.0",
    mcp_endpoint: `http://localhost:${PORT}/mcp`,
    selected_tab: cachedTab
      ? { id: cachedTab.id, title: cachedTab.title, url: cachedTab.url }
      : null,
  });
});

app.listen(PORT, "127.0.0.1", () => {
  process.stderr.write(
    `[tab-mcp] MCP server listening on http://127.0.0.1:${PORT}/mcp\n`
  );
});
