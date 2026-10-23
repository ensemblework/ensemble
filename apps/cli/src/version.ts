import { ENSEMBLE_VERSION } from "@ensemble/shared-types";
import { TESTING, TESTING_API, TESTING_APP } from "./channel.js";

declare const __ENSEMBLE_VERSION__: string | undefined;

export const VERSION = typeof __ENSEMBLE_VERSION__ === "string" ? __ENSEMBLE_VERSION__ : ENSEMBLE_VERSION;
export const DEFAULT_API_BASE = TESTING ? TESTING_API : "https://api.ensemblework.com";
export const DEFAULT_APP_URL = TESTING ? TESTING_APP : "https://ensemblework.com";
