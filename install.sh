#!/usr/bin/env bash
set -euo pipefail

# Install script for pi-tools
# Copies each tool directory into the Pi extensions folder.
#
# Pi auto-discovers extensions as:
#   ~/.pi/agent/extensions/*.ts       (single-file)
#   ~/.pi/agent/extensions/*/index.ts  (directory)
#
# Each tool is installed as <name>.ts/ with entry point renamed to index.ts.

EXTENSIONS_DIR="${1:-$HOME/.pi/agent/extensions}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Directories to install. Entry point is <name>.ts inside each.
TOOLS=(handoff plan-mode web-search)

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
        echo "SKIP: $tool (already exists at $dest)"
        skipped=$((skipped + 1))
        continue
    fi

    cp -r "$src" "$dest"

    # Rename entry point to index.ts (Pi discovers <dir>/index.ts)
    entry="$dest/${tool}.ts"
    if [ -f "$entry" ]; then
        mv "$entry" "$dest/index.ts"
    fi

    echo "COPY: $tool -> $dest"
    installed=$((installed + 1))
done

echo ""
echo "Done. Installed: $installed, Skipped: $skipped"
echo "Reload Pi (/reload) or restart to pick up new extensions."
