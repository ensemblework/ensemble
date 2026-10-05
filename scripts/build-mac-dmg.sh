#!/usr/bin/env bash
# Build an unsigned Ensemble disk image on a Mac.
#
# From the repo root:
#   pnpm desktop:dmg
#
# The app shell is a universal build (Apple Silicon and Intel), the same
# target the desktop workflow uses. The packed API sidecar is not: it copies
# this Mac's Node binary, the libraries that binary links, and the Prisma
# engine, so the image runs only on a Mac with the same chip as the one that
# built it. Nothing is signed.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

problems=()

problem() {
  problems+=("$1")
}

say() {
  printf '%s\n' "$*"
}

version_at_least() {
  # $1 is the installed version, $2 is the minimum. Both are dotted numbers.
  local current="$1"
  local minimum="$2"
  local IFS=.
  # shellcheck disable=SC2206
  local cur=($current) min=($minimum)
  local i c m
  for i in 0 1 2; do
    c="${cur[$i]:-0}"
    m="${min[$i]:-0}"
    c="${c%%[^0-9]*}"
    m="${m%%[^0-9]*}"
    c="${c:-0}"
    m="${m:-0}"
    if ((10#$c > 10#$m)); then
      return 0
    fi
    if ((10#$c < 10#$m)); then
      return 1
    fi
  done
  return 0
}

say "Checking prerequisites for an unsigned Ensemble.dmg…"
say ""

if [[ "$(uname -s)" != "Darwin" ]]; then
  problem "$(cat <<EOF
Xcode command line tools are a Mac prerequisite. This machine is $(uname -s), so they are not here.
  On a Mac, install them with:
    xcode-select --install
EOF
)"
elif ! xcode-select -p >/dev/null 2>&1; then
  problem "$(cat <<'EOF'
Xcode command line tools are not installed.
  xcode-select --install
EOF
)"
else
  say "  Xcode command line tools: $(xcode-select -p)"
fi

if ! command -v node >/dev/null 2>&1; then
  problem "$(cat <<'EOF'
Node.js 22 is not installed.
  brew install node@22
  Or install Node 22 from https://nodejs.org/
EOF
)"
else
  node_version="$(node -p "process.versions.node")"
  node_major="${node_version%%.*}"
  if ! version_at_least "$node_version" "22.0.0"; then
    problem "$(cat <<EOF
Node.js is v${node_version}. This repo needs Node 22 or newer.
  brew install node@22
  Or install Node 22 from https://nodejs.org/
  If you use nvm: nvm install 22
EOF
)"
  else
    say "  Node.js: v${node_version} (major ${node_major})"
  fi
fi

if ! command -v pnpm >/dev/null 2>&1; then
  problem "$(cat <<'EOF'
pnpm is not installed. This repo pins pnpm 12.6.0.
  corepack enable
  corepack prepare pnpm@12.6.0 --activate
EOF
)"
else
  say "  pnpm: $(pnpm -v)"
fi

rustup_advised=0
if ! command -v rustc >/dev/null 2>&1 || ! command -v cargo >/dev/null 2>&1; then
  rustup_advised=1
  problem "$(cat <<'EOF'
Rust is not installed. The desktop app needs Rust 1.87 or newer, plus rustup so the Apple targets can be added.
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  source "$HOME/.cargo/env"
  rustup default stable
EOF
)"
else
  rust_version="$(rustc --version | awk '{print $2}')"
  if ! version_at_least "$rust_version" "1.87.0"; then
    if command -v rustup >/dev/null 2>&1; then
      problem "$(cat <<EOF
Rust is ${rust_version}. The desktop app needs Rust 1.87 or newer.
  rustup update stable
  rustup default stable
  source "\$HOME/.cargo/env"
EOF
)"
    else
      rustup_advised=1
      problem "$(cat <<EOF
Rust is ${rust_version}, not from rustup. The desktop app needs Rust 1.87 or newer, and rustup to add the Apple targets.
  If Rust came from Homebrew: brew uninstall rust
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  source "\$HOME/.cargo/env"
  rustup default stable
