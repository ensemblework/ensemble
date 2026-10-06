import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTestDirectory(prefix: string): string {
  // macOS's default /var/folders is intentionally not an agent work-folder grant.
  const root = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  return realpathSync(mkdtempSync(join(root, prefix)));
}
