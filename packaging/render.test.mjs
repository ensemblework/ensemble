import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderAll } from "./render.mjs";

const version = "0.1.0";

test("renders package-manager metadata from release checksums", () => {
  const root = mkdtempSync(join(tmpdir(), "ensemble-render-"));
  const assets = join(root, "assets");
  const out = join(root, "out");
  mkdirSync(assets);
  writeFileSync(
    join(assets, "SHA256SUMS.txt"),
    [
      `${"a".repeat(64)}  ensemble-cli-${version}-darwin-arm64.tar.gz`,
      `${"b".repeat(64)}  ensemble-cli-${version}-darwin-x64.tar.gz`,
      `${"c".repeat(64)}  ensemble-cli-${version}-linux-x64.tar.gz`,
      `${"d".repeat(64)}  ensemble-cli-${version}-linux-arm64.tar.gz`,
      `${"e".repeat(64)}  ensemble-cli-${version}-windows-x64.zip`,
      "",
    ].join("\n"),
  );

  renderAll({ version, assetsDir: assets, outDir: out, baseUrl: "https://example.test/releases" });

  const scoop = JSON.parse(readFileSync(join(out, "ensemble.json"), "utf8"));
  assert.equal(scoop.version, version);
  assert.equal(scoop.architecture["64bit"].extract_dir, "ensemble");
  assert.equal(scoop.architecture["64bit"].hash, "e".repeat(64));

  const formula = readFileSync(join(out, "ensemble.rb"), "utf8");
  assert.match(formula, /on_macos do/);
  assert.match(formula, /on_linux do/);
  assert.match(formula, /on_arm do/);
  assert.match(formula, /on_intel do/);
  assert.match(formula, /license "FSL-1.1-MIT"/);

  const wingetInstaller = readFileSync(join(out, "winget/EnsembleWork.EnsembleCLI.installer.yaml"), "utf8");
  assert.match(wingetInstaller, /PackageIdentifier: EnsembleWork\.EnsembleCLI/);
  assert.match(wingetInstaller, /InstallerType: zip/);
  assert.match(wingetInstaller, /NestedInstallerType: portable/);
  assert.match(wingetInstaller, /RelativeFilePath: ensemble\\bin\\ensemble\.exe/);
  assert.match(wingetInstaller, /PortableCommandAlias: ensemble/);
  assert.match(wingetInstaller, /ManifestVersion: 1\.6\.0/);

  const nfpm = readFileSync(join(out, "nfpm-amd64.yaml"), "utf8");
  assert.match(nfpm, /arch: amd64/);
  assert.match(nfpm, /dst: \/opt\/ensemble-cli/);
  assert.match(nfpm, /dst: \/usr\/bin\/ensemble/);

  const pkgbuild = readFileSync(join(out, "aur/PKGBUILD"), "utf8");
  assert.match(pkgbuild, /ensemble-cli-\$pkgver-linux-x64\.tar\.gz/);
  assert.match(pkgbuild, /sha256sums_aarch64/);
});
