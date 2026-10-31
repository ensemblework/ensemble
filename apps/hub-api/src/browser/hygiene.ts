/**
 * Page hygiene (C1a): what stands between the work and the page is closed after it loads and before a
 * screenshot. Known consent managers are accepted by their own buttons (OneTrust, Cookiebot, TrustArc,
 * Quantcast, Didomi, Usercentrics in its shadow DOM, Sourcepoint and TrustArc in their frames, Google's
 * Funding Choices and others), Google's and Yahoo's consent pages are passed, Amazon's "Deliver to …"
 * toaster is dismissed. Then, in dialogs and fixed overlays, a button whose whole text is an accept word
 * (inside a consent banner) or a close word is clicked. Never a button that buys, subscribes, signs up,
 * signs in, downloads or asks for notifications. Bounded: 2.5 seconds by default. Says what it closed.
 *
 * Functions passed to `evaluate` are serialised into the page: they must not define named inner
 * functions or assign functions to variables (tsx adds a `__name` helper the page does not have).
 */
import type { ElementHandle, JSHandle, Locator, Page } from "playwright-core";

type Known = { name: string; selector: string; frame?: string };

/** Consent managers and site notices, by their own buttons: the first visible one of each is clicked. */
export const KNOWN_DISMISSERS: readonly Known[] = [
  { name: "the cookie banner (OneTrust)", selector: "#onetrust-accept-btn-handler, #accept-recommended-btn-handler, .onetrust-close-btn-handler.banner-close-button" },
  { name: "the cookie banner (Cookiebot)", selector: "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll, #CybotCookiebotDialogBodyButtonAccept, #CybotCookiebotDialogBodyLevelButtonAccept" },
  { name: "the cookie banner (TrustArc)", selector: "#truste-consent-button" },
  { name: "the cookie banner (TrustArc)", frame: "iframe[src*='consent-pref.trustarc.com'], iframe.truste_popframe", selector: "a.call, .acceptAllButtonLower, button.acceptAllButtonLower" },
  { name: "the cookie banner (Quantcast)", selector: "#qc-cmp2-ui button[mode='primary'], .qc-cmp2-summary-buttons button[mode='primary']" },
  { name: "the cookie banner (Didomi)", selector: "#didomi-notice-agree-button" },
  { name: "the cookie banner (Usercentrics)", selector: "#usercentrics-root [data-testid='uc-accept-all-button'], #usercentrics-cmp-ui #accept, #uc-btn-accept-banner" },
  { name: "the cookie banner (Sourcepoint)", frame: "iframe[id^='sp_message_iframe'], iframe[title='SP Consent Message']", selector: "button[title='Accept'], button[title='Accept all'], button[title='Accept All'], button.sp_choice_type_11" },
  { name: "the cookie banner (Google)", selector: ".fc-consent-root .fc-cta-consent" },
  { name: "the cookie banner (Osano)", selector: ".osano-cm-accept-all" },
  { name: "the cookie banner (CookieYes)", selector: ".cky-btn-accept" },
  { name: "the cookie banner (Complianz)", selector: ".cmplz-btn.cmplz-accept" },
  { name: "the cookie banner (Termly)", selector: "[data-tid='banner-accept']" },
  { name: "the cookie banner (iubenda)", selector: ".iubenda-cs-accept-btn" },
  { name: "the cookie banner (Axeptio)", selector: "#axeptio_btn_acceptAll" },
  { name: "the cookie banner (consentmanager)", selector: "#cmpbntyestxt, .cmpboxbtnyes" },
  { name: "the cookie banner (Evidon)", selector: "#_evidon-accept-button" },
  { name: "the cookie banner (Ketch)", selector: "#ketch-banner-button-primary" },
  { name: "the cookie banner (Shopify)", selector: "#shopify-pc__banner__btn-accept" },
  { name: "the cookie banner (Amazon)", selector: "#sp-cc-accept" },
  { name: "the cookie banner (Bing)", selector: "#bnp_btn_accept" },
  { name: "the cookie banner (YouTube)", selector: "ytd-consent-bump-v2-lightbox button[aria-label^='Accept']" },
  { name: "Amazon's delivery location notice", selector: ".glow-toaster-button-dismiss input, .glow-toaster input[data-action-type='DISMISS']" },
];

