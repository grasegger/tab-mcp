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

## Setup

### 1. Install npm dependencies

```bash
cd native-host && npm ci --omit=dev && cd ..
```

### 2. Register the native messaging host with Firefox

Create a wrapper script that Firefox will launch and write the manifest to the location Firefox checks.

**Linux**

```bash
# Create run.sh (resolves path at runtime so moving the directory still works)
cat > native-host/run.sh <<'EOF'
#!/usr/bin/env bash
exec node "$(cd "$(dirname "$0")" && pwd)/index.js"
EOF
chmod +x native-host/run.sh

# Write manifest
mkdir -p ~/.mozilla/native-messaging-hosts
sed "s|PATH_PLACEHOLDER|$(pwd)/native-host/run.sh|" \
    native-host/host-manifest.json \
    > ~/.mozilla/native-messaging-hosts/tab_mcp_host.json
```

**macOS**

```bash
# Create run.sh (resolves path at runtime so moving the directory still works)
cat > native-host/run.sh <<'EOF'
#!/usr/bin/env bash
exec node "$(cd "$(dirname "$0")" && pwd)/index.js"
EOF
chmod +x native-host/run.sh

# Write manifest
mkdir -p "$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
sed "s|PATH_PLACEHOLDER|$(pwd)/native-host/run.sh|" \
    native-host/host-manifest.json \
    > "$HOME/Library/Application Support/Mozilla/NativeMessagingHosts/tab_mcp_host.json"
```

**Windows (PowerShell)**

```powershell
# Create run.bat
$indexPath = (Resolve-Path native-host\index.js).Path
Set-Content -Path native-host\run.bat -Value "@echo off`r`nnode `"$indexPath`" %*" -Encoding UTF8

# Write manifest
$wrapperPath = (Resolve-Path native-host\run.bat).Path -replace '\\','/'
$dest = "$env:APPDATA\Mozilla\NativeMessagingHosts"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
(Get-Content native-host\host-manifest.json -Raw -Encoding UTF8) -replace 'PATH_PLACEHOLDER', $wrapperPath |
    Set-Content "$dest\tab_mcp_host.json" -Encoding UTF8

# Register in the Windows registry
$regPath = "HKCU:\Software\Mozilla\NativeMessagingHosts\tab_mcp_host"
New-Item -Path $regPath -Force | Out-Null
Set-ItemProperty -Path $regPath -Name "(Default)" -Value "$dest\tab_mcp_host.json"
```

### 3. Load the extension in Firefox

1. Open `about:debugging` in Firefox
2. Click **"This Firefox"** → **"Load Temporary Add-on…"**
3. Select `extension/manifest.json`

The **tab-mcp** icon (blue "T") appears in the toolbar. The native host starts automatically when the extension loads.

### 4. Select a tab to expose

Click the **tab-mcp toolbar button** on the tab you want to expose. The icon turns **green** with an **ON** badge. Click again to deselect.

### 5. Verify

```bash
curl http://127.0.0.1:3712/
# {"name":"tab-mcp","version":"0.1.0","mcp_endpoint":"http://127.0.0.1:3712/mcp","selected_tab":{"id":42,"title":"Example Domain","url":"https://example.com"}}
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
zip -r tab-mcp.zip extension/ native-host/ README.md
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
