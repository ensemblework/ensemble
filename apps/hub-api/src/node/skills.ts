/**
 * Skills for a node's turn (docs/35 §6.1): short, curated guidance for the web work small models get
 * wrong, injected into the persona when the owner's new messages point at it. No extra model call:
 * each skill has words that match it, the tools it needs (a skill whose tools this turn does not have
 * stays out) and 6 to 12 lines. At most `MAX_SKILLS` per turn, the strongest match first.
 */
export type NodeSkill = {
  name: string;
  title: string;
  /** Words in the owner's messages that call for it (global, case-insensitive). */
  match: RegExp;
  /** Tools it needs this turn: without them it is not offered. */
  needs: readonly string[];
  lines: (has: (tool: string) => boolean) => string[];
};

export const MAX_SKILLS = 2;

export const NODE_SKILLS: readonly NodeSkill[] = [
  {
    name: "shopping",
    title: "Shopping and prices",
    match: /\b(?:prices?|pricing|priced|cost(?:s|ing)?|cheap(?:est|er)?|deals?|discounts?|on sale|for sale|buy(?:ing)?|purchase|shop(?:ping)?|in stock|out of stock|msrp|retailers?|stores?)\b/gi,
    needs: ["browser_shop"],
    lines: () => [
      "- One call: browser_shop with the product (query), the stores your owner named (else leave stores out: Amazon, Walmart, Target, Best Buy, Costco) and the location (a US state is enough; the tool picks a ZIP there).",
      "- Reply with a Markdown table: Store | Product | Price | Availability/delivery | Link. Then one line on the best deal.",
      "- Say which stores blocked automated browsing or showed a human check. Offer to open the check for your owner only if they want that store.",
      "- Never invent a price: write “not shown” when a store gave none.",
      "- The stores' screenshots come with your reply by themselves.",
    ],
  },
  {
    name: "screenshots",
    title: "Screenshots of the web",
    match: /\b(?:screen ?shots?|screen ?grabs?|screen captures?|snapshots?|charts?|graphs?)\b/gi,
    needs: ["browser_view"],
    lines: () => [
      "- browser_view with the URL and focus naming what was asked (“the price chart”, “the results table”): one call per screenshot.",
      "- Count the screenshots against what was asked: “4 screenshots” is 4 calls. Each one comes with your reply by itself.",
      "- Stock charts: Google Finance, https://www.google.com/finance/quote/<TICKER>:<EXCHANGE>?window=5D (windows 1D, 5D, 1M, 6M, YTD, 1Y, 5Y, MAX), for example AAPL:NASDAQ, MSFT:NASDAQ, AMZN:NASDAQ, NVDA:NASDAQ, GOOGL:NASDAQ, TSLA:NASDAQ.",
      "- If the focus was not found (focusFound false), try fullPage or another site.",
      "- The whole page only when your owner asks for it (fullPage).",
    ],
  },
  {
    name: "web-files",
    title: "Files from the web (papers, PDFs, documents)",
    match: /\b(?:papers?|pdfs?|arxiv|cvpr|iccv|eccv|wacv|neurips|icml|iclr|acl|emnlp|naacl|whitepapers?|datasheets?|manuals?|ebooks?)\b|\b(?:add|save|put|upload|store)\b[^.?!\n]{0,60}\b(?:to|in|into)\s+(?:my\s+)?(?:ensemble\s+)?files\b/gi,
    needs: ["hub_save_file"],
    lines: (has) => [
      "- Find the official source: CVPR, ICCV, WACV → openaccess.thecvf.com; ACL, EMNLP, NAACL → aclanthology.org; NeurIPS → proceedings.neurips.cc; ICLR → openreview.net; else the publisher or the authors' page. arXiv only if your owner allows it.",
      `- Into your owner's Ensemble Files: hub_save_file with url, the direct PDF link (not the paper's page).${has("browser_fetch") ? " When the site needs the browser: browser_fetch, then hub_save_file with its evidence id." : ""}`,
      "- Link only what hub_save_file returned (its ensemble://file/… link); never write a link yourself.",
      "- Into this chat instead: node_share_file (a file on the computer); it comes with your reply.",
      ...(has("node_save_attachment") ? ["- A file your owner attached here is already in their Files: hub_save_file with attachment (its name) gives its link."] : []),
    ],
  },
  {
    name: "sign-in",
    title: "Sign-in and human checks",
    match: /\b(?:log ?ins?|log(?:ged)? in(?:to)?|sign(?:ed)? ?in(?:to)?|sign-in|account|password|passcode|2fa|two[- ]factor|otp|verification code|captcha|robot or human|human check|verify (?:you|i) am human)\b/gi,
    needs: ["browser_login_needed"],
    lines: (has) => [
      "- A page that needs your owner's account: browser_login_needed. A captcha, “Robot or human?” or a block page: browser_login_needed for a human check.",
      "- Your owner gets a card with “Sign in here”, which shows them the page live on their phone or computer: Google sign-in, 2FA codes and approvals, and making an account all work there. You go on by yourself when it is done.",
      "- Never ask for passwords or codes in chat, and never type them.",
      has("browser_login_check") ? "- When your owner says they did it: browser_login_check with the tab." : "- When your owner says they did it, try the page again.",
      "- Never Ensemble itself (app.ensemblework.com, a board or task link): you are in it already, through your Ensemble tools.",
    ],
  },
  {
    name: "web-task",
    title: "Multi-step web work",
    match: /\b(?:dashboards?|consoles?|portals?|admin|fill (?:in|out)|forms?|navigate|click through|billing|usage|invoices?|order history|my orders|my account|settings page)\b/gi,
    needs: ["web_task"],
    lines: () => [
      "- Dashboards, consoles and forms: web_task with the goal (and the url or tab). It clicks, types and reads step by step and returns what it found.",
      "- After a sign-in it goes on: call web_task again with the same goal and tab.",
      "- It never buys, pays, deletes or sends anything unless your owner's words ask for that.",
      "- If it returns human_check or blocked, say so plainly.",
    ],
  },
  {
    name: "research",
    title: "Research and facts",
    match: /\b(?:research|look up|find out|latest|news|facts?|compare|comparison|vs\.?|versus|reviews?|specs?|sources?|cite|explain)\b/gi,
    needs: ["hub_web_search"],
    lines: (has) => [
      "- hub_web_search first, with market (en-US, en-IN…) when the answer depends on the country.",
      has("browser_extract") ? "- When details matter, browser_extract on 1 to 3 of the best sources (url) and answer from what they say." : "- When details matter, open 1 to 3 of the best sources and read them.",
      "- Cite the links you used, and say what you could not verify.",
    ],
  },
];