/** Full consent pages a site sends first, and the button that passes them. */
const CONSENT_PAGES: ReadonlyArray<{ host: RegExp; name: string; selector: string }> = [
  { host: /^consent\.(?:google|youtube)\.[a-z.]+$/i, name: "Google's consent page", selector: "button[aria-label='Accept all'], button[aria-label='Alle akzeptieren'], form[action*='consent'] button:has-text('Accept all')" },
  { host: /^(?:consent|guce)\.yahoo\.com$/i, name: "Yahoo's consent page", selector: "button[name='agree'], button.accept-all, input[name='agree']" },
];

const ACCEPT = String.raw`^(?:accept|accept all|accept all cookies|accept cookies|accept & close|accept and close|accept & continue|accept and continue|allow all|allow all cookies|allow cookies|agree|i agree|agree & close|agree and close|agree & continue|agree and continue|ok|okay|got it|got it!|i understand|understood|consent|yes, i agree|yes i agree|continue|alle akzeptieren|akzeptieren|tout accepter|accepter|aceptar|aceptar todo|accetta|accetta tutto|aceitar|accepteren)$`;
const CLOSE = String.raw`^(?:close|dismiss|no thanks|no, thanks|no thank you|not now|maybe later|later|skip|×|✕|✖|╳|x|close dialog|close modal|close banner|close popup|close pop-up|close this|close window|stay on this site|stay here|continue shopping|continue to site|continue to website|cancel)$`;
const NEVER = String.raw`(?:buy|purchase|order|checkout|check out|add to (?:cart|bag|basket)|subscribe|sign ?up|register|join|download|install|get the app|open (?:the )?app|use (?:the )?app|start (?:your )?(?:free )?trial|free trial|donate|pay|upgrade|log ?in|sign ?in|create (?:an )?account|notification|allow location|share location|continue with|book|reserve|apply now)`;
const CONSENT = String.raw`(?:cookie|cookies|consent|privacy|gdpr|ccpa|tracking|personali[sz]ed ads|your data|data protection|partners)`;

export type HygieneResult = { dismissed: string[]; ms: number };

export type HygieneOptions = {
  /** At most this long (default 2.5 s). */
  budgetMs?: number;
  /** "load": just after a page loaded, everything above; "capture": before a screenshot, consent only (a dialog the work opened stays open). */
  moment?: "load" | "capture";
};

