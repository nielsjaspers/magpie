#!/usr/bin/env bash
set -euo pipefail

# Install script for pi-tools
# Copies each tool directory into the Pi extensions folder.
#
# Usage: ./install.sh [--overwrite] [EXTENSIONS_DIR]
#   --overwrite   Overwrite existing extensions instead of skipping them.
#
# Pi auto-discovers extensions as:
#   ~/.pi/agent/extensions/*.ts       (single-file)
#   ~/.pi/agent/extensions/*/index.ts  (directory)
#
# Each tool is installed as <name>.ts/ with entry point renamed to index.ts.

OVERWRITE=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --overwrite|-f)
            OVERWRITE=true
            shift
            ;;
        *)
            break
            ;;
    esac
done

EXTENSIONS_DIR="${1:-$HOME/.pi/agent/extensions}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Directories to install. Entry point is <name>.ts inside each.
TOOLS=(spinner custom-modes handoff session-query plan-mode web-search web-fetch btw)

mkdir -p "$EXTENSIONS_DIR"

installed=0
skipped=0

for tool in "${TOOLS[@]}"; do

    src="$SCRIPT_DIR/$tool"
    dest="$EXTENSIONS_DIR/${tool}.ts"

    if [ ! -d "$src" ]; then
        echo "SKIP: $tool (source directory not found)"
        skipped=$((skipped + 1))
        continue
    fi

    if [ -e "$dest" ]; then
        if [ "$OVERWRITE" = true ]; then
            rm -rf "$dest"
        else
            echo "SKIP: $tool (already exists at $dest, use --overwrite to replace)"
            skipped=$((skipped + 1))
            continue
        fi
    fi

    cp -r "$src" "$dest"

    # Rename entry point to index.ts (Pi discovers <dir>/index.ts)
    entry="$dest/${tool}.ts"
    if [ -f "$entry" ]; then
        mv "$entry" "$dest/index.ts"
    fi

    if [ "$OVERWRITE" = true ]; then
        echo "OVERWRITE: $tool -> $dest"
    else
        echo "COPY: $tool -> $dest"
    fi
    installed=$((installed + 1))
done

echo ""
echo "Done. Installed: $installed, Skipped: $skipped"
echo "Reload Pi (/reload) or restart to pick up new extensions."
