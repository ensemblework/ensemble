export const TESTING_API = "https://api-test.ensemblework.com";
export const TESTING_APP = "https://test.ensemblework.com";

/** The testing client never accepts a production/custom server or a URL with credentials. */
export function cliApiBase(value: string, channel: "production" | "testing"): string {
  const base = value.trim().replace(/\/+$/, "");
  if (channel === "testing" && base !== TESTING_API) throw new Error(`The testing CLI connects only to ${TESTING_API}. Use ensemble for production.`);
  if (channel === "production" && base === TESTING_API) throw new Error("Use ensemble-test for the testing server; ensemble keeps its production account and runtime.");
  return base;
}
