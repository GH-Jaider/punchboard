#!/bin/bash
# Punchboard: one-click starter for macOS.
#
# Double-click in Finder. The first run downloads its own copy of Node.js into
# ./runtime (checked against the official checksums), installs dependencies,
# then starts the companion. Nothing is installed system-wide and no admin
# password is needed. Later runs start straight away, offline too.
cd "$(cd "$(dirname "$0")" && pwd)" || exit 1

NODE_VERSION="24.15.0"
case "$(uname -m)" in
  arm64) NODE_ARCH="arm64" ;;
  *) NODE_ARCH="x64" ;;
esac
NODE_NAME="node-v${NODE_VERSION}-darwin-${NODE_ARCH}"
NODE_HOME="$PWD/runtime/$NODE_NAME"

pause_and_exit() {
  echo ""
  read -r -p "  Press Return to close this window..."
  exit "${1:-1}"
}

echo ""
echo "  Punchboard"
echo "  =========="
echo ""

download_node() {
  local base="https://nodejs.org/dist/v${NODE_VERSION}"
  local tmp
  tmp="$(mktemp -d)" || return 1
  echo "  First run: downloading Node.js ${NODE_VERSION} (about 50 MB)..."
  curl -fL --progress-bar "$base/${NODE_NAME}.tar.gz" -o "$tmp/node.tar.gz" || { rm -rf "$tmp"; return 1; }
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" || { rm -rf "$tmp"; return 1; }
  local expected actual
  expected="$(grep " ${NODE_NAME}.tar.gz\$" "$tmp/SHASUMS256.txt" | cut -d' ' -f1)"
  actual="$(shasum -a 256 "$tmp/node.tar.gz" | cut -d' ' -f1)"
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    echo "  The download did not match the official checksum, so it was discarded."
    rm -rf "$tmp"
    return 1
  fi
  tar -xzf "$tmp/node.tar.gz" -C "$tmp" || { rm -rf "$tmp"; return 1; }
  mkdir -p runtime && mv "$tmp/$NODE_NAME" "$NODE_HOME"
  rm -rf "$tmp"
  echo "  Node.js is ready."
  echo ""
}

if [ ! -x "$NODE_HOME/bin/node" ] && ! download_node; then
  # Offline on the first run: fall back to a Node the Mac already has.
  if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
    echo "  Could not download Node.js, so the one already on this Mac will be used."
  else
    echo "  Node.js could not be downloaded. Check the internet connection and"
    echo "  double-click this file again. This is only needed the first time."
    pause_and_exit 1
  fi
else
  export PATH="$NODE_HOME/bin:$PATH"
fi

# Dependencies: installed on the first run, and again whenever they change.
if [ ! -f node_modules/.installed ] || [ package-lock.json -nt node_modules/.installed ]; then
  echo "  Installing Punchboard's parts, this only happens once..."
  if ! npm ci --omit=dev --no-audit --no-fund --loglevel=error; then
    echo "  Something went wrong installing. Check the messages above."
    pause_and_exit 1
  fi
  touch node_modules/.installed
  echo ""
fi

echo "  Starting. Keep this window open while you stream;"
echo "  close it (or press Ctrl+C) to stop the deck."
node server.js
pause_and_exit $?