/** Runs in the page: buttons in dialogs and fixed overlays whose whole text is an accept word (in a consent banner) or a close word. */
function findDismissers(args: { accept: string; close: string; never: string; consent: string; closeToo: boolean }): unknown[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = globalThis as any;
  const d = w.document;
  if (!d.body) return [];
  const acceptRe = new RegExp(args.accept, "i");
  const closeRe = new RegExp(args.close, "i");
  const neverRe = new RegExp(args.never, "i");
  const consentRe = new RegExp(args.consent, "i");
  const vw = w.innerWidth;
  const vh = w.innerHeight;
  const containers: unknown[] = [];
  const dialogs = d.querySelectorAll("[role=dialog], [role=alertdialog], [aria-modal=true], dialog[open]");
  for (let k = 0; k < dialogs.length && k < 20; k += 1) containers.push(dialogs[k]);
  const points = [
    [vw / 2, vh / 2],
    [vw / 2, vh - 24],
    [vw / 2, vh - 90],
    [vw / 4, vh - 40],
    [(vw * 3) / 4, vh - 40],
    [vw / 2, 24],
    [vw / 2, 130],
    [vw - 60, vh - 60],
    [80, vh - 60],
  ];
  for (let k = 0; k < points.length; k += 1) {
    const stack = d.elementsFromPoint(points[k]![0], points[k]![1]);
    for (let s = 0; s < stack.length && s < 3; s += 1) {
      for (let p = stack[s]; p && p !== d.body && p !== d.documentElement; p = p.parentElement) {
        const style = w.getComputedStyle(p);
        if (style.position === "fixed" || style.position === "sticky") {
          if (!containers.includes(p)) containers.push(p);
          break;
        }
      }
    }
  }
  const picked: Array<{ el: unknown; rank: number }> = [];
  for (let c = 0; c < containers.length; c += 1) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const box = containers[c] as any;
    const rect = box.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const boxStyle = w.getComputedStyle(box);
    if (boxStyle.visibility === "hidden" || boxStyle.display === "none") continue;
    const boxText = String(box.innerText || "").slice(0, 3000);
    const consent = consentRe.test(boxText) || consentRe.test(`${box.id || ""} ${typeof box.className === "string" ? box.className : ""}`);
    const buttons = box.querySelectorAll("button, [role=button], a, input[type=button], input[type=submit], [aria-label]");
    for (let b = 0; b < buttons.length && b < 60; b += 1) {
      const button = buttons[b];
      const tag = String(button.tagName).toLowerCase();
      if (tag === "a") {
        const href = String(button.getAttribute("href") || "").trim();
        if (href && href !== "#" && !/^javascript:/i.test(href) && button.getAttribute("role") !== "button") continue;
      }
      const label = String(button.getAttribute("aria-label") || "").trim();
      const shown = String(button.innerText || button.value || "").replace(/\s+/g, " ").trim();
      const text = (shown || label || String(button.getAttribute("title") || "")).toLowerCase();
      if (!text || text.length > 40) continue;
      if (neverRe.test(text) || neverRe.test(label)) continue;
      const br = button.getBoundingClientRect();
      if (br.width < 8 || br.height < 8 || br.bottom < 0 || br.top > vh || br.right < 0 || br.left > vw) continue;
      const style = w.getComputedStyle(button);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
      let rank = 0;
      if (consent && acceptRe.test(text)) rank = 1;
      else if (args.closeToo && (closeRe.test(text) || (closeRe.test(label.toLowerCase()) && shown.length <= 2))) rank = 2;
      if (!rank) continue;
      picked.push({ el: button, rank });
    }
  }
  picked.sort((a, b) => a.rank - b.rank);
  const out: unknown[] = [];
  for (let k = 0; k < picked.length && out.length < 3; k += 1) if (!out.includes(picked[k]!.el)) out.push(picked[k]!.el);
  return out;
}

/** Runs in the page: the button's text and whether it sits in a consent banner, for the summary. */
function describeButton(el: unknown, consent: string): { text: string; consent: boolean } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const button = el as any;
  const consentRe = new RegExp(consent, "i");
  let box = button.parentElement;
  let inConsent = false;
  for (let k = 0; box && k < 8; k += 1, box = box.parentElement) {
    if (consentRe.test(String(box.innerText || "").slice(0, 2000))) {
      inConsent = true;
      break;
    }
  }
  return { text: String(button.innerText || button.value || button.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 40), consent: inConsent };
}

async function clickQuickly(target: ElementHandle | Locator, timeout: number): Promise<boolean> {
  try {
    await target.click({ timeout });
    return true;
  } catch {
    try {
      await target.dispatchEvent("click");
      return true;
    } catch {
      return false;
    }
  }
}

