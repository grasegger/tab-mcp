# tab-mcp

A Firefox browser extension that lets you expose **one browser tab** to AI agents via a **local MCP server** (read-only).

Click the **tab-mcp toolbar button** on any tab to select it — the icon turns green to confirm. The MCP server then makes that tab's content available. Click the button again to deselect.

The extension exposes three read-only tools:

| Tool | Description |
|------|-------------|
| `get_title` | Return the title of the selected tab |
| `get_screenshot` | Capture a PNG screenshot of the selected tab |
| `get_html` | Return the full outer-HTML of the selected tab |

## How it works

1. Click the **tab-mcp toolbar button** on the tab you want to expose — it turns green
2. The extension immediately sends a snapshot (title, HTML, screenshot) to the native host
3. An AI agent calls `get_title`, `get_screenshot`, or `get_html` via the MCP server
4. Click the button again (or close the tab) to stop exposing it

## Architecture

```
AI agent ──(MCP HTTP)──► native-host/index.js :3712
                                │
                    native messaging (stdio)
                                │
                     Firefox extension background.js
                                │
                       browser tab APIs
```

The Firefox extension connects to a **native messaging host** (a small Node.js process) that starts an HTTP MCP server on `http://127.0.0.1:3712/mcp`. When the user clicks the toolbar button, the extension proactively pushes a snapshot to the host so MCP tool calls are answered instantly.

## Requirements

- Firefox 91+
- Node.js 18+
- npm 8+

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/grasegger/tab-mcp.git
cd tab-mcp
```

### 2. Install the native messaging host

**Linux / macOS**
```bash
bash scripts/install-host.sh
```

**Windows (PowerShell)**
```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install-host.ps1
```

The script:
- Runs `npm install` inside `native-host/`
- Creates a wrapper script (e.g. `native-host/run.sh`)
- Writes the native messaging manifest to the correct OS location so Firefox can find it

### 3. Load the extension in Firefox

1. Open `about:debugging` in Firefox
2. Click **"This Firefox"** → **"Load Temporary Add-on…"**
3. Select `extension/manifest.json`

The **tab-mcp** icon (blue "T") should appear in the toolbar. The native host process starts automatically when the extension loads.

### 4. Select a tab to expose

Navigate to the tab you want to expose, then click the **tab-mcp toolbar button**. The icon turns **green** and shows an **ON** badge, indicating that tab is now selected. Click again to deselect.

### 5. Verify the MCP server is running

```bash
curl http://127.0.0.1:3712/
```

Expected response (once a tab is selected):
```json
{"name":"tab-mcp","version":"0.1.0","mcp_endpoint":"http://127.0.0.1:3712/mcp","selected_tab":{"id":42,"title":"Example Domain","url":"https://example.com"}}
```

## Configuring an MCP client

Add the following to your MCP client configuration (e.g. `claude_desktop_config.json` or `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "tab-mcp": {
      "url": "http://127.0.0.1:3712/mcp"
    }
  }
}
```

The MCP server uses the **Streamable HTTP** transport (`POST /mcp`).

## Building the extension zip (CI)

A GitHub Actions workflow (`.github/workflows/build.yml`) automatically builds and uploads `tab-mcp.zip` as a workflow artifact on every push to `main` and on every version tag (`v*`). Download it from the **Actions** tab of the repository.

To build locally:

```bash
cd native-host && npm ci --omit=dev && cd ..
zip -r tab-mcp.zip extension/ native-host/ scripts/ README.md
```

## Project structure

```
tab-mcp/
├── extension/           # Firefox WebExtension (MV2)
│   ├── manifest.json
│   ├── background.js    # Native messaging bridge + browser API calls
│   └── icons/
├── native-host/         # Node.js MCP server
│   ├── index.js         # MCP server + native messaging wire protocol
│   ├── host-manifest.json
│   └── package.json
├── scripts/
│   ├── install-host.sh  # Linux/macOS installer
│   └── install-host.ps1 # Windows installer
└── .github/
    └── workflows/
        └── build.yml    # CI: build + upload extension zip
```

## Port configuration

The default MCP port is **3712**. Override it with the `TAB_MCP_PORT` environment variable:

```bash
TAB_MCP_PORT=4000 node native-host/index.js
```

## License

MIT
