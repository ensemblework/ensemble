import assert from "node:assert/strict";
import test from "node:test";
import { validateTestingEnv } from "./deploy.mjs";

const home = "/tmp/ensemble-test";
const env = {
  ENSEMBLE_SECRET_KEY: Buffer.alloc(32, 7).toString("base64"),
  DATABASE_URL: "postgresql://ensemble_test:example@127.0.0.1:25432/ensemble_test",
  REDIS_URL: "redis://:example@127.0.0.1:26379", NODE_ENV: "production",
  HUB_API_HOST: "127.0.0.1", HUB_API_PORT: "24000", HUB_WEB_ORIGIN: "https://test.ensemblework.com", HUB_API_PUBLIC_URL: "https://api-test.ensemblework.com",
  ENSEMBLE_COOKIE_NAMESPACE: "testing", ENSEMBLE_COOKIE_DOMAIN: "ensemblework.com",
  ENSEMBLE_SERVER_RUNNER: "off", ENSEMBLE_INPROCESS_RUNTIME: "1",
  ENSEMBLE_FILE_STORAGE: "azure-blob", AZURE_STORAGE_CONTAINER: "ensemble-test-files", ENSEMBLE_TEST_HOME: home,
  ENSEMBLE_WORKSPACE_ROOT: `${home}/state/workspace`, ENSEMBLE_MPLCONFIGDIR: `${home}/state/matplotlib`, ENSEMBLE_REMOTE_STATE_DIR: `${home}/state/remote`,
};
test("testing refuses production data, cookies, execution, file storage and Node website settings", () => {
  assert.equal(validateTestingEnv(env, home), env);
  assert.doesNotThrow(() => validateTestingEnv({ ...env, ENSEMBLE_NODE_WEB_ORIGIN: "https://node-test.ensemblework.com" }, home));
  for (const patch of [
    { DATABASE_URL: "postgresql://ensemble:example@127.0.0.1:15432/ensemble" },
    { REDIS_URL: "redis://:example@127.0.0.1:16379" },
    { ENSEMBLE_COOKIE_NAMESPACE: "" }, { ENSEMBLE_SERVER_RUNNER: "on" },
    { ENSEMBLE_SECRET_KEY: Buffer.alloc(32, 7).toString("hex") },
    { AZURE_STORAGE_CONTAINER: "ensemble-files" }, { ENSEMBLE_REMOTE_STATE_DIR: "/tmp/production/remote" },
    { ENSEMBLE_NODE_WEB_ORIGIN: "https://node.ensemblework.com" },
  ]) assert.throws(() => validateTestingEnv({ ...env, ...patch }, home));
});
