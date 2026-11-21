/**
 * The hard floor for desktop control: refused whoever asks and whatever the run's mode. An agent never
 * clicks, types or presses in Ensemble's own windows or on an Ensemble page in a browser (it could press
 * Allow on its own card), never types text that looks like a secret (secrets go by reference, `$NAME`,
 * and only into password fields), and never types into the desktop's own password prompts (polkit,
 * keyrings): those are the owner's, through desktop_handoff.
 *
 * On Wayland no app may learn where other windows are, so a click by position cannot be told apart by
 * the window it lands in: while an Ensemble window or page shows on the screen (not minimised), clicks
 * and drags by position are refused; element actions and the keyboard are judged by the window they act in.
 * Where the desktop says where each window is and which is in front (macOS), a click is judged by the window
 * at its point instead. A browser window whose page or address cannot be read may be showing Ensemble, so
 * it counts as one.
 */
import { ensembleAppOrigin } from "../../lib/ensemble-origins.js";
import { redactKeys } from "../../lib/redact.js";
import type { FocusInfo, HelperApp } from "./protocol.js";

export type FloorRule = "ensemble_window" | "ensemble_page" | "unknown_page" | "password_prompt" | "secret_text" | "secret_field";
export type FloorHit = { rule: FloorRule; message: string };

