#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE = {
  description: "Ensemble CLI: run tasks assigned from ensemblework.com on your computer, and connect your editor to Ensemble over MCP.",
  homepage: "https://ensemblework.com/download",
  license: "FSL-1.1-MIT",
  formulaLicense: '"FSL-1.1-MIT"',
};

const identifier = "EnsembleWork.EnsembleCLI";
const publisher = "EnsembleWork";

export function readSha256Sums(file) {
  const sums = new Map();
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$/);
    if (!match) continue;
    sums.set(basename(match[2]), match[1].toLowerCase());
  }
  return sums;
}

export function renderAll({ version, assetsDir, outDir, baseUrl = `https://github.com/ensemblework/ensemble/releases/download/cli-v${version}` }) {
  if (!version) throw new Error("renderAll requires a version.");
  if (!assetsDir) throw new Error("renderAll requires assetsDir.");
  if (!outDir) throw new Error("renderAll requires outDir.");
  const sums = readSha256Sums(join(assetsDir, "SHA256SUMS.txt"));
  const assets = assetNames(version);
  const urlFor = (name) => `${baseUrl.replace(/\/$/, "")}/${name}`;
  const sha = (name) => {
    const value = sums.get(name);
    if (!value) throw new Error(`SHA256SUMS.txt is missing ${name}.`);
    return value;
  };

  mkdirSync(outDir, { recursive: true });
  const wingetDir = join(outDir, "winget");
  const aurDir = join(outDir, "aur");
  mkdirSync(wingetDir, { recursive: true });
  mkdirSync(aurDir, { recursive: true });

  const files = new Map();
  files.set("ensemble.rb", renderHomebrew({ version, assets, urlFor, sha }));
  files.set("ensemble.json", renderScoop({ version, assets, urlFor, sha }));
  files.set("nfpm.yaml", renderNfpm({ version, arch: "amd64" }));
  files.set("nfpm-amd64.yaml", renderNfpm({ version, arch: "amd64" }));
  files.set("nfpm-arm64.yaml", renderNfpm({ version, arch: "arm64" }));
  files.set("winget/EnsembleWork.EnsembleCLI.yaml", renderWingetVersion({ version }));
  files.set("winget/EnsembleWork.EnsembleCLI.installer.yaml", renderWingetInstaller({ version, assets, urlFor, sha }));
  files.set("winget/EnsembleWork.EnsembleCLI.locale.en-US.yaml", renderWingetLocale({ version }));
  files.set("aur/PKGBUILD", renderPkgbuild({ version, assets, urlFor, sha }));
  files.set("aur/.SRCINFO", renderSrcinfo({ version, assets, urlFor, sha }));

  for (const [name, content] of files) {
    const path = join(outDir, name);
    writeFileSync(path, content);
  }
  return files;
}

function assetNames(version) {
  return {
    darwinArm: `ensemble-cli-${version}-darwin-arm64.tar.gz`,
    darwinX64: `ensemble-cli-${version}-darwin-x64.tar.gz`,
    linuxX64: `ensemble-cli-${version}-linux-x64.tar.gz`,
    linuxArm: `ensemble-cli-${version}-linux-arm64.tar.gz`,
    windowsX64: `ensemble-cli-${version}-windows-x64.zip`,
  };
}

function renderHomebrew({ version, assets, urlFor, sha }) {
  return `class Ensemble < Formula
  desc "${rubyString(PACKAGE.description)}"
  homepage "${PACKAGE.homepage}"
  license ${PACKAGE.formulaLicense}

  on_macos do
    on_arm do
      url "${urlFor(assets.darwinArm)}"
      sha256 "${sha(assets.darwinArm)}"
    end

    on_intel do
      url "${urlFor(assets.darwinX64)}"
      sha256 "${sha(assets.darwinX64)}"
    end
  end

  on_linux do
    on_arm do
      url "${urlFor(assets.linuxArm)}"
      sha256 "${sha(assets.linuxArm)}"
    end

    on_intel do
      url "${urlFor(assets.linuxX64)}"
      sha256 "${sha(assets.linuxX64)}"
    end
  end

  def install
    libexec.install Dir["*"]
    bin.install_symlink libexec/"bin/ensemble"
  end

  service do
    run [opt_bin/"ensemble", "runner", "start", "--foreground"]
    keep_alive true
    log_path var/"log/ensemble-runner.log"
    error_log_path var/"log/ensemble-runner.err.log"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/ensemble --version")
  end
end
`;
}

function renderScoop({ version, assets, urlFor, sha }) {
  return `${JSON.stringify(
    {
      version,
      description: PACKAGE.description,
      homepage: PACKAGE.homepage,
      license: PACKAGE.license,
      architecture: {
        "64bit": {
          url: urlFor(assets.windowsX64),
          hash: sha(assets.windowsX64),
          extract_dir: "ensemble",
        },
      },
      bin: "bin\\ensemble.exe",
      checkver: {
        github: "https://github.com/ensemblework/ensemble",
        regex: "cli-v([\\d.]+)",
      },
      autoupdate: {
        architecture: {
          "64bit": {
            url: "https://github.com/ensemblework/ensemble/releases/download/cli-v$version/ensemble-cli-$version-windows-x64.zip",
          },
        },
      },
    },
    null,
    2,
  )}\n`;
}

function renderWingetVersion({ version }) {
  return `# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.1.6.0.schema.json
PackageIdentifier: ${identifier}
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: 1.6.0
`;
}

