/**
 * Skills and tool tiers for a node's turn (node/skills.ts): the request's words choose the catalogue from
 * Ensemble's bundled skills and the owner's own (only with their tools, within the budget), `node_skill`
 * reads one in full, and a conversation turn offers the advanced browser and capture tools only for app or
 * video work. No database.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { SKILLS } from "@ensemble/prompts";
import { DEFAULT_CONTEXT_CONFIG } from "../context/config.js";
import { ADVANCED_TOOLS, BUNDLED_SKILLS, chooseSkills, inlineGuidance, skillTool, tieredTools, wantsAdvancedTools, type CatalogueSkill } from "./skills.js";

const config = DEFAULT_CONTEXT_CONFIG.skills;
const every = () => true;
const choose = (text: string, over: { has?: (tool: string) => boolean; skills?: readonly CatalogueSkill[]; recent?: Set<string>; config?: typeof config } = {}) =>
  chooseSkills({ text, skills: over.skills ?? BUNDLED_SKILLS, has: over.has ?? every, ...(over.recent ? { recent: over.recent } : {}), config: over.config ?? config });
const first = (text: string, has: (tool: string) => boolean = every) => choose(text, { has })[0]?.skill.name;

test("the request's words choose the skill that fits first: debugging for a failing build, shopping for prices", () => {
  assert.equal(first("the build fails with this error"), "debugging");
  assert.equal(first("npm test is failing with TypeError: cannot read properties of undefined"), "debugging");
  assert.equal(first("What's the going rate for a PS5?"), "shopping", "the lab's regex skills missed this one");
  assert.equal(first("how much does the Pixel 10 cost at Best Buy and Walmart?"), "shopping");
  assert.equal(first("compare the PS5 prices in Wisconsin at Amazon, Walmart and Best Buy"), "shopping");
  assert.equal(first("screenshot of the Google stock chart"), "screenshots");
  assert.equal(first("fetch the BMD-45 CVPR paper from CVF and add it to my Ensemble files"), "web-files");
  assert.equal(first("log in to my Azure console and check yesterday's resource usage"), "web-task");
  assert.ok(choose("log in to my Azure console and check yesterday's resource usage").some((choice) => choice.skill.name === "sign-in"));
  assert.equal(first("what's the latest news on the Fed and its sources?"), "research");
  assert.equal(first("plan my day"), "planning");
  assert.equal(first("from now on, always use Copilot for coding"), "memory-notes");
  assert.deepEqual(choose("hello"), [], "nothing for a hello");
  const debugging = choose("the build fails with this error")[0]!;
  assert.ok(debugging.score > 3 && debugging.why.some((why) => why.startsWith("keywords:")), JSON.stringify(debugging));
  assert.match(debugging.line, /^- debugging: Use when /);
});

test("a skill is listed only with its tools; an owner's skill joins the catalogue and hides a bundled one of the same name", () => {
  const noShop = (tool: string) => tool !== "browser_shop";
  assert.ok(!choose("how much does a PS5 cost?", { has: noShop }).some((choice) => choice.skill.name === "shopping"));
  assert.ok(!choose("log in to my Azure console", { has: (tool) => tool !== "web_task" }).some((choice) => choice.skill.name === "web-task"));

  const release: CatalogueSkill = { name: "Release notes style", source: "owner", id: "s1", description: "Short bullet points, newest first.", keywords: [], tools: [], priority: "p1", body: "Group changes by area." };
  const notes = choose("write the release notes for 0.9", { skills: [...BUNDLED_SKILLS, release] });
  const own = notes.find((choice) => choice.skill.source === "owner");
  assert.ok(own, JSON.stringify(notes.map((choice) => choice.skill.name)));
  assert.equal(own.line, "- Release notes style (your owner's skill): Short bullet points, newest first.");
  assert.ok(!choose("hello", { skills: [...BUNDLED_SKILLS, release] }).length, "not for words it does not share");

  const mine: CatalogueSkill = { ...release, name: "shopping", description: "Only Costco, and the member price." };
  const shopping = choose("how much is a PS5?", { skills: [...BUNDLED_SKILLS, mine] }).filter((choice) => choice.skill.name === "shopping");
  assert.deepEqual(shopping.map((choice) => choice.skill.source), ["owner"]);
});

test("a skill read lately in this conversation counts for more; the catalogue keeps to its count and characters", () => {
  const before = choose("can you check this again").map((choice) => choice.skill.name);
  const after = choose("can you check this again", { recent: new Set(["debugging"]) });
  assert.ok(!before.includes("debugging") || before.indexOf("debugging") > 0);
  assert.equal(after[0]?.skill.name, "debugging");
  assert.ok(after[0]!.why.includes("read in this conversation"));

  const busy = "plan, research, compare prices, take screenshots, fill in the form on the dashboard, sign in, save the paper to my files, record a video, remember it, and debug the failing build";
  const full = choose(busy);
  assert.equal(full.length, config.max);
  assert.ok(full.reduce((sum, choice) => sum + choice.line.length + 1, 0) <= config.budgetChars);
  for (const choice of full) assert.ok(choice.line.length <= config.lineChars + 40, choice.line);
  const small = choose(busy, { config: { ...config, budgetChars: 300 } });
  assert.ok(small.length >= 1 && small.reduce((sum, choice) => sum + choice.line.length + 1, 0) <= 300);
});

test("the six skills that were regexes are bundled skills with their guidance and their tools", () => {
  const guidance: Record<string, { tool: string; says: RegExp }> = {
    shopping: { tool: "browser_shop", says: /Markdown table: Store \| Product \| Price/ },
    screenshots: { tool: "browser_view", says: /“4 screenshots” is 4 calls/ },
    "web-files": { tool: "hub_save_file", says: /openaccess\.thecvf\.com/ },
    "sign-in": { tool: "browser_login_needed", says: /Never ask for passwords or codes in chat/ },
    "web-task": { tool: "web_task", says: /After a sign-in it goes on/ },
    research: { tool: "hub_web_search", says: /one search per part, all in the same reply/ },
  };
  for (const [name, { tool, says }] of Object.entries(guidance)) {
    const skill = SKILLS[name as keyof typeof SKILLS];
    assert.ok(skill, name);
    assert.deepEqual(skill.tools, [tool], name);
    assert.match(skill.body, says, name);
  }
});

/** Every phrase the regexes of the old skills matched (node/skills.ts before the bundled skills), by skill. */
const OLD_PHRASES: Record<string, string[]> = {
  shopping: ["price", "prices", "pricing", "priced", "cost", "costs", "costing", "cheap", "cheapest", "cheaper", "deal", "deals", "discount", "discounts", "on sale", "for sale", "buy", "buying", "purchase", "shop", "shopping", "in stock", "out of stock", "msrp", "retailer", "retailers", "store", "stores"],
  screenshots: ["screenshot", "screenshots", "screen shot", "screen shots", "screengrab", "screengrabs", "screen grab", "screen grabs", "screen capture", "screen captures", "snapshot", "snapshots", "chart", "charts", "graph", "graphs"],
  "web-files": [
    ...["paper", "papers", "pdf", "pdfs", "arxiv", "cvpr", "iccv", "eccv", "wacv", "neurips", "icml", "iclr", "acl", "emnlp", "naacl", "whitepaper", "whitepapers", "datasheet", "datasheets", "manual", "manuals", "ebook", "ebooks"],
    ...["add the slides to my files", "save this in my ensemble files", "put the report into files", "upload it to files", "store the scan in my files", "save it into my ensemble files"],
  ],
  "sign-in": [
    ...["login", "logins", "log in", "log ins", "log into", "logged in", "logged into", "sign in", "signin", "sign into", "signed in", "signed into", "sign-in", "account", "password", "passcode"],
    ...["2fa", "two factor", "two-factor", "otp", "verification code", "captcha", "robot or human", "human check", "verify you am human", "verify i am human"],
  ],
  "web-task": ["dashboard", "dashboards", "console", "consoles", "portal", "portals", "admin", "fill in", "fill out", "form", "forms", "navigate", "click through", "billing", "usage", "invoice", "invoices", "order history", "my orders", "my account", "settings page"],
  research: ["research", "look up", "find out", "latest", "news", "fact", "facts", "compare", "comparison", "vs", "vs.", "versus", "review", "reviews", "spec", "specs", "source", "sources", "cite", "explain"],
};

