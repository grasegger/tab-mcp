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
 *        • get_title      – title of the active tab
 *        • get_screenshot – base64-encoded PNG screenshot
 *        • get_html       – full outer-HTML of the active tab
 */

import { randomUUID } from "node:crypto";
import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const PORT = process.env.TAB_MCP_PORT ? Number(process.env.TAB_MCP_PORT) : 3712;

// ---------------------------------------------------------------------------
// Native-messaging bridge (stdin / stdout)
// ---------------------------------------------------------------------------

let msgBuffer = Buffer.alloc(0);
let nextId = 0;
/** @type {Map<number, { resolve: (v: any) => void, timer: ReturnType<typeof setTimeout> }>} */
const pending = new Map();

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
  const entry = pending.get(msg.id);
  if (entry) {
    clearTimeout(entry.timer);
    pending.delete(msg.id);
    entry.resolve(msg.result);
  }
}

/**
 * Ask the extension to perform `type` and return the result.
 * @param {"get_title"|"get_screenshot"|"get_html"} type
 * @returns {Promise<Record<string, any>>}
 */
function askExtension(type) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
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
    description: "Return the title of the currently active browser tab.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_screenshot",
    description:
      "Capture a screenshot of the currently active browser tab and return it as a base64-encoded PNG image.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_html",
    description:
      "Return the full outer-HTML of the currently active browser tab.",
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
      const result = await askExtension("get_title");
      if (result.error) throw new Error(result.error);
      return { content: [{ type: "text", text: result.title ?? "" }] };
    }

    if (name === "get_screenshot") {
      const result = await askExtension("get_screenshot");
      if (result.error) throw new Error(result.error);
      const base64 = result.dataUrl.replace(/^data:image\/\w+;base64,/, "");
      return {
        content: [{ type: "image", data: base64, mimeType: "image/png" }],
      };
    }

    if (name === "get_html") {
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
app.use(cors({ origin: "*" }));
app.use(express.json());

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
  });
});

app.listen(PORT, "127.0.0.1", () => {
  process.stderr.write(
    `[tab-mcp] MCP server listening on http://127.0.0.1:${PORT}/mcp\n`
  );
});
