#!/bin/bash
# Punchboard: one-click starter for macOS, from the source.
#
# Double-click in Finder. It builds the companion (the Rust program in
# server/) and starts it, so it needs Rust; the first run also builds the
# pages, which needs Node.js. Nothing is installed system-wide and no admin
# password is needed. Most people do not need any of this: the app on the
# releases page is the same Punchboard, ready to open.
cd "$(cd "$(dirname "$0")" && pwd)" || exit 1

RELEASES="https://github.com/GH-Jaider/punchboard/releases/latest"

pause_and_exit() {
  echo ""
  read -r -p "  Press Return to close this window..."
  exit "${1:-1}"
}

echo ""
echo "  Punchboard"
echo "  =========="
echo ""

# rustup installs here; a window opened from Finder may not have it on PATH.
[ -x "$HOME/.cargo/bin/cargo" ] && export PATH="$HOME/.cargo/bin:$PATH"

if ! command -v cargo >/dev/null 2>&1; then
  echo "  Running Punchboard from the source needs Rust: install it from"
  echo "  https://rustup.rs and double-click this file again."
  echo "  Most people should install the app instead:"
  echo "  $RELEASES"
  pause_and_exit 1
fi

# The pages (public/js) are built from src/client, once, with Node.js.
if [ ! -f public/js/deck.js ]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "  The pages have not been built yet, and building them needs Node.js:"
    echo "  install it from https://nodejs.org and double-click this file again."
    echo "  Or install the app instead: $RELEASES"
    pause_and_exit 1
  fi
  echo "  Building the pages, this only happens once..."
  if ! npm ci --no-audit --no-fund --loglevel=error; then
    echo "  Something went wrong installing. Check the messages above."
    pause_and_exit 1
  fi
  if ! npm run --silent build; then
    echo "  The build failed. Check the messages above."
    pause_and_exit 1
  fi
  echo ""
fi

echo "  Starting (the first time, building takes a few minutes)."
echo "  Keep this window open while you stream;"
echo "  close it (or press Ctrl+C) to stop the deck."
PUNCHBOARD_APP_DIR="$PWD" cargo run --release --locked --manifest-path server/Cargo.toml
pause_and_exit $?
