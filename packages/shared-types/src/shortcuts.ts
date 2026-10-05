import captureChordFile from "./capture-chord.json" with { type: "json" };

/**
 * Every keyboard binding in the Hub lives here.
 * Edit this list — the help sheet, the command palette, and the key listener read it.
 *
 * The global capture chord is `capture-chord.json` in this folder. The Hub and the
 * desktop shell both read that file, so a native port does not keep a second copy.
 *
 * Rules:
 * - `mod` is Command on macOS and Control on Windows and Linux.
 * - Never bind OS shortcuts: Cmd/Ctrl+Q, Cmd/Ctrl+W, Cmd+Tab, Ctrl+Alt+Delete, Alt+F4.
 * - Never bind the Super key (the Windows key, or a bare Meta chord on Linux).
 * - Command on macOS is allowed only for in-app chords that are not the OS list above.
 * - Left-hand sequences (`g` then a letter, and `c`) avoid the right-hand cluster and the OS keys.
 * - Alt+Shift+T cycles starred code themes. It is not Ctrl+Alt+T, which opens a terminal on Linux.
 */

function chordFromTokens(tokens: readonly string[], key: string): ShortcutChord {
  const chord: ShortcutChord = { key };
  for (const token of tokens) {
    if (token === "mod") chord.mod = true;
    else if (token === "ctrl") chord.ctrl = true;
    else if (token === "alt") chord.alt = true;
    else if (token === "shift") chord.shift = true;
    else throw new Error(`Unknown modifier “${token}” in capture-chord.json`);
  }
  return chord;
}

export type ShortcutScope = "global" | "today" | "diagrams";

export interface ShortcutChord {
  key: string;
  /** Command on macOS, Control on Windows and Linux. */
  mod?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  /** Physical Meta/Super. Forbidden on Windows and Linux bindings. */
  meta?: boolean;
}

export interface ShortcutBinding {
  id: string;
  label: string;
  group: string;
  scope: ShortcutScope;
  /** Also fires while the cursor is in a text field. */
  whileTyping: boolean;
  mac: ShortcutChord | null;
  other: ShortcutChord | null;
  /** Lowercase keys, in order. No modifiers. */
  sequence?: string[];
}

/**
 * Alt+Shift+T cycles starred code themes. It avoids Ctrl/Cmd chords Ensemble and
 * the browser already use, and it avoids Ctrl+Alt+T, which opens a terminal on Linux.
 */
export const CYCLE_FAVOURITE_THEMES = {
  id: "ide.cycleFavouriteThemes",
  label: "Switch to the next starred theme",
  key: "t",
  alt: true,
  shift: true,
  ctrl: false,
  meta: false,
} as const;

const themeChord: ShortcutChord = {
  key: CYCLE_FAVOURITE_THEMES.key,
  alt: CYCLE_FAVOURITE_THEMES.alt,
  shift: CYCLE_FAVOURITE_THEMES.shift,
};

