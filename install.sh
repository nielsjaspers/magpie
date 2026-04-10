#!/usr/bin/env bash
set -euo pipefail

# Install script for pi-tools
# Copies each tool directory into the Pi extensions folder.

EXTENSIONS_DIR="${1:-$HOME/.pi/agent/extensions}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Each tool is installed as <name>.ts/ (Pi expects extension folders ending in .ts)
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

    # Check if destination already exists
    if [ -e "$dest" ]; then
        echo "SKIP: $tool (already exists at $dest)"
        skipped=$((skipped + 1))
        continue
    fi

    cp -r "$src" "$dest"
    echo "COPY: $tool -> $dest"
    installed=$((installed + 1))
done

echo ""
echo "Done. Installed: $installed, Skipped: $skipped"
echo "Reload Pi (/reload) or restart to pick up new extensions."
