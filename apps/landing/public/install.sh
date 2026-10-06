#!/bin/sh
set -eu

# Ensemble CLI installer.
#
# Installs to:
#   ${ENSEMBLE_INSTALL_DIR:-$HOME/.local/share/ensemble-cli}/<version>/ensemble
# and points $HOME/.local/bin/ensemble at that version.
#
# Set ENSEMBLE_VERSION=0.1.0 (or cli-v0.1.0) to pin a version.
# Set ENSEMBLE_DOWNLOAD_BASE=https://host/path (or file:///tmp/path) to test
# against a directory that contains the archive and SHA256SUMS.txt.
#
# Uninstall:
#   rm -f "$HOME/.local/bin/ensemble"
#   rm -rf "${ENSEMBLE_INSTALL_DIR:-$HOME/.local/share/ensemble-cli}"

repo=ensemblework/ensemble
api_url="https://api.github.com/repos/$repo/releases?per_page=30"

fail() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

have() {
  command -v "$1" >/dev/null 2>&1
}

fetch_stdout() {
  url=$1
  if have curl; then
    curl -fsSL "$url"
  elif have wget; then
    wget -qO- "$url"
  else
    fail "curl or wget is required"
  fi
}

fetch_file() {
  url=$1
  output=$2
  if have curl; then
    curl -fL --retry 3 -o "$output" "$url"
  elif have wget; then
    wget -O "$output" "$url"
  else
    fail "curl or wget is required"
  fi
}

detect_target() {
  os=$(uname -s 2>/dev/null || true)
  arch=$(uname -m 2>/dev/null || true)
  case "$os" in
    Darwin) platform=darwin ;;
    Linux) platform=linux ;;
    *) fail "unsupported operating system: $os" ;;
  esac
  case "$arch" in
    x86_64|amd64) cpu=x64 ;;
    arm64|aarch64) cpu=arm64 ;;
    *) fail "unsupported CPU architecture: $arch" ;;
  esac
  printf '%s-%s\n' "$platform" "$cpu"
}

latest_tag() {
  fetch_stdout "$api_url" | awk '
    /^  \{/ { tag = ""; draft = ""; prerelease = "" }
    /"tag_name": "cli-v/ {
      tag = $0
      sub(/^.*"tag_name": "/, "", tag)
      sub(/".*$/, "", tag)
    }
    /"draft": true/ { draft = "true" }
    /"prerelease": true/ { prerelease = "true" }
    /^  \},?$/ {
      if (tag != "" && draft != "true" && prerelease != "true") {
        print tag
        exit
      }
    }
  '
}

version_from_env=${ENSEMBLE_VERSION:-}
if [ -n "$version_from_env" ]; then
  case "$version_from_env" in
    cli-v*) tag=$version_from_env; version=${version_from_env#cli-v} ;;
    *) version=$version_from_env; tag=cli-v$version_from_env ;;
  esac
elif [ -n "${ENSEMBLE_DOWNLOAD_BASE:-}" ]; then
  fail "ENSEMBLE_VERSION is required when ENSEMBLE_DOWNLOAD_BASE is set"
else
  tag=$(latest_tag)
  [ -n "$tag" ] || fail "could not find a non-draft cli-v* release"
  version=${tag#cli-v}
fi

target=$(detect_target)
archive=ensemble-cli-$version-$target.tar.gz
base=${ENSEMBLE_DOWNLOAD_BASE:-https://github.com/$repo/releases/download/$tag}
base=${base%/}
archive_url=$base/$archive
sums_url=$base/SHA256SUMS.txt

tmp=$(mktemp -d "${TMPDIR:-/tmp}/ensemble-install.XXXXXX") || fail "could not create a temporary folder"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT HUP INT TERM

printf 'Downloading Ensemble CLI %s for %s...\n' "$version" "$target"
fetch_file "$archive_url" "$tmp/$archive"
fetch_file "$sums_url" "$tmp/SHA256SUMS.txt"

expected=$(awk -v file="$archive" '$2 == file || $2 == "*" file { print $1; exit }' "$tmp/SHA256SUMS.txt")
[ -n "$expected" ] || fail "SHA256SUMS.txt does not contain $archive"

if have sha256sum; then
  (cd "$tmp" && printf '%s  %s\n' "$expected" "$archive" | sha256sum -c - >/dev/null)
elif have shasum; then
  actual=$(shasum -a 256 "$tmp/$archive" | awk '{ print $1 }')
  [ "$actual" = "$expected" ] || fail "sha256 mismatch for $archive"
else
  fail "sha256sum or shasum is required"
fi

install_root=${ENSEMBLE_INSTALL_DIR:-$HOME/.local/share/ensemble-cli}
version_dir=$install_root/$version
payload=$tmp/payload
mkdir -p "$payload" "$install_root" "$HOME/.local/bin"
tar -xzf "$tmp/$archive" -C "$payload"
[ -x "$payload/ensemble/bin/ensemble" ] || fail "archive did not contain ensemble/bin/ensemble"

if [ ! -d "$version_dir" ]; then
  staging=$install_root/.install-$version.$$
  rm -rf "$staging"
  mv "$payload" "$staging"
  mv "$staging" "$version_dir"
fi

chmod +x "$version_dir/ensemble/bin/ensemble"
link=$HOME/.local/bin/ensemble
link_tmp=$HOME/.local/bin/.ensemble.$$
rm -f "$link_tmp"
ln -s "$version_dir/ensemble/bin/ensemble" "$link_tmp"
mv -f "$link_tmp" "$link"

printf 'Ensemble CLI %s installed at %s\n' "$version" "$version_dir/ensemble"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) printf 'Add %s to PATH, then open a new shell if needed.\n' "$HOME/.local/bin" ;;
esac
printf 'Next step: ensemble login\n'
