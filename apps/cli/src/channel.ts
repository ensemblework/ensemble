import { cliApiBase, TESTING_API, TESTING_APP, TESTING_NODE } from "@ensemble/shared-types";

declare const __ENSEMBLE_CLI_CHANNEL__: string | undefined;
export const TESTING = typeof __ENSEMBLE_CLI_CHANNEL__ === "string" && __ENSEMBLE_CLI_CHANNEL__ === "testing";
export const COMMAND = TESTING ? "ensemble-test" : "ensemble";
export const MCP_NAME = TESTING ? "ensemble-test" : "ensemble";
export const TOKEN_ENV = TESTING ? "ENSEMBLE_TEST_TOKEN" : "ENSEMBLE_TOKEN";
export const DOWNLOAD_URL = TESTING ? "https://github.com/ensemblework/ensemble/releases/tag/cli-testing-latest" : "https://ensemblework.com/download";
export const TEST_RELEASE_BASE = "https://github.com/ensemblework/ensemble/releases/download/cli-testing-latest";
export { TESTING_API, TESTING_APP, TESTING_NODE };

export function channelApi(value: string): string {
  return cliApiBase(value, TESTING ? "testing" : "production");
}

export function channelApp(value: string): string {
  if (TESTING) {
    const url = new URL(value);
    if (url.origin !== TESTING_APP || url.username || url.password) throw new Error(`The testing CLI opens only ${TESTING_APP}.`);
  }
  return value;
}
