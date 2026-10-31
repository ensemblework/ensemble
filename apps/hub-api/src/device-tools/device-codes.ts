/**
 * Sign-in codes a node's command prints (C2, docs/35 §8.16.4): `az login --use-device-code`, `gh auth
 * login`, AWS SSO, Google and any "open this page and enter the code" prompt. The command's output is
 * watched while it runs (foreground and background); each code found goes to the web, which shows it to
 * the owner on a card only they see, and the card follows the command's end. The code is the owner's:
 * the command they asked for printed it on their computer.
 */
import { stripAnsi } from "../capture/terminal.js";

export type DeviceCode = { url: string; code: string; expiresInMs: number | null };

/** What the watch keeps of the output to find a prompt split across chunks. */
const KEEP_CHARS = 4_000;
/** A code: letters and digits in groups (`FWQZ8N3XP`, `3F2A-9C1B`, `WDDD-HLQF`, `ABC-DEF-GHI`). */
const CODE = String.raw`([A-Z0-9]{4,12}(?:-[A-Z0-9]{3,8}){0,3})`;
const URL_TEXT = String.raw`(https?:\/\/[^\s"'<>]+)`;

const PATTERNS: RegExp[] = [
  // Microsoft (az, Azure PowerShell, Graph): "open the page https://microsoft.com/devicelogin and enter the code FWQZ8N3XP to authenticate."
  new RegExp(String.raw`open the page\s+${URL_TEXT}\s+and enter the code\s+${CODE}\b`, "i"),
  // Google and others: "Go to https://www.google.com/device and enter code ABCD-EFGH"
  new RegExp(String.raw`(?:visit|go to|open|navigate to|browse to)\s+${URL_TEXT}\s*(?:in (?:a|your) (?:web )?browser\s*)?(?:,|and|then)?\s*(?:enter|type|input|use)\s+(?:the |this |your )?(?:one-time |user |device |verification |authori[sz]ation )?code[:\s]+${CODE}\b`, "i"),
];

/** GitHub (gh): "First copy your one-time code: 3F2A-9C1B" then "…open https://github.com/login/device…", in either order. */
const ONE_TIME = new RegExp(String.raw`(?:one-time|user|device|verification) code(?: is)?[:\s]+${CODE}\b`, "i");
/** AWS SSO and others: "open the following URL: https://device.sso…/ Then enter the code: WDDD-HLQF". */
const ENTER_CODE = new RegExp(String.raw`enter (?:the |this )?code[:\s]+${CODE}\b`, "i");
/** A page made for entering a code. */
const DEVICE_PAGE = /\/(?:login\/)?device(?:login)?\b|\/activate\b|devicelogin|user_code=|\/device\/?$|\/code\b|sso\b/i;
/** A code in the address itself (AWS: `?user_code=WDDD-HLQF`). */
const CODE_IN_URL = /[?&]user_code=([A-Z0-9-]{4,20})/i;
const EXPIRES = /(?:expires?|valid|within)\s+(?:in\s+|for\s+)?(\d{1,4})\s*(seconds?|secs?|minutes?|mins?)\b/i;

/** Words a pattern can catch in place of a code. */
const NOT_A_CODE = /^(?:TO|THE|AND|CODE|FROM|THIS|YOUR|BELOW|ABOVE|SHOWN|DISPLAYED|PROVIDED|PROMPT)$/i;

const cleanUrl = (url: string) => url.replace(/[.,;:!?)\]}>]+$/, "");

function plausibleCode(code: string): boolean {
  if (NOT_A_CODE.test(code)) return false;
  // A code is upper case as printed (the patterns are case-insensitive): lower case is prose.
  if (code !== code.toUpperCase()) return false;
  const alnum = code.replace(/-/g, "");
  return alnum.length >= 6 && alnum.length <= 16;
}

function plausibleUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && !/^(?:localhost|127\.|\[::1\])/.test(parsed.hostname);
  } catch {
    return false;
  }
}

function expiresIn(text: string): number | null {
  const match = EXPIRES.exec(text);
  if (!match) return null;
  const amount = Number(match[1]);
  return /^s/i.test(match[2]!) ? amount * 1000 : amount * 60_000;
}

/** The sign-in codes in some output, each with the page it is entered on. */
export function deviceCodesIn(raw: string): DeviceCode[] {
  const text = stripAnsi(raw);
  const found: DeviceCode[] = [];
  const add = (url: string, code: string) => {
    const page = cleanUrl(url);
    if (!plausibleUrl(page) || !plausibleCode(code) || found.some((item) => item.code === code)) return;
    found.push({ url: page, code, expiresInMs: expiresIn(text) });
  };
  for (const pattern of PATTERNS) {
    const global = new RegExp(pattern.source, "gi");
    for (const match of text.matchAll(global)) add(match[1]!, match[2]!);
  }
  const urls = [...text.matchAll(new RegExp(URL_TEXT, "gi"))].map((match) => ({ url: cleanUrl(match[1]!), at: match.index ?? 0 }));
  for (const url of urls) {
    const inUrl = CODE_IN_URL.exec(url.url);
    if (inUrl) add(url.url, inUrl[1]!);
  }
  for (const pattern of [ONE_TIME, ENTER_CODE]) {
    for (const match of text.matchAll(new RegExp(pattern.source, "gi"))) {
      const code = match[1]!;
      const at = match.index ?? 0;
      // The page to enter it on: a code page near it (before or after, within a few lines).
      const near = urls.filter((url) => Math.abs(url.at - at) < 600 && DEVICE_PAGE.test(url.url)).sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0];
      if (near) add(near.url, code);
    }
  }
  return found;
}

/** Watches a command's output as it comes: each code once, as soon as its prompt is whole. */
export class DeviceCodeWatch {
  private tail = "";
  private readonly seen = new Set<string>();

  feed(chunk: string): DeviceCode[] {
    this.tail = (this.tail + chunk).slice(-KEEP_CHARS);
    const fresh = deviceCodesIn(this.tail).filter((item) => !this.seen.has(item.code));
    for (const item of fresh) this.seen.add(item.code);
    return fresh;
  }

  /** Codes found so far. */
  get count(): number {
    return this.seen.size;
  }
}