/** Closes consent banners, notices and simple overlays; says what it closed. Never throws. */
export async function cleanPage(page: Page, options: HygieneOptions = {}): Promise<HygieneResult> {
  const started = Date.now();
  const deadline = started + (options.budgetMs ?? 2_500);
  const left = () => deadline - Date.now();
  const dismissed: string[] = [];
  const moment = options.moment ?? "load";
  try {
    // A consent page in front of the site.
    let host = "";
    try {
      host = new URL(page.url()).hostname;
    } catch {
      host = "";
    }
    const consentPage = CONSENT_PAGES.find((entry) => entry.host.test(host));
    if (consentPage) {
      const button = page.locator(consentPage.selector).filter({ visible: true }).first();
      if ((await button.count().catch(() => 0)) && (await clickQuickly(button, Math.min(1_500, left())))) {
        dismissed.push(consentPage.name);
        await page.waitForURL((url) => !consentPage.host.test(url.hostname), { timeout: Math.max(200, left()), waitUntil: "domcontentloaded" }).catch(() => undefined);
      }
    }
    // Banners load a little after the page: look again once if none was there yet.
    for (let round = 0; round < 3 && left() > 300; round += 1) {
      let clicked = 0;
      const union = page.locator(KNOWN_DISMISSERS.filter((entry) => !entry.frame).map((entry) => entry.selector).join(", ")).filter({ visible: true });
      if ((await union.count().catch(() => 0)) > 0) {
        for (const entry of KNOWN_DISMISSERS) {
          if (entry.frame || left() < 150) continue;
          const button = page.locator(entry.selector).filter({ visible: true }).first();
          if (!(await button.count().catch(() => 0))) continue;
          if (await clickQuickly(button, Math.min(1_000, left()))) {
            if (!dismissed.includes(entry.name)) dismissed.push(entry.name);
            clicked += 1;
          }
        }
      }
      for (const entry of KNOWN_DISMISSERS) {
        if (!entry.frame || left() < 150) continue;
        if (!(await page.locator(entry.frame).count().catch(() => 0))) continue;
        const button = page.frameLocator(entry.frame).first().locator(entry.selector).filter({ visible: true }).first();
        if (!(await button.count().catch(() => 0))) continue;
        if (await clickQuickly(button, Math.min(1_000, left()))) {
          if (!dismissed.includes(entry.name)) dismissed.push(entry.name);
          clicked += 1;
        }
      }
      if (left() > 200) {
        const handle: JSHandle | null = await page.evaluateHandle(findDismissers, { accept: ACCEPT, close: CLOSE, never: NEVER, consent: CONSENT, closeToo: moment === "load" }).catch(() => null);
        if (handle) {
          try {
            const count = Number(await handle.evaluate((list: unknown[]) => list.length).catch(() => 0));
            for (let index = 0; index < count && left() > 150; index += 1) {
              const element = (await handle.evaluateHandle((list: unknown[], at: number) => list[at], index)).asElement();
              if (!element) continue;
              const what = await element.evaluate(describeButton, CONSENT).catch(() => ({ text: "", consent: false }));
              if (await clickQuickly(element as ElementHandle, Math.min(800, left()))) {
                dismissed.push(what.consent ? `the cookie banner (“${what.text || "accept"}”)` : `a pop-up (“${what.text || "close"}”)`);
                clicked += 1;
              }
              await element.dispose().catch(() => undefined);
            }
          } finally {
            await handle.dispose().catch(() => undefined);
          }
        }
      }
      if (clicked) {
        // What closed may reveal what was behind it.
        await page.waitForTimeout(Math.min(300, Math.max(0, left() - 100))).catch(() => undefined);
        continue;
      }
      if (moment === "capture" || round >= 1) break;
      await page.waitForTimeout(Math.min(700, Math.max(0, left() - 300))).catch(() => undefined);
    }
  } catch {
    // Hygiene never fails the work: whatever stayed open stays in the picture.
  }
  return { dismissed: [...new Set(dismissed)], ms: Date.now() - started };
}

/** One line for a tool's answer. */
export function dismissedNote(result: HygieneResult | null | undefined): string {
  if (!result?.dismissed.length) return "";
  return `Closed ${result.dismissed.join(", ")}.`;
}
