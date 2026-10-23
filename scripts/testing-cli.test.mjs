import assert from "node:assert/strict";
import test from "node:test";
import { testingInstallers } from "./testing-cli.mjs";

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
