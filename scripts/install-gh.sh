#!/usr/bin/env bash
set -euo pipefail

BIN_DIR="$(dirname "$0")/../.render-bin"
mkdir -p "$BIN_DIR"

if [ -x "$BIN_DIR/gh" ]; then
  echo "gh already present in $BIN_DIR, skipping download"
  exit 0
fi

echo "Fetching latest gh CLI release info..."
LATEST_TAG=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest \
  | grep -m1 '"tag_name"' \
  | sed -E 's/.*"v([^"]+)".*/\1/')

if [ -z "$LATEST_TAG" ]; then
  echo "Could not determine latest gh version, falling back to 2.63.0"
  LATEST_TAG="2.63.0"
fi

echo "Installing gh v${LATEST_TAG}..."
TMP_DIR=$(mktemp -d)
curl -fsSL "https://github.com/cli/cli/releases/download/v${LATEST_TAG}/gh_${LATEST_TAG}_linux_amd64.tar.gz" \
  -o "$TMP_DIR/gh.tar.gz"
tar -xzf "$TMP_DIR/gh.tar.gz" -C "$TMP_DIR"
cp "$TMP_DIR/gh_${LATEST_TAG}_linux_amd64/bin/gh" "$BIN_DIR/gh"
chmod +x "$BIN_DIR/gh"
rm -rf "$TMP_DIR"

echo "gh installed at $BIN_DIR/gh"
"$BIN_DIR/gh" --version