export const SHORTCUTS: readonly ShortcutBinding[] = [
  {
    id: "palette",
    label: "Command palette",
    group: "Everywhere",
    scope: "global",
    whileTyping: true,
    mac: { key: "k", mod: true },
    other: { key: "k", mod: true },
  },
  {
    id: "help",
    label: "Shortcut help",
    group: "Everywhere",
    scope: "global",
    whileTyping: false,
    mac: { key: "?", shift: true },
    other: { key: "?", shift: true },
  },
  {
    id: "capture",
    label: "Quick capture",
    group: "Everywhere",
    scope: "global",
    whileTyping: true,
    mac: chordFromTokens(captureChordFile.darwin, captureChordFile.key),
    other: chordFromTokens(captureChordFile.other, captureChordFile.key),
  },
  {
    id: "capture-key",
    label: "Quick capture",
    group: "Everywhere",
    scope: "global",
    whileTyping: false,
    mac: null,
    other: null,
    sequence: ["c"],
  },
  {
    id: "ask",
    label: "Ask Ensemble",
    group: "Everywhere",
    scope: "global",
    whileTyping: false,
    mac: { key: "a", alt: true },
    other: { key: "a", alt: true },
  },
  {
    id: "undo",
    label: "Undo",
    group: "Everywhere",
    scope: "global",
    whileTyping: false,
    mac: { key: "z", mod: true },
    other: { key: "z", mod: true },
  },
  {
    id: "redo",
    label: "Redo",
    group: "Everywhere",
    scope: "global",
    whileTyping: false,
    mac: { key: "z", mod: true, shift: true },
    other: { key: "z", mod: true, shift: true },
  },
  {
    id: "assistant",
    label: "Open or close the assistant",
    group: "Everywhere",
    scope: "global",
    whileTyping: false,
    mac: { key: "j", mod: true },
    other: { key: "j", mod: true },
  },
  {
    id: CYCLE_FAVOURITE_THEMES.id,
    label: "Next starred code theme",
    group: "Code",
    scope: "global",
    whileTyping: false,
    mac: themeChord,
    other: themeChord,
  },
  {
    id: "go-today",
    label: "Go to Today",
    group: "Go to",
    scope: "global",
    whileTyping: false,
    mac: null,
    other: null,
    sequence: ["g", "t"],
  },
  {
    id: "go-board",
    label: "Go to Board",
    group: "Go to",
    scope: "global",
    whileTyping: false,
    mac: null,
    other: null,
    sequence: ["g", "b"],
  },
  {
    id: "go-needs",
    label: "Go to Needs me",
    group: "Go to",
    scope: "global",
    whileTyping: false,
    mac: null,
    other: null,
    sequence: ["g", "n"],
  },
  {
    id: "go-meetings",
    label: "Go to Meeting notes",
    group: "Go to",
    scope: "global",
    whileTyping: false,
    mac: null,
    other: null,
    sequence: ["g", "m"],
  },
  {
    id: "go-recap",
    label: "Go to Weekly recap",
    group: "Go to",
    scope: "global",
    whileTyping: false,
    mac: null,
    other: null,
    sequence: ["g", "r"],
  },
  {
    id: "go-settings",
    label: "Go to Settings",
    group: "Go to",
    scope: "global",
    whileTyping: false,
    mac: null,
    other: null,
    sequence: ["g", "s"],
  },
  {
    id: "go-diagrams",
    label: "Go to Block Diagrams",
    group: "Go to",
    scope: "global",
    whileTyping: false,
    mac: null,
    other: null,
    sequence: ["g", "d"],
  },
  {
    id: "go-plots",
    label: "Go to Plots",
    group: "Go to",
    scope: "global",
    whileTyping: false,
    mac: null,
    other: null,
    sequence: ["g", "p"],
  },
  {
    id: "diagram-reorganize",
    label: "Reorganize the diagram",
    group: "Diagrams",
    scope: "diagrams",
    whileTyping: false,
    mac: { key: "r", alt: true, shift: true },
    other: { key: "r", alt: true, shift: true },
  },
  {
    id: "diagram-lock",
    label: "Lock or unlock the selection",
    group: "Diagrams",
    scope: "diagrams",
    whileTyping: false,
    mac: { key: "l", alt: true, shift: true },
    other: { key: "l", alt: true, shift: true },
  },
  {
    id: "diagram-text",
    label: "Add a text box",
    group: "Diagrams",
    scope: "diagrams",
    whileTyping: false,
    mac: { key: "n", alt: true, shift: true },
    other: { key: "n", alt: true, shift: true },
  },
  {
    id: "diagram-focus",
    label: "Canvas only",
    group: "Diagrams",
    scope: "diagrams",
    whileTyping: false,
    mac: { key: "f", alt: true, shift: true },
    other: { key: "f", alt: true, shift: true },
  },
  {
    id: "diagram-focus-exit",
    label: "Leave canvas only",
    group: "Diagrams",
    scope: "diagrams",
    whileTyping: false,
    mac: { key: "escape" },
    other: { key: "escape" },
  },
  {
    id: "diagram-comment",
    label: "Comment or uncomment the diagram line",
    group: "Diagrams",
    scope: "diagrams",
    whileTyping: true,
    mac: { key: "/", mod: true },
    other: { key: "/", mod: true },
  },
  {
    id: "diagram-format",
    label: "Format the diagram text",
    group: "Diagrams",
    scope: "diagrams",
    whileTyping: true,
    mac: { key: "i", alt: true, shift: true },
    other: { key: "i", alt: true, shift: true },
  },
  {
    id: "diagram-delete",
    label: "Delete the selection",
    group: "Diagrams",
    scope: "diagrams",
    whileTyping: false,
    mac: { key: "delete" },
    other: { key: "delete" },
  },
  {
    id: "diagram-backspace",
    label: "Delete the selection",
    group: "Diagrams",
    scope: "diagrams",
    whileTyping: false,
    mac: { key: "backspace" },
    other: { key: "backspace" },
  },
  {
    id: "today-down",
    label: "Next proposed todo",
    group: "Today",
    scope: "today",
    whileTyping: false,
    mac: null,
    other: null,
    sequence: ["j"],
  },
  {
    id: "today-up",
    label: "Previous proposed todo",
    group: "Today",
    scope: "today",
    whileTyping: false,
    mac: null,
    other: null,
    sequence: ["k"],
  },
  {
    id: "today-mine",
    label: "I'll do it",
    group: "Today",
    scope: "today",
    whileTyping: false,
    mac: null,
    other: null,
    sequence: ["m"],
  },
  {
    id: "today-agent",
    label: "Agent does it",
    group: "Today",
    scope: "today",
    whileTyping: false,
    mac: null,
    other: null,
    sequence: ["a"],
  },
  {
    id: "today-later",
    label: "Later",
    group: "Today",
    scope: "today",
    whileTyping: false,
    mac: null,
    other: null,
    sequence: ["l"],
  },
  {
    id: "today-drop",
    label: "Drop",
    group: "Today",
    scope: "today",
    whileTyping: false,
    mac: null,
    other: null,
    sequence: ["d"],
  },
  {
    id: "today-open",
    label: "Open the task",
    group: "Today",
    scope: "today",
    whileTyping: false,
    mac: null,
    other: null,
    sequence: ["o"],
  },
];

