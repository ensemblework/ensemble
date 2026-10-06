declare const __ENSEMBLE_VERSION__: string | undefined;

export const VERSION = typeof __ENSEMBLE_VERSION__ === "string" ? __ENSEMBLE_VERSION__ : "0.1.0";
export const DEFAULT_API_BASE = "https://api.ensemblework.com";
export const DEFAULT_APP_URL = "https://ensemblework.com";
