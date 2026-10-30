/**
 * The owner's privacy rules as this computer's runtime gives them to the browser broker and the
 * capture service (capture/runtime.ts): the values of the saved secrets, and the sites kept on this
 * computer as never captured or previewed first (`ensemble capture sites`).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const scratch = mkdtempSync(join(homedir(), ".ensemble-capture-runtime-"));
process.env.ENSEMBLE_REMOTE_STATE_DIR = scratch;
process.env.ENSEMBLE_SECRET_KEY = randomBytes(32).toString("base64");
process.env.DATABASE_URL ??= "postgresql://localhost/unused";
const { privacyRules } = await import("./runtime.js");
const { updateSettings, loadSettings } = await import("../remote/store.js");
const { encrypt } = await import("../lib/secrets.js");
after(() => rmSync(scratch, { recursive: true, force: true }));

test("the rules are the saved secret values and this computer's site lists", async () => {
  assert.deepEqual(loadSettings().captureSites, { never: [], preview: [] }, "none until the owner adds some");
  updateSettings({ captureSites: { never: ["mybank.com"], preview: ["https://mail.example.com"] } });
  let reads = 0;
  const prisma = {
    runSecret: {
      findMany: async () => {
        reads += 1;
        return [{ name: "STRIPE_KEY", value: encrypt("sk_live_secret_value") }];
      },
    },
  };
  const rules = privacyRules(prisma as never, "owner");
  const first = await rules();
  assert.deepEqual(first, { secretValues: ["sk_live_secret_value"], neverCapture: ["mybank.com"], previewFirst: ["https://mail.example.com"] });
  updateSettings({ captureSites: { never: [], preview: ["docs.example.com"] } });
  const second = await rules();
  assert.deepEqual(second.previewFirst, ["docs.example.com"], "a change to the lists applies at once");
  assert.equal(reads, 1, "the secrets are read again only every few seconds");
});
