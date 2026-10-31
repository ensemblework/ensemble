/**
 * Keys from the owner's browser as Chromium's `Input.dispatchKeyEvent` takes them, for the clean
 * browser (browser/clean.ts), which has no Playwright keyboard. As a person's keyboard sends them, the
 * way Puppeteer types: a printable key or Enter is a `keyDown` with its text (Enter's is "\r"), so the
 * page gets keydown, keypress and input; Tab, Backspace, the arrows and the other editing keys are a
 * `rawKeyDown` without text; Shift, Control, Alt and Meta change the modifiers of the keys after them,
 * and with Control, Alt or Meta held a letter is a shortcut, not text. A character no US key makes
 * (é, ü, an emoji) is inserted as text. Names are `KeyboardEvent.key` values.
 */
import type { CleanPage } from "../browser/clean.js";

export type KeyDefinition = { key: string; code: string; keyCode: number; text?: string; location?: number };

const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

function table(): Map<string, KeyDefinition> {
  const keys = new Map<string, KeyDefinition>();
  const add = (definition: KeyDefinition) => keys.set(definition.key, definition);
  for (let code = 65; code <= 90; code += 1) {
    const upper = String.fromCharCode(code);
    const lower = upper.toLowerCase();
    add({ key: lower, code: `Key${upper}`, keyCode: code, text: lower });
    add({ key: upper, code: `Key${upper}`, keyCode: code, text: upper });
  }
  const shiftedDigits = ")!@#$%^&*(";
  for (let digit = 0; digit <= 9; digit += 1) {
    add({ key: String(digit), code: `Digit${digit}`, keyCode: 48 + digit, text: String(digit) });
    add({ key: shiftedDigits[digit]!, code: `Digit${digit}`, keyCode: 48 + digit, text: shiftedDigits[digit]! });
  }
  const punctuation: Array<[string, string, string, number]> = [
    ["-", "_", "Minus", 189],
    ["=", "+", "Equal", 187],
    ["[", "{", "BracketLeft", 219],
    ["]", "}", "BracketRight", 221],
    ["\\", "|", "Backslash", 220],
    [";", ":", "Semicolon", 186],
    ["'", '"', "Quote", 222],
    [",", "<", "Comma", 188],
    [".", ">", "Period", 190],
    ["/", "?", "Slash", 191],
    ["`", "~", "Backquote", 192],
  ];
  for (const [plain, shifted, code, keyCode] of punctuation) {
    add({ key: plain, code, keyCode, text: plain });
    add({ key: shifted, code, keyCode, text: shifted });
  }
  add({ key: " ", code: "Space", keyCode: 32, text: " " });
  add({ key: "Enter", code: "Enter", keyCode: 13, text: "\r" });
  const editing: Array<[string, number]> = [
    ["Tab", 9],
    ["Backspace", 8],
    ["Delete", 46],
    ["Escape", 27],
    ["ArrowLeft", 37],
    ["ArrowUp", 38],
    ["ArrowRight", 39],
    ["ArrowDown", 40],
    ["Home", 36],
    ["End", 35],
    ["PageUp", 33],
    ["PageDown", 34],
    ["Insert", 45],
  ];
  for (const [key, keyCode] of editing) add({ key, code: key, keyCode });
  for (let index = 1; index <= 12; index += 1) add({ key: `F${index}`, code: `F${index}`, keyCode: 111 + index });
  add({ key: "Shift", code: "ShiftLeft", keyCode: 16, location: 1 });
  add({ key: "Control", code: "ControlLeft", keyCode: 17, location: 1 });
  add({ key: "Alt", code: "AltLeft", keyCode: 18, location: 1 });
  add({ key: "Meta", code: "MetaLeft", keyCode: 91, location: 1 });
  return keys;
}

const KEYS = table();

/** The definition of a key by its `KeyboardEvent.key` name, or null for one no keyboard here makes. */
export function keyDefinition(key: string): KeyDefinition | null {
  return KEYS.get(key) ?? null;
}

/** Editing shortcuts a Mac takes as commands (`Input.dispatchKeyEvent`'s `commands`), as Chromium on macOS does not run them from a synthetic key. */
const MAC_COMMANDS: Record<string, string[]> = { KeyA: ["selectAll"], KeyC: ["copy"], KeyX: ["cut"], KeyV: ["paste"], KeyZ: ["undo"] };

export type KeyEvent = { type: "keyDown" | "rawKeyDown" | "keyUp"; key: string; code: string; keyCode: number; text?: string; modifiers: number; location?: number; autoRepeat?: boolean; commands?: string[] };

/** The keyboard of one page: which keys and modifiers are held, and the events a key down or up becomes. */
export class CleanKeyboard {
  private modifiers = 0;
  private readonly held = new Set<string>();

  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  /** The events for a key going down or up: none for a key no keyboard makes, `insert` for a character to insert as text. */
  events(type: "down" | "up", key: string): { events: KeyEvent[]; insert?: string } {
    const definition = keyDefinition(key);
    if (!definition) {
      // A character no US key makes: inserted as text when it goes down.
      if (type === "down" && [...key].length === 1 && key >= " ") return { events: [], insert: key };
      return { events: [] };
    }
    const bit = MODIFIER_BITS[definition.key] ?? 0;
    if (type === "up") {
      this.modifiers &= ~bit;
      this.held.delete(definition.code);
      return { events: [{ type: "keyUp", key: definition.key, code: definition.code, keyCode: definition.keyCode, modifiers: this.modifiers, ...(definition.location ? { location: definition.location } : {}) }] };
    }
    const autoRepeat = this.held.has(definition.code);
    this.held.add(definition.code);
    this.modifiers |= bit;
    // With Control, Alt or Meta held, a letter is a shortcut, not text.
    const text = this.modifiers & ~MODIFIER_BITS.Shift! ? undefined : definition.text;
    const commands = this.platform === "darwin" && this.modifiers & MODIFIER_BITS.Meta! ? (definition.code === "KeyZ" && this.modifiers & MODIFIER_BITS.Shift! ? ["redo"] : MAC_COMMANDS[definition.code]) : undefined;
    return {
      events: [
        {
          type: text ? "keyDown" : "rawKeyDown",
          key: definition.key,
          code: definition.code,
          keyCode: definition.keyCode,
          ...(text ? { text } : {}),
          modifiers: this.modifiers,
          ...(definition.location ? { location: definition.location } : {}),
          ...(autoRepeat ? { autoRepeat: true } : {}),
          ...(commands ? { commands } : {}),
        },
      ],
    };
  }

  /** The modifiers held now, for mouse events (1 Alt, 2 Control, 4 Meta, 8 Shift). */
  modifiersHeld(): number {
    return this.modifiers;
  }

  /** Sends a key down or up to a page. */
  async press(page: CleanPage, type: "down" | "up", key: string): Promise<void> {
    const { events, insert } = this.events(type, key);
    if (insert) await page.insertText(insert);
    for (const event of events) await page.key(event.type, event);
  }

  /** Lets go of every key still held. */
  async release(page: CleanPage): Promise<void> {
    for (const code of [...this.held]) {
      const definition = [...KEYS.values()].find((item) => item.code === code);
      if (definition) await this.press(page, "up", definition.key).catch(() => undefined);
    }
    this.held.clear();
    this.modifiers = 0;
  }
}
