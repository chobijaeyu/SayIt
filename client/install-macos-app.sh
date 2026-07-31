#!/usr/bin/env bash
# Build SayIt.app and install to /Applications with a stable adhoc code-sign
# identifier (com.sayit.app). Without this, each Tauri adhoc build may use a
# random Identifier, and macOS Accessibility toggles stop applying.
set -euo pipefail

# Script lives in client/; Tauri project root is this directory.
ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$ROOT/src-tauri/target/release/bundle/macos/SayIt.app"
DEST="/Applications/SayIt.app"
BUNDLE_ID="com.sayit.app"

cd "$ROOT"

if [[ "${1:-}" != "--skip-build" ]]; then
  npm run tauri -- build --bundles app
fi

if [[ ! -d "$SRC" ]]; then
  echo "missing $SRC" >&2
  exit 1
fi

# Stable identity for TCC
codesign --force --deep --sign - --identifier "$BUNDLE_ID" "$SRC"

osascript -e 'tell application "SayIt" to quit' 2>/dev/null || true
pkill -x sayit 2>/dev/null || true
sleep 1

rm -rf "$DEST"
ditto "$SRC" "$DEST"
xattr -cr "$DEST" 2>/dev/null || true
codesign --force --deep --sign - --identifier "$BUNDLE_ID" "$DEST"

echo "Installed $DEST"
codesign -dv "$DEST" 2>&1 | grep '^Identifier=' || true
echo
echo "If background hotkeys fail: System Settings → Privacy & Security → Accessibility"
echo "  remove SayIt if listed, then re-add $DEST and enable it."
echo "  Then fully quit and reopen SayIt."

open "$DEST"