const RESERVED = new Set([
  "mod+q",
  "mod+w",
  "mod+tab",
  "meta+q",
  "meta+w",
  "meta+tab",
  "ctrl+q",
  "ctrl+w",
  "ctrl+alt+delete",
  "ctrl+alt+del",
  "ctrl+alt+t",
  "alt+f4",
  "meta",
  "super",
]);

export function chordToken(chord: ShortcutChord): string {
  const parts: string[] = [];
  if (chord.mod) parts.push("mod");
  if (chord.meta) parts.push("meta");
  if (chord.ctrl) parts.push("ctrl");
  if (chord.alt) parts.push("alt");
  if (chord.shift) parts.push("shift");
  parts.push(chord.key.toLowerCase());
  return parts.join("+");
}

export function shortcutProblems(list: readonly ShortcutBinding[] = SHORTCUTS): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const chords = new Map<string, string>();
  const sequences = new Map<string, string>();
  for (const binding of list) {
    if (ids.has(binding.id)) problems.push(`Duplicate shortcut id ${binding.id}`);
    ids.add(binding.id);
    for (const [platform, chord] of [
      ["mac", binding.mac],
      ["windows/linux", binding.other],
    ] as const) {
      if (!chord) continue;
      if (platform !== "mac" && chord.meta) {
        problems.push(`${binding.id} uses the Super key on ${platform}`);
      }
      const token = chordToken(chord);
      if (RESERVED.has(token) || token.startsWith("super")) {
        problems.push(`${binding.id} binds reserved chord ${token} on ${platform}`);
      }
      const slot = `${platform}:${token}`;
      const prior = chords.get(slot);
      if (prior) problems.push(`${binding.id} collides with ${prior} on ${platform}: ${token}`);
      else chords.set(slot, binding.id);
    }
    if (binding.sequence?.some((key) => key.length !== 1 || key !== key.toLowerCase())) {
      problems.push(`${binding.id} sequence must be single lowercase keys`);
    }
    if (binding.sequence?.length) {
      const slot = `${binding.scope}:${binding.sequence.join(" ")}`;
      const prior = sequences.get(slot);
      if (prior) problems.push(`${binding.id} collides with ${prior}: sequence ${binding.sequence.join(" ")}`);
      else sequences.set(slot, binding.id);
    }
  }
  return problems;
}

