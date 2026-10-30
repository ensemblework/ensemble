/**
 * What this computer tells the web about credentials (B12, docs/35 §8.7): the public key the web
 * encrypts secrets for (`sealKey`), how coding-agent runs here get saved secrets (`secretsMode`), and
 * that a node may use a secret by reference here (`secretHttp`).
 */
import type { SealKeyInfo } from "@ensemble/shared-types";
import type { RemoteSettings } from "../remote/store.js";
import { sealKeyCapability } from "./seal-key.js";

/** `capabilities.secretHttp`: this computer answers `node.tool.request` with `tool: "secret_http"`. */
export const SECRET_HTTP_API = 1;

export function credentialCapabilities(settings: Pick<RemoteSettings, "pairedAt" | "deviceId" | "secretsMode">): { sealKey: SealKeyInfo | null; secretsMode: "all" | "named"; secretHttp: number } {
  return { sealKey: sealKeyCapability(settings), secretsMode: settings.secretsMode, secretHttp: SECRET_HTTP_API };
}
