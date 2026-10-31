/**
 * Pages that are not the site but a check that a person is there, or a refusal of automated
 * browsing: captchas (reCAPTCHA, hCaptcha, Cloudflare Turnstile, DataDome, PerimeterX, Arkose),
 * "Robot or human?", Cloudflare's "Just a moment…", Google's "unusual traffic", Amazon's robot check
 * and its 503 page, Akamai's "Access Denied". A node cannot pass one and must not try; the tool's
 * answer says so (`HUMAN_CHECK_HINT`), so it hands the tab to its owner or uses another source.
 * A captcha counts only as a visible frame of its own (an invisible reCAPTCHA on an ordinary page does
 * not), and the words only in a page's title or in a short page (a challenge page says little else).
 */

export const HUMAN_CHECK_HINT =
  "This page is a human check (or blocked automated browsing). Ask your owner to pass it with browser_login_needed (purpose: \"human_check\"), or use another source.";

/** What a tab shows: its title, its visible text, the addresses of its visible frames, the page's HTTP status. */
export type PageSigns = { title: string; text: string; frames: readonly string[]; status: number | null };

/** Frames that hold a challenge. */
const CHALLENGE_FRAMES: Array<[RegExp, string]> = [
  [/\/\/(www\.)?(google|recaptcha)\.(com|net)\/recaptcha\/(api2|enterprise)\/(anchor|bframe)/i, "a reCAPTCHA"],
  [/\/\/([a-z0-9-]+\.)*hcaptcha\.com\//i, "an hCaptcha"],
  [/\/\/challenges\.cloudflare\.com\//i, "Cloudflare's check"],
  [/\/\/([a-z0-9-]+\.)*captcha-delivery\.com\//i, "a DataDome check"],
  [/\/\/([a-z0-9-]+\.)*(arkoselabs\.com|funcaptcha\.com)\//i, "an Arkose check"],
  [/\/\/captcha\.px-cdn\.net\//i, "a PerimeterX check"],
];

/** Words of a check or a block. */
const CHALLENGE_WORDS: Array<[RegExp, string]> = [
  [/\brobot or human\b/i, "\u201cRobot or human?\u201d"],
  [/\bare you a (robot|human)\b/i, "a robot check"],
  [/\bverify (that )?you('re| are) (a )?human\b/i, "a human check"],
  [/\b(confirm|prove) (that )?you('re| are) (a )?human\b/i, "a human check"],
  [/\bpress (&|and) hold to confirm\b/i, "a press-and-hold check"],
  [/\bmake sure you('re| are) not a robot\b/i, "a robot check"],
  [/\bunusual traffic from your (computer )?network\b/i, "an unusual-traffic block"],
  [/\bautomated access to amazon data\b/i, "Amazon's robot check"],
  [/\bchecking (if the site connection is secure|your browser before accessing)\b/i, "Cloudflare's check"],
  [/\benable javascript and cookies to continue\b/i, "Cloudflare's check"],
  [/\b(complete|solve) the (security check|captcha)\b/i, "a captcha"],
];

/** Visible text shorter than this is a page that may be only a check. */
const SHORT_PAGE = 4_000;

/** The kind of human check the page is, or null when it looks like the site itself. */
export function humanCheck(signs: PageSigns): string | null {
  for (const frame of signs.frames) {
    // reCAPTCHA v3 and invisible v2 sit on ordinary pages and ask nobody anything.
    if (/[?&]size=invisible\b/i.test(frame)) continue;
    for (const [pattern, kind] of CHALLENGE_FRAMES) if (pattern.test(frame)) return kind;
  }
  const title = signs.title.trim();
  if (/^just a moment\b/i.test(title) || /^attention required!? \| cloudflare/i.test(title)) return "Cloudflare's check";
  for (const [pattern, kind] of CHALLENGE_WORDS) if (pattern.test(title)) return kind;
  const text = signs.text.trim();
  if (/^access denied$/i.test(title) && /(permission to access|reference #)/i.test(text)) return "an Akamai block";
  if (text.length >= SHORT_PAGE) return null;
  for (const [pattern, kind] of CHALLENGE_WORDS) if (pattern.test(text)) return kind;
  if (signs.status === 503 && /sorry! something went wrong/i.test(`${title}\n${text}`)) return "Amazon's block (503)";
  if ((signs.status === 403 || signs.status === 429) && /\b(captcha|robot|bot|automated)\b/i.test(text)) return "a block of automated browsing";
  return null;
}
