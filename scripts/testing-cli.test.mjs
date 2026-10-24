import assert from "node:assert/strict";
import test from "node:test";
import { testingInstallers } from "./testing-cli.mjs";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("testing installers target a separate command, install root, release and version variables", () => {
  const { sh, ps1 } = testingInstallers();
  assert.match(sh, /link=\$HOME\/\.local\/bin\/ensemble-test/);
  assert.match(sh, /ensemble-test-cli-\$version-\$target/);
  assert.match(sh, /ENSEMBLE_TEST_VERSION/);
  assert.match(sh, /cli-testing-latest\/?["\n]/);
  assert.match(ps1, /Programs\\Ensemble Testing/);
  assert.match(ps1, /bin\\ensemble-test.exe/);
  assert.match(ps1, /ENSEMBLE_TEST_VERSION/);
  assert.match(ps1, /\$Selected = @\{ Version = \$TestVersion; Tag = "cli-testing-latest" \}/);
  for (const text of [sh, ps1]) {
    assert.doesNotMatch(text, /\bENSEMBLE_INSTALL_DIR\b|\bENSEMBLE_VERSION\b|\bENSEMBLE_DOWNLOAD_BASE\b/);
  }
});

test("package smoke initializes its channel before resolving either launcher, including legacy production packages", { skip: process.platform === "win32" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "ensemble-cli-smoke-regression-"));
  try {
    for (const channel of ["legacy", "production", "testing"]) {
      const root = join(temp, channel);
      await mkdir(join(root, "bin"), { recursive: true });
      await writeFile(join(root, "VERSION"), "0.4.9-testing.0\n");
      if (channel !== "legacy") await writeFile(join(root, "CHANNEL"), `${channel}\n`);
      const command = channel === "testing" ? "ensemble-test" : "ensemble";
      await writeFile(join(root, "bin", command), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.4.9-testing.0; else echo "testing only" >&2; exit 1; fi\n', { mode: 0o755 });
      execFileSync(process.execPath, ["scripts/smoke-cli-package.mjs", root, "--skip-mcp", "--skip-sidecar-health"], { stdio: "pipe" });
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
