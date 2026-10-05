export function desktopDiscoveryPath(input: {
  platform: string;
  home: string;
  env?: { APPDATA?: string; XDG_DATA_HOME?: string; ENSEMBLE_DISCOVERY_FILE?: string };
}): string;

export function parseDesktopDiscovery(raw: string): { port: number; token: string } | null;

export function resolveHookTarget(input: {
  configUrl?: string;
  configToken?: string;
  discovery: { port: number; token: string } | null;
}): { base: string; token: string };

export function readDesktopDiscovery(env?: NodeJS.ProcessEnv): { port: number; token: string } | null;