EOF
)"
    fi
  else
    say "  Rust: rustc ${rust_version}"
  fi
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  if [[ "${rustup_advised}" -eq 0 ]] && ! command -v rustup >/dev/null 2>&1; then
    problem "$(cat <<'EOF'
rustup is not installed. The universal disk image needs the Apple Silicon and Intel targets, and rustup adds them.
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  source "$HOME/.cargo/env"
  rustup default stable
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
EOF
)"
  fi
fi

tauri_ready=0
if [[ -x "${root}/apps/desktop/node_modules/.bin/tauri" ]]; then
  tauri_ready=1
elif command -v tauri >/dev/null 2>&1; then
  tauri_ready=1
elif command -v pnpm >/dev/null 2>&1 && pnpm --filter @ensemble/desktop exec tauri --version >/dev/null 2>&1; then
  tauri_ready=1
fi
if [[ "$tauri_ready" -eq 1 ]]; then
  say "  Tauri CLI: available"
else
  say "  Tauri CLI: not installed yet. pnpm install in this script installs @tauri-apps/cli from the desktop package."
fi

if [[ ${#problems[@]} -gt 0 ]]; then
  say ""
  say "Missing prerequisites:"
  say ""
  for item in "${problems[@]}"; do
    printf '%s\n\n' "$item"
  done
  say "Install those, then from the repo root run:"
  say "  pnpm desktop:dmg"
  exit 1
fi

say ""
say "Installing dependencies…"
pnpm install --frozen-lockfile

say ""
say "Checking the Tauri CLI…"
if ! pnpm --filter @ensemble/desktop exec tauri --version; then
  cat <<'EOF' >&2

The Tauri CLI did not run after pnpm install.
From the repo root:

  pnpm install
  pnpm --filter @ensemble/desktop exec tauri --version

Or install the CLI yourself:

  cargo install tauri-cli --version "^2" --locked
EOF
  exit 1
fi

say ""
say "Exporting the desktop web UI…"
pnpm desktop:export

say ""
say "Packing the local API sidecar…"
pnpm desktop:sidecar

say ""
say "Adding the Apple Silicon and Intel Rust targets…"
rustup target add aarch64-apple-darwin x86_64-apple-darwin

# A key in the environment would sign the bundle. This command stays unsigned.
unset TAURI_SIGNING_PRIVATE_KEY
unset TAURI_SIGNING_PRIVATE_KEY_PASSWORD

say ""
say "Building the universal disk image (Apple Silicon and Intel)…"
(
  cd "${root}/apps/desktop"
  pnpm exec tauri build --target universal-apple-darwin --bundles app,dmg
)

# Cargo writes under CARGO_TARGET_DIR when it is set, not src-tauri/target.
target_dir="${CARGO_TARGET_DIR:-${root}/apps/desktop/src-tauri/target}"
case "${target_dir}" in
  /*) ;;
  *) target_dir="${root}/apps/desktop/src-tauri/${target_dir}" ;;
esac
bundle_dir="${target_dir}/universal-apple-darwin/release/bundle/dmg"
shopt -s nullglob
dmgs=("${bundle_dir}"/*.dmg)
shopt -u nullglob

if [[ ${#dmgs[@]} -eq 0 ]]; then
  say ""
  say "The Tauri build finished, but no .dmg was found in:"
  say "  ${bundle_dir}"
  exit 1
fi

say ""
say "Disk image:"
for dmg in "${dmgs[@]}"; do
  say "  ${dmg}"
done

say ""
say "The local API inside the app is built for this Mac's chip ($(uname -m)). Build on an Intel Mac for an Intel Mac."

cat <<'EOF'

This build is unsigned. There is no Apple certificate, so macOS may block a normal double-click the first time.

To open it:
  macOS 14 and earlier: right-click the app, then Open, then Open again.
  macOS 15 and later: double-click it once, then System Settings > Privacy & Security > Open Anyway.
EOF
