#!/bin/sh
# Install the reset router as a per-user launchd job. Rerun after pulling changes.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
dest="$HOME/.local/share/cliproxy-reset-router"
label=local.cliproxy-reset-router
plist="$HOME/Library/LaunchAgents/$label.plist"

if [ ! -s "$HOME/.cli-proxy-api/management-key.txt" ]; then
  echo "Put the proxy's management key in ~/.cli-proxy-api/management-key.txt (chmod 600) first." >&2
  exit 1
fi
mkdir -p "$dest"
cp "$here"/*.py "$dest"/
sed -e "s#__INSTALL_DIR__#$dest#g" -e "s#__HOME__#$HOME#g" "$here/$label.plist" > "$plist"
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "Installed to $dest; log: ~/Library/Logs/cliproxy-reset-router.log"