/** How strongly the owner's words point at a skill: the distinct words that match it. */
function score(skill: NodeSkill, text: string): number {
  return new Set([...text.matchAll(skill.match)].map((match) => match[0].toLowerCase())).size;
}

/** The skills for a turn: those the words match and whose tools the turn has, strongest first, at most `MAX_SKILLS`. */
export function skillsFor(text: string, has: (tool: string) => boolean): NodeSkill[] {
  return NODE_SKILLS.map((skill, order) => ({ skill, order, score: score(skill, text) }))
    .filter((row) => row.score > 0 && row.skill.needs.every(has))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, MAX_SKILLS)
    .map((row) => row.skill);
}

/** The persona block for these skills. */
export function skillsBlock(skills: readonly NodeSkill[], has: (tool: string) => boolean): string {
  if (!skills.length) return "";
  return ["Skills for this request:", ...skills.flatMap((skill) => [`${skill.title}:`, ...skill.lines(has)])].join("\n");
}

/**
 * Tool tiers (docs/35 §6.1): the browser and capture tools for building or testing a web app or making a
 * video. A conversation turn offers them only when its words are about that work, or the conversation's
 * last tools were; web screenshots are browser_view and browser_screenshot. Plan steps and turns that
 * carry on work (an answered card, a run that ended) keep every tool.
 */
export const ADVANCED_TOOLS: ReadonlySet<string> = new Set([
  "browser_console",
  "browser_network_errors",
  "browser_record",
  "browser_upload",
  "browser_tabs",
  "browser_close",
  "capture_app_start",
  "capture_app_stop",
  "capture_apps",
  "capture_check",
  "capture_status",
  "capture_video",
  "capture_screenshot",
]);

const ADVANCED_INTENT =
  /\b(?:videos?|record(?:ing)?|screencast|gif|(?:browser|js|javascript|dev ?tools) console|console (?:logs?|errors?|messages?|output)|network (?:errors?|requests?|tab)|devtools|upload|tabs?|dev server|localhost|127\.0\.0\.1|web ?app|desktop app|electron|tauri|app window|e2e|end[- ]to[- ]end|playwright|(?:test|testing|tested|debug|debugging|qa|build|building|check|checking)\b[^.?!\n]{0,40}\b(?:app|apps|site|website|web ?page|page|ui|frontend|front[- ]end|sign-?up|log-?in|form|flow|feature|endpoint|game|build))\b/i;

/** Whether a turn's words (or its conversation's last tools) are about building or testing a web app or a video. */
export function wantsAdvancedTools(words: string, recentTools: readonly string[] = []): boolean {
  return ADVANCED_INTENT.test(words) || recentTools.some((name) => ADVANCED_TOOLS.has(name)) || [...ADVANCED_TOOLS].some((name) => words.includes(name));
}

/** A conversation turn's tools: without the advanced ones unless the turn is about that work. */
export function tieredTools<T extends { name: string }>(tools: readonly T[], words: string, recentTools: readonly string[] = []): T[] {
  return wantsAdvancedTools(words, recentTools) ? [...tools] : tools.filter((tool) => !ADVANCED_TOOLS.has(tool.name));
}