test("every phrase the old regex skills matched still selects the same skill, by its own words", () => {
  for (const [skill, phrases] of Object.entries(OLD_PHRASES)) {
    for (const phrase of phrases) {
      for (const text of [phrase, `please ${phrase} for me`]) {
        const chosen = choose(text).find((choice) => choice.skill.name === skill);
        assert.ok(chosen, `${skill} for “${text}”: ${choose(text).map((choice) => choice.skill.name).join(", ")}`);
        assert.ok(chosen.strength > 0, `${skill} for “${text}” by its keywords: ${chosen.why.join("; ")}`);
      }
    }
  }
  // Written as people write them.
  assert.equal(first("log into my bank and download last month's statement"), "sign-in");
  assert.equal(first("I logged into Azure but the page is blank"), "sign-in");
  assert.equal(first("send me a screengrab of the pricing page"), "screenshots");
  // The old tests' requests keep their skills, the strongest first.
  const old: Array<[string, string[]]> = [
    ["compare the PS5 prices in Wisconsin at Amazon, Walmart and Best Buy, with screenshots of each store and a table", ["shopping", "screenshots"]],
    ["screenshot of the Google stock chart", ["screenshots"]],
    ["4 screenshots: Microsoft, Amazon, Nvidia, Apple stock", ["screenshots"]],
    ["fetch the BMD-45 CVPR paper from CVF and add it to my Ensemble files", ["web-files"]],
    ["log in to my Azure console and check yesterday's resource usage", ["web-task", "sign-in"]],
    ["Walmart says Robot or human? can you get past it", ["sign-in"]],
    ["what's the latest news on the Fed and its sources?", ["research"]],
  ];
  for (const [text, names] of old) {
    const chosen = choose(text).map((choice) => choice.skill.name);
    assert.equal(chosen[0], names[0], `${text}: ${chosen.join(", ")}`);
    for (const name of names) assert.ok(chosen.includes(name), `${name} for “${text}”: ${chosen.join(", ")}`);
  }
});

