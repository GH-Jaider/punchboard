# A Linux to build and test the companion in, from a Mac or Windows:
#   scripts/linux.sh cargo test
# Rust, Node (for the black-box tests) and the system libraries the companion
# links on Linux: ALSA and PulseAudio for sound, X11 for keys and pointer,
# OpenSSL for HTTPS. The Windows target too, so clippy can check the Windows
# code with this Rust (CI's, where a local toolchain may be older):
#   scripts/linux.sh cargo clippy --all-targets --target x86_64-pc-windows-msvc -- -D warnings
FROM rust:1-bookworm
RUN rustup component add clippy rustfmt && rustup target add x86_64-pc-windows-msvc
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
 && apt-get install -y --no-install-recommends nodejs pkg-config libasound2-dev libpulse-dev libssl-dev \
      libx11-dev libxtst-dev libxi-dev libudev-dev libdbus-1-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /work/server
