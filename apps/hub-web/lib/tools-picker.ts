/**
 * The Tools picker's choices as a list of what is off (@ensemble/shared-types tools-off.ts): an app's key
 * or `<app>/<tool>`. Turning an app off drops its tool entries; turning its last tool off becomes the app.
 */
import { toolOffKey, type ToolCatalogApp } from "@ensemble/shared-types";

const usable = (app: ToolCatalogApp) => app.tools.filter((tool) => !tool.blocked);

/** Whether this tool is on under these choices (the connection's own blocks aside). */
export function toolIsOn(off: readonly string[], app: ToolCatalogApp, tool: string): boolean {
  return !off.includes(app.key) && !off.includes(toolOffKey(app.key, tool));
}

/** How many of the app's usable tools are on. */
export function toolsOnCount(off: readonly string[], app: ToolCatalogApp): number {
  return usable(app).filter((tool) => toolIsOn(off, app, tool.name)).length;
}

/** The app as a whole: on (some tool on) or off. */
export function appIsOn(off: readonly string[], app: ToolCatalogApp): boolean {
  if (off.includes(app.key)) return false;
  const tools = usable(app);
  return !tools.length || tools.some((tool) => toolIsOn(off, app, tool.name));
}

const withoutApp = (off: readonly string[], key: string) => off.filter((entry) => entry !== key && !entry.startsWith(`${key}/`));

export function setApp(off: readonly string[], app: ToolCatalogApp, on: boolean): string[] {
  const rest = withoutApp(off, app.key);
  return on ? rest : [...rest, app.key];
}

export function setTool(off: readonly string[], app: ToolCatalogApp, tool: string, on: boolean): string[] {
  const tools = usable(app).map((row) => row.name);
  // The app's tools that stay off besides this one, spelled out one by one.
  const othersOff = off.includes(app.key) ? tools.filter((name) => name !== tool) : tools.filter((name) => name !== tool && !toolIsOn(off, app, name));
  const nextOff = on ? othersOff : [...othersOff, tool];
  const rest = withoutApp(off, app.key);
  if (tools.length && nextOff.length >= tools.length) return [...rest, app.key];
  return [...rest, ...nextOff.map((name) => toolOffKey(app.key, name))];
}

/** Off entries that name something in the catalog: how many apps are wholly off, and how many single tools. */
export function offSummary(off: readonly string[], apps: readonly ToolCatalogApp[]): { apps: number; tools: number } {
  let wholly = 0;
  let single = 0;
  for (const app of apps) {
    if (!appIsOn(off, app)) wholly += 1;
    else single += usable(app).length - toolsOnCount(off, app);
  }
  return { apps: wholly, tools: single };
}

/** One short phrase for the trigger: "All on", "2 apps off", "1 app, 3 tools off". */
export function offLabel(off: readonly string[], apps: readonly ToolCatalogApp[] | undefined): string {
  if (!apps || !off.length) return "All on";
  const { apps: wholly, tools } = offSummary(off, apps);
  const parts = [wholly ? `${wholly} ${wholly === 1 ? "app" : "apps"}` : "", tools ? `${tools} ${tools === 1 ? "tool" : "tools"}` : ""].filter(Boolean);
  return parts.length ? `${parts.join(", ")} off` : "All on";
}
