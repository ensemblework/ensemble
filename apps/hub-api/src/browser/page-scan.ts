/**
 * Privacy checks against a live page (rules in privacy.ts): which origins its frames show, its
 * text and field values, and which snapshot fields hold a password or code. Only the runtime's
 * own fixed functions run in the page; secret values never enter it.
 *
 * Functions passed to `evaluate` are serialised into the page: they must not define named inner
 * functions (tsx adds a `__name` helper the page does not have).
 */
import type { Locator, Page } from "playwright-core";
import type { PageElement, PageWindow } from "./page-world.js";
import { findSecrets, redactSnapshot, SENSITIVE_SELECTOR, siteRule, valueFieldRefs, type PrivacyRules, type SecretHits } from "./privacy.js";

const MAX_TEXT = 2_000_000;
const MAX_FRAMES = 20;

type FrameText = { text: string; exposed: number; passwords: number };

/** Runs in the page: visible text, field values (never password values), and visible code fields with a value. */
function readFrame([selector, max]: [string, number]): FrameText {
  const w = globalThis as unknown as PageWindow;
  const parts: string[] = [w.document.title, w.document.body ? w.document.body.innerText : ""];
  let exposed = 0;
  let passwords = 0;
  const fields = w.document.querySelectorAll("input, textarea");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (!field.value) continue;
    const type = (field.getAttribute("type") ?? "").toLowerCase();
    if (type === "password") passwords += 1;
    if (type === "password" || type === "hidden") continue;
    parts.push(field.value);
    const visible = field.getClientRects().length > 0 && w.getComputedStyle(field).visibility !== "hidden";
    if (visible && field.matches(selector)) exposed += 1;
  }
  return { text: parts.join("\n").slice(0, max), exposed, passwords };
}

export type PageScan = {
  /** The strictest owner rule among the page's frames: the main frame's, or "preview" for a sub-frame marked never. */
  site: "never" | "preview" | null;
  hits: SecretHits;
  /** Visible code or card fields that show their value (masked in screenshots, not in screencast frames). */
  exposedFields: number;
  /** Password fields with a value: drawn as dots, but kept in a trace's page snapshots. */
  filledPasswords: number;
};

export async function scanPage(page: Page, rules: PrivacyRules): Promise<PageScan> {
  const main = siteRule(page.url(), rules);
  let site: PageScan["site"] = main;
  const texts: string[] = [];
  let exposedFields = 0;
  let filledPasswords = 0;
  for (const frame of page.frames().slice(0, MAX_FRAMES)) {
    if (frame !== page.mainFrame()) {
      const rule = siteRule(frame.url(), rules);
      if (rule && site !== "never") site = "preview";
    }
    const read = await frame.evaluate(readFrame, [SENSITIVE_SELECTOR, MAX_TEXT] as [string, number]).catch(() => null);
    if (!read) continue;
    texts.push(read.text);
    exposedFields += read.exposed;
    filledPasswords += read.passwords;
  }
  return { site, hits: findSecrets(texts.join("\n"), rules), exposedFields, filledPasswords };
}

/** Runs in the page: is this field one whose value a snapshot must not show? */
function isSensitive(element: PageElement, selector: string): boolean {
  return element.matches(selector) || element.closest("[data-ensemble-sensitive], [data-sensitive]") !== null;
}

/** Of the snapshot's fields that show a value, those that are password, code or marked fields. */
export async function sensitiveSnapshotRefs(page: Page, snapshot: string, limit = 200): Promise<{ refs: Set<string>; unchecked: string[] }> {
  const candidates = valueFieldRefs(snapshot);
  const refs = new Set<string>();
  const unchecked: string[] = [];
  for (const [index, ref] of candidates.entries()) {
    if (index >= limit) {
      unchecked.push(ref);
      continue;
    }
    const sensitive = await page
      .locator(`aria-ref=${ref}`)
      .evaluate(isSensitive, SENSITIVE_SELECTOR, { timeout: 2_000 })
      .catch(() => true);
    if (sensitive) refs.add(ref);
  }
  return { refs, unchecked };
}

/** The page's aria snapshot (with refs) as a model may read it: sensitive field values and secrets hidden. */
export async function readableSnapshot(page: Page, rules: PrivacyRules, timeout = 15_000): Promise<string> {
  const raw = await page.ariaSnapshot({ mode: "ai", timeout });
  const { refs, unchecked } = await sensitiveSnapshotRefs(page, raw);
  for (const ref of unchecked) refs.add(ref);
  return redactSnapshot(raw, refs, rules);
}

/** Locators masked in every screenshot of this page: the sensitive fields of every frame. */
export function sensitiveMasks(page: Page): Locator[] {
  return page
    .frames()
    .slice(0, MAX_FRAMES)
    .map((frame) => frame.locator(SENSITIVE_SELECTOR));
}
