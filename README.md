# tab-mcp

A Firefox browser extension that exposes the **active tab** to AI agents via a **local MCP server** (read-only).

The extension has three tools:

| Tool | Description |
|------|-------------|
| `get_title` | Return the title of the active tab |
| `get_screenshot` | Capture a PNG screenshot of the visible tab |
| `get_html` | Return the full outer-HTML of the active tab |

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

The Firefox extension connects to a **native messaging host** (a small Node.js process) that starts an HTTP MCP server on `http://127.0.0.1:3712/mcp`. When an AI agent calls a tool, the host asks the extension to use browser APIs to fetch the data and returns the result.

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

The extension icon should appear in the toolbar and the native host process starts automatically.

### 4. Verify the MCP server is running

```bash
curl http://127.0.0.1:3712/
```

Expected response:
```json
{"name":"tab-mcp","version":"0.1.0","mcp_endpoint":"http://127.0.0.1:3712/mcp"}
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