/** Ensemble's own apps as the accessibility bus and systemd name them. */
const ENSEMBLE_APPS = new Set(["ensemble", "ensemble-desktop", "ensemble desktop", "ensemble capture", "ensemble-capture", "quick-capture", "quick capture"]);
/** Ensemble's own window titles: its apps' windows, and Hub pages ("Today · Ensemble") in an app that is not a browser. */
const ENSEMBLE_TITLES = /^(?:ensemble|ensemble node|ensemble capture|quick capture|ensemble updates|.+ · ensemble(?: node)?)$/i;
/** A terminal showing the Ensemble CLI (`ensemble needs` answers cards). */
const CLI_TITLE = /^(?:\S*[/~]\S*\s*[:$#]?\s*)?ensemble(?:-test)?(?:\s|$)/i;
const TERMINALS = /\b(?:ptyxis|terminal|console|kgx|konsole|xterm|alacritty|kitty|wezterm|foot|tilix|terminator|ghostty|warp|iterm2?|hyper|tabby)\b/i;
/** `web`: an app that opens https links (LaunchServices) and is not a browser Ensemble knows by name. */
const BROWSER_TOOLKITS = /^(?:gecko|chromium|webkitgtk|webkit|web)$/i;

export const SECRET_REF = /^\$([A-Z][A-Z0-9_]{1,63})$/;

const norm = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();

type AppRef = { name: string; app_id: string | null; toolkit: string };

function ensembleApp(app: AppRef): boolean {
  const id = norm(app.app_id);
  return ENSEMBLE_APPS.has(norm(app.name)) || id.startsWith("com.ensemblework.") || ENSEMBLE_APPS.has(id);
}

/** Why a window of `app` titled `title` is Ensemble's own, or null. */
export function ensembleWindow(app: AppRef | null, title: string | null | undefined): string | null {
  if (!app) return null;
  const shown = (title ?? "").trim();
  const where = `${norm(app.name)} ${norm(app.app_id)}`;
  if (ensembleApp(app)) return `${app.name || "This app"} is Ensemble's own app`;
  if (TERMINALS.test(where)) return CLI_TITLE.test(shown) ? `the terminal “${shown}” runs Ensemble's command line` : null;
  if (ENSEMBLE_TITLES.test(shown) && !BROWSER_TOOLKITS.test(app.toolkit)) return `the window “${shown}” is Ensemble's own`;
  return null;
}

/** The Ensemble pages browsers show now (the tab in front of each window that is not minimised). */
export function ensemblePages(documents: FocusInfo["documents"] | undefined, env: NodeJS.ProcessEnv = process.env): Array<{ app: string; origin: string; window: string; active: boolean }> {
  const out: Array<{ app: string; origin: string; window: string; active: boolean }> = [];
  for (const doc of documents ?? []) {
    const origin = doc.url ? ensembleAppOrigin(doc.url, env) : null;
    if (origin) out.push({ app: doc.app, origin, window: doc.window, active: doc.active });
  }
  return out;
}

/** Browser windows whose page or address cannot be read now (the desktop said nothing about what they show). */
export function unknownPages(documents: FocusInfo["documents"] | undefined): Array<{ app: string; window: string; active: boolean }> {
  return (documents ?? []).filter((doc) => !doc.url).map((doc) => ({ app: doc.app, window: doc.window, active: doc.active }));
}

const UNKNOWN_PAGE = "its address cannot be read, so it may be showing Ensemble";

/** Keyboard input goes to the window in front: refused there when it is Ensemble's, an Ensemble page, a page that cannot be read or a password prompt of the desktop. */
export function keyboardFloor(focus: FocusInfo, env: NodeJS.ProcessEnv = process.env): FloorHit | null {
  if (focus.prompt) return { rule: "password_prompt", message: `A password prompt of the desktop is open (“${focus.prompt.title || "Authentication"}”): only your owner types there. Hand it to them with desktop_handoff.` };
  const own = ensembleWindow(focus.app, focus.window?.title);
  if (own) return { rule: "ensemble_window", message: `The window in front is Ensemble's own (${own}): you never type or click there.` };
  const page = ensemblePages(focus.documents, env).find((doc) => doc.active);
  if (page) return { rule: "ensemble_page", message: `The browser in front shows Ensemble (${page.origin}): you never type or click there. You act in Ensemble through your Ensemble tools.` };
  const unknown = unknownPages(focus.documents).find((doc) => doc.active);
  if (unknown) return { rule: "unknown_page", message: `The page in front in ${unknown.app} (“${unknown.window}”) cannot be read: ${UNKNOWN_PAGE}, and you never type there. Use your browser tools for web pages.` };
  return null;
}

export type Point = { x: number; y: number };
type ShownWindow = { app: HelperApp; window: HelperApp["windows"][number] };

/**
 * The window at `point` (screen pixels): the one furthest in front that shows and holds it; null when none
 * does (the menu bar, the desktop); undefined when the desktop does not say where its windows are.
 */
export function windowAt(apps: readonly HelperApp[], point: Point): ShownWindow | null | undefined {
  const shown = apps.flatMap((app) => app.windows.filter((window) => window.showing && !window.iconified).map((window) => ({ app, window })));
  if (!shown.length || shown.some(({ window }) => !window.box || typeof window.z !== "number")) return undefined;
  const hits = shown.filter(({ window }) => {
    const [x, y, width, height] = window.box!;
    return point.x >= x && point.x < x + width && point.y >= y && point.y < y + height;
  });
  return hits.sort((a, b) => b.window.z! - a.window.z!)[0] ?? null;
}

/** A click on `window` of `app`: refused in Ensemble's own window and on a page that is or may be Ensemble. */
function windowFloor(app: HelperApp, window: HelperApp["windows"][number], focus: FocusInfo, env: NodeJS.ProcessEnv): FloorHit | null {
  const terminal = TERMINALS.test(`${norm(app.name)} ${norm(app.app_id)}`);
  if (ensembleApp(app) || (!terminal && ensembleWindow(app, window.title))) {
    return { rule: "ensemble_window", message: `That point is in Ensemble's own window (“${window.title || app.name}”): you never click there.` };
  }
  const inWindow = (doc: { app: string; window: string }) => norm(doc.app) === norm(app.name) && norm(doc.window) === norm(window.title);
  const page = ensemblePages(focus.documents, env).find(inWindow);
  if (page) return { rule: "ensemble_page", message: `That point is in a browser window showing Ensemble (${page.origin}): you never click there. You act in Ensemble through your Ensemble tools.` };
  if (unknownPages(focus.documents).some(inWindow)) return { rule: "unknown_page", message: `That point is in a ${app.name} window (“${window.title}”) whose page cannot be read: ${UNKNOWN_PAGE}. Use your browser tools for web pages.` };
  return null;
}

/**
 * Clicks and drags by position at `points`: judged by the window at each point where the desktop says
 * (macOS); elsewhere refused while an Ensemble window or page shows on the screen, since the desktop does not
 * say which window a point is in.
 */
export function pointerFloor(focus: FocusInfo, apps: readonly HelperApp[], env: NodeJS.ProcessEnv = process.env, points: readonly Point[] = []): FloorHit | null {
  const front = keyboardFloor(focus, env);
  const hits = points.map((point) => windowAt(apps, point));
  if (hits.length && hits.every((hit) => hit !== undefined)) {
    for (const hit of hits) {
      // Outside every window (the menu bar): what is there belongs to the app in front.
      const found = hit ? windowFloor(hit.app, hit.window, focus, env) : front && front.rule !== "password_prompt" ? front : null;
      if (found) return found;
    }
    return null;
  }
  if (front && front.rule !== "password_prompt") return front;
  for (const app of apps) {
    // The command line in a terminal answers with the keyboard only: a click there presses nothing.
    const terminal = TERMINALS.test(`${norm(app.name)} ${norm(app.app_id)}`);
    for (const window of app.windows) {
      if (!window.showing || window.iconified) continue;
      if (ensembleApp(app) || (!terminal && ensembleWindow(app, window.title))) {
        return { rule: "ensemble_window", message: `Ensemble's own window (“${window.title || app.name}”) is open on the screen, and the desktop does not say where it is, so clicks by position are refused while it shows. Use element ids (press, set_text, focus), or ask your owner to minimise it.` };
      }
    }
  }
  const page = ensemblePages(focus.documents, env)[0];
  if (page) return { rule: "ensemble_page", message: `A browser window shows Ensemble (${page.origin}) and the desktop does not say where it is, so clicks by position are refused while it shows. Use element ids, or ask your owner to switch that tab or minimise the window.` };
  const unknown = unknownPages(focus.documents)[0];
  if (unknown) return { rule: "unknown_page", message: `A ${unknown.app} window (“${unknown.window}”) shows a page whose address cannot be read: ${UNKNOWN_PAGE}, and the desktop does not say where it is, so clicks by position are refused while it shows. Use element ids in other apps, your browser tools for web pages, or ask your owner to minimise it.` };
  return null;
}

/** An element action in `app`'s window titled `window`: refused in Ensemble's windows and on Ensemble pages. */
export function elementFloor(app: AppRef, window: string, focus: FocusInfo, env: NodeJS.ProcessEnv = process.env): FloorHit | null {
  const own = ensembleWindow(app, window);
  if (own) return { rule: "ensemble_window", message: `That element is in Ensemble's own window (${own}): you never act there.` };
  const inWindow = (doc: { app: string; window: string }) => norm(doc.window) === norm(window) && norm(doc.app) === norm(app.name);
  const page = ensemblePages(focus.documents, env).find(inWindow);
  if (page) return { rule: "ensemble_page", message: `That element is in a browser window showing Ensemble (${page.origin}): you never act there.` };
  if (unknownPages(focus.documents).some(inWindow)) return { rule: "unknown_page", message: `That element is in a browser window whose page cannot be read: ${UNKNOWN_PAGE}. Use your browser tools for web pages.` };
  return null;
}

/** Whether text looks like a secret: a saved secret's value in it, or a known key or token shape. */
export function looksSecret(text: string, savedValues: readonly string[]): boolean {
  if (!text) return false;
  if (savedValues.some((value) => value.length >= 6 && text.includes(value))) return true;
  return redactKeys(text) !== text;
}

export const SECRET_TEXT_MESSAGE =
  "That text looks like a secret (a saved secret's value or a key's shape). Secrets are never typed as plain text: type a saved secret by its name ($NAME) into a password field, or hand the field to your owner with desktop_handoff.";
