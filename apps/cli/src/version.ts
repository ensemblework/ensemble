import { ENSEMBLE_VERSION } from "@ensemble/shared-types";

declare const __ENSEMBLE_VERSION__: string | undefined;

export const VERSION = typeof __ENSEMBLE_VERSION__ === "string" ? __ENSEMBLE_VERSION__ : ENSEMBLE_VERSION;
export const DEFAULT_API_BASE = "https://api.ensemblework.com";
export const DEFAULT_APP_URL = "https://ensemblework.com";