test("the strongest skill's guidance comes in full when its own words call for it: one skill, within its budget", () => {
  const inline = (text: string, over: Partial<typeof config.inline> = {}, skills: readonly CatalogueSkill[] = BUNDLED_SKILLS) =>
    inlineGuidance(choose(text, { skills, config: { ...config, inline: { ...config.inline, ...over } } }), { ...config, inline: { ...config.inline, ...over } });
  const debugging = inline("the build fails with this error");
  assert.deepEqual(debugging && { name: debugging.name, text: debugging.text, cut: debugging.cut }, { name: "debugging", text: SKILLS.debugging.body, cut: false });
  assert.equal(inline("log in to my Azure console and check yesterday's resource usage")?.name, "web-task");
  assert.equal(inline("the cheapest PS5?")?.name, "shopping", "one of the old skills' words is enough, as before");
  assert.equal(inline("hello"), null);
  assert.equal(inline("would it change what we build?"), null, "words of a description alone are not enough");
  assert.equal(inline("the build fails with this error", { minScore: 100 }), null, "the threshold is the config's");

  const cut = inline("the build fails with this error", { chars: 300 })!;
  assert.ok(cut.cut && cut.text.length <= 300, `${cut.text.length} characters`);
  assert.ok(SKILLS.debugging.body.startsWith(cut.text.split("\n").slice(0, -1).join("\n")), "whole lines from the start");
  assert.match(cut.text, /node_skill “debugging”/);

  const mine: CatalogueSkill = { name: "Release notes style", source: "owner", id: "s1", description: "Short bullet points, newest first.", keywords: [], tools: [], priority: "p1", body: "Group changes by area.", text: "Group changes by area.\nNewest first." };
  assert.deepEqual(inline("use the release notes style for 0.9", {}, [...BUNDLED_SKILLS, mine]), { name: "Release notes style", source: "owner", text: "Group changes by area.\nNewest first.", cut: false });
  for (const skill of Object.values(SKILLS)) assert.ok(skill.body.length <= config.inline.chars, `${skill.name}'s guidance fits whole (${skill.body.length})`);
});

test("node_skill reads a skill in full by its name, and refuses one that does not exist", async () => {
  const tool = skillTool({ prisma: {} as never, node: { userId: "owner" }, ownerOnly: false, lineage: { fromNonOwner: false } });
  const read = await tool.run({} as never, tool.input.parse({ name: "debugging" }));
  const data = read.data as { name: string; source: string; text: string };
  assert.equal(data.name, "debugging");
  assert.equal(data.source, "Ensemble");
  assert.equal(data.text, SKILLS.debugging.body);
  assert.equal(((await tool.run({} as never, { name: "“Verify before done”" })).data as { name: string }).name, "verify-before-done");
  await assert.rejects(tool.run({} as never, { name: "juggling" }), /There is no skill called “juggling”/);
});

test("conversation turns offer the advanced browser and capture tools only for app or video work", () => {
  const tools = ["browser_open", "browser_screenshot", "web_task", "browser_tabs", "browser_close", ...ADVANCED_TOOLS].map((name) => ({ name }));
  const plain = tieredTools(tools, "send me a screenshot of the Google stock chart").map((tool) => tool.name);
  assert.deepEqual(plain, ["browser_open", "browser_screenshot", "web_task", "browser_tabs", "browser_close"]);
  // A popup a click opened, or "close it" after a live view: the tabs and closing are always there.
  for (const words of ["okay, close it", "the payment opened in a popup, use that tab"]) assert.deepEqual(tieredTools(tools, words).map((tool) => tool.name), plain, words);
  for (const words of ["test the sign-up page of my web app", "record a video of the demo", "check the console errors on localhost:3000", "what does the browser console say?", "capture_app_start {\"command\":\"npm start\"}"]) {
    assert.ok(wantsAdvancedTools(words), words);
    assert.equal(tieredTools(tools, words).length, tools.length, words);
  }
  for (const words of ["log in to my Azure console and check yesterday's resource usage", "compare PS5 prices in a table", "what are my medical records?"]) assert.ok(!wantsAdvancedTools(words), words);
  assert.ok(wantsAdvancedTools("and then?", ["browser_open", "capture_video"]), "the conversation's last tools stay");
});
