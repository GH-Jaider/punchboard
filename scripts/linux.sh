#!/bin/sh
# Runs a command in the Linux container, in server/, with the repository
# mounted. Builds go to server/target/linux so they never mix with the host's.
#   scripts/linux.sh cargo test
#   scripts/linux.sh sh -c "cd .. && node scripts/test.ts --except designer tour"
#   scripts/linux.sh cargo clippy --all-targets --target x86_64-pc-windows-msvc -- -D warnings
# The image is built once. After a change to linux-dev.Dockerfile, or for a
# newer Rust, remove it and it is built again: docker rmi punchboard-linux-dev
set -e
root="$(cd "$(dirname "$0")/.." && pwd)"
docker image inspect punchboard-linux-dev >/dev/null 2>&1 || docker build -q -t punchboard-linux-dev -f "$root/scripts/linux-dev.Dockerfile" "$root/scripts"
exec docker run --rm -v "$root":/work -v punchboard-cargo-registry:/usr/local/cargo/registry \
  -e CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/work/server/target/linux}" punchboard-linux-dev "$@"
