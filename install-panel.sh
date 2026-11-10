#!/bin/sh
# Builds this panel and installs it as the proxy's management.html.
# Requires `disable-auto-update-panel: true` in the proxy config, or the proxy
# replaces it with the upstream release on its next update check.
set -eu
cd "$(dirname "$0")"

target="${CLIPROXY_PANEL_PATH:-/opt/homebrew/etc/static/management.html}"
config="${CLIPROXY_CONFIG:-/opt/homebrew/etc/cliproxyapi.conf}"

if ! grep -Eq '^[[:space:]]*disable-auto-update-panel:[[:space:]]*true' "$config"; then
  echo "warning: $config does not set disable-auto-update-panel: true; the proxy will overwrite this build" >&2
fi

bun run build
if [ -f "$target" ] && [ ! -f "$target.upstream" ]; then
  cp "$target" "$target.upstream"
fi
cp dist/index.html "$target.tmp"
mv "$target.tmp" "$target"
echo "Installed panel to $target (upstream copy kept at $target.upstream)"
