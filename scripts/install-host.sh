#!/usr/bin/env bash
# install-host.sh – install the tab-mcp native messaging host on Linux/macOS
#
# Usage:  bash scripts/install-host.sh
#
# What it does:
#   1. Installs npm dependencies in native-host/
#   2. Creates a thin wrapper script (native-host/run.sh) that node can exec
#   3. Writes the native messaging manifest with the correct absolute path to:
#      - macOS: ~/Library/Application Support/Mozilla/NativeMessagingHosts/
#      - Linux: ~/.mozilla/native-messaging-hosts/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
HOST_DIR="$REPO_DIR/native-host"

echo "==> Installing npm dependencies in native-host/ ..."
cd "$HOST_DIR"
npm install --omit=dev

# Create the wrapper script that Firefox will launch
WRAPPER="$HOST_DIR/run.sh"
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
exec node "$(realpath "$HOST_DIR/index.js")"
EOF
chmod +x "$WRAPPER"

# Determine the manifest directory for the current OS
case "$(uname -s)" in
  Darwin*)
    MANIFEST_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
    ;;
  Linux*)
    MANIFEST_DIR="$HOME/.mozilla/native-messaging-hosts"
    ;;
  *)
    echo "Unsupported OS: $(uname -s)"
    exit 1
    ;;
esac

mkdir -p "$MANIFEST_DIR"

# Write the manifest, substituting the real wrapper path
sed "s|PATH_PLACEHOLDER|$WRAPPER|g" \
    "$HOST_DIR/host-manifest.json" \
    > "$MANIFEST_DIR/tab_mcp_host.json"

echo ""
echo "✅ Native messaging host installed."
echo "   Manifest: $MANIFEST_DIR/tab_mcp_host.json"
echo ""
echo "Next steps:"
echo "  1. Load the extension in Firefox: about:debugging → Load Temporary Add-on → extension/manifest.json"
echo "  2. Point your MCP client at: http://127.0.0.1:3712/mcp"