function renderWingetInstaller({ version, assets, urlFor, sha }) {
  return `# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.6.0.schema.json
PackageIdentifier: ${identifier}
PackageVersion: ${version}
InstallerLocale: en-US
InstallerType: zip
NestedInstallerType: portable
NestedInstallerFiles:
  - RelativeFilePath: ensemble\\bin\\ensemble.exe
    PortableCommandAlias: ensemble
Installers:
  - Architecture: x64
    InstallerUrl: ${urlFor(assets.windowsX64)}
    InstallerSha256: ${sha(assets.windowsX64).toUpperCase()}
ManifestType: installer
ManifestVersion: 1.6.0
`;
}

function renderWingetLocale({ version }) {
  return `# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.1.6.0.schema.json
PackageIdentifier: ${identifier}
PackageVersion: ${version}
PackageLocale: en-US
Publisher: ${publisher}
PackageName: Ensemble CLI
License: FSL-1.1-MIT
LicenseUrl: https://github.com/ensemblework/ensemble/blob/main/LICENSE.md
ShortDescription: Ensemble CLI
Description: ${PACKAGE.description}
Moniker: ensemble
ManifestType: defaultLocale
ManifestVersion: 1.6.0
`;
}

function renderNfpm({ version, arch }) {
  return `name: ensemble-cli
arch: ${arch}
platform: linux
version: ${version}
section: utils
priority: optional
maintainer: EnsembleWork
description: ${PACKAGE.description}
homepage: ${PACKAGE.homepage}
license: FSL-1.1-MIT
recommends:
  - git
contents:
  - src: ./ensemble
    dst: /opt/ensemble-cli
    type: tree
  - src: /opt/ensemble-cli/bin/ensemble
    dst: /usr/bin/ensemble
    type: symlink
`;
}

function renderPkgbuild({ version, assets, urlFor, sha }) {
  return `# Maintainer: EnsembleWork
pkgname=ensemble-cli-bin
pkgver=${version}
pkgrel=1
pkgdesc="${bashString(PACKAGE.description)}"
arch=("x86_64" "aarch64")
url="${PACKAGE.homepage}"
license=("FSL-1.1-MIT")
depends=()
optdepends=("git: inspect local repositories")
source_x86_64=("ensemble-cli-$pkgver-linux-x64.tar.gz::${urlFor(assets.linuxX64)}")
source_aarch64=("ensemble-cli-$pkgver-linux-arm64.tar.gz::${urlFor(assets.linuxArm)}")
sha256sums_x86_64=("${sha(assets.linuxX64)}")
sha256sums_aarch64=("${sha(assets.linuxArm)}")

package() {
  install -d "$pkgdir/opt/ensemble-cli" "$pkgdir/usr/bin"
  cp -a "$srcdir/ensemble/." "$pkgdir/opt/ensemble-cli/"
  ln -s /opt/ensemble-cli/bin/ensemble "$pkgdir/usr/bin/ensemble"
  install -Dm644 "$srcdir/ensemble/LICENSE.md" "$pkgdir/usr/share/licenses/$pkgname/LICENSE.md"
}
`;
}

function renderSrcinfo({ version, assets, urlFor, sha }) {
  return `pkgbase = ensemble-cli-bin
\tpkgdesc = ${PACKAGE.description}
\tpkgver = ${version}
\tpkgrel = 1
\turl = ${PACKAGE.homepage}
\tarch = x86_64
\tarch = aarch64
\tlicense = FSL-1.1-MIT
\toptdepends = git: inspect local repositories
\tsource_x86_64 = ensemble-cli-${version}-linux-x64.tar.gz::${urlFor(assets.linuxX64)}
\tsha256sums_x86_64 = ${sha(assets.linuxX64)}
\tsource_aarch64 = ensemble-cli-${version}-linux-arm64.tar.gz::${urlFor(assets.linuxArm)}
\tsha256sums_aarch64 = ${sha(assets.linuxArm)}

pkgname = ensemble-cli-bin
`;
}

function rubyString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function bashString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$");
}

function parseCliArgs(args) {
  const parsed = { version: "", assetsDir: "", outDir: "packaging/out", baseUrl: "" };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--version") {
      parsed.version = requiredValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg.startsWith("--version=")) {
      parsed.version = arg.slice("--version=".length);
      continue;
    }
    if (arg === "--assets") {
      parsed.assetsDir = requiredValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg.startsWith("--assets=")) {
      parsed.assetsDir = arg.slice("--assets=".length);
      continue;
    }
    if (arg === "--out") {
      parsed.outDir = requiredValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg.startsWith("--out=")) {
      parsed.outDir = arg.slice("--out=".length);
      continue;
    }
    if (arg === "--base-url") {
      parsed.baseUrl = requiredValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg.startsWith("--base-url=")) {
      parsed.baseUrl = arg.slice("--base-url=".length);
      continue;
    }
    throw new Error(`Unknown option ${arg}.`);
  }
  return parsed;
}

function requiredValue(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseCliArgs(process.argv.slice(2));
    if (!args.version || !args.assetsDir) {
      throw new Error("Usage: node packaging/render.mjs --version <version> --assets <dir-with-SHA256SUMS.txt> [--out packaging/out] [--base-url URL]");
    }
    renderAll({
      version: args.version,
      assetsDir: resolve(args.assetsDir),
      outDir: resolve(args.outDir),
      ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
    });
    console.log(`Rendered packaging metadata to ${resolve(args.outDir)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