const MOD_LABEL: Record<string, string> = { mod: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧", meta: "Super" };
const MOD_LABEL_OTHER: Record<string, string> = { mod: "Ctrl", ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Super" };

export function formatChord(chord: ShortcutChord | null, apple: boolean): string {
  if (!chord) return "";
  const labels = apple ? MOD_LABEL : MOD_LABEL_OTHER;
  const parts: string[] = [];
  if (chord.mod) parts.push(labels.mod!);
  if (chord.ctrl && !(chord.mod && !apple)) parts.push(labels.ctrl!);
  if (chord.ctrl && chord.mod && !apple) parts.push("Ctrl");
  if (chord.alt) parts.push(labels.alt!);
  if (chord.shift) parts.push(labels.shift!);
  if (chord.meta) parts.push(labels.meta!);
  const key = chord.key.length === 1 ? chord.key.toUpperCase() : chord.key;
  parts.push(key);
  return apple ? parts.join("") : parts.join("+");
}

export function formatBinding(binding: ShortcutBinding, apple: boolean): string {
  if (binding.sequence?.length) {
    const typed = binding.sequence.map((key) => key.toUpperCase()).join(" then ");
    const chord = formatChord(apple ? binding.mac : binding.other, apple);
    return chord ? `${typed} · ${chord}` : typed;
  }
  return formatChord(apple ? binding.mac : binding.other, apple);
}

export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function eventMatchesChord(event: KeyEventLike, chord: ShortcutChord, apple: boolean): boolean {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase();
  if (key !== chord.key.toLowerCase()) return false;
  const wantMeta = Boolean(chord.meta) || (Boolean(chord.mod) && apple);
  const wantCtrl = Boolean(chord.ctrl) || (Boolean(chord.mod) && !apple);
  if (wantMeta !== event.metaKey) return false;
  if (wantCtrl !== event.ctrlKey) return false;
  if (Boolean(chord.alt) !== event.altKey) return false;
  if (Boolean(chord.shift) !== event.shiftKey && chord.key !== "?") return false;
  if (chord.key === "?" && !event.shiftKey) return false;
  return true;
}

export function matchShortcut(
  event: KeyEventLike,
  apple: boolean,
  typing: boolean,
  list: readonly ShortcutBinding[] = SHORTCUTS,
): ShortcutBinding | null {
  for (const binding of list) {
    if (binding.scope !== "global") continue;
    if (binding.sequence) continue;
    if (typing && !binding.whileTyping) continue;
    const chord = apple ? binding.mac : binding.other;
    if (!chord) continue;
    if (eventMatchesChord(event, chord, apple)) return binding;
  }
  return null;
}

export function isCycleFavouriteThemesShortcut(event: {
  key: string;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): boolean {
  return (
    event.key.toLowerCase() === CYCLE_FAVOURITE_THEMES.key &&
    event.altKey === CYCLE_FAVOURITE_THEMES.alt &&
    event.shiftKey === CYCLE_FAVOURITE_THEMES.shift &&
    event.ctrlKey === CYCLE_FAVOURITE_THEMES.ctrl &&
    event.metaKey === CYCLE_FAVOURITE_THEMES.meta
  );
}
