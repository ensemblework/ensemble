/**
 * Skills and tool tiers for a node's turn (node/skills.ts): the owner's requests pick the right
 * skills (at most two, only with their tools), and a conversation turn offers the advanced browser
 * and capture tools only for app or video work. No database.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ADVANCED_TOOLS, MAX_SKILLS, NODE_SKILLS, skillsBlock, skillsFor, tieredTools, wantsAdvancedTools } from "./skills.js";

const every = () => true;
const names = (text: string, has: (tool: string) => boolean = every) => skillsFor(text, has).map((skill) => skill.name);

test("the owner's requests pick their skills, at most two, strongest first", () => {
  assert.deepEqual(names("compare the PS5 prices in Wisconsin at Amazon, Walmart and Best Buy, with screenshots of each store and a table"), ["shopping", "screenshots"]);
  assert.deepEqual(names("screenshot of the Google stock chart"), ["screenshots"]);
  assert.deepEqual(names("4 screenshots: Microsoft, Amazon, Nvidia, Apple stock"), ["screenshots"]);
  assert.deepEqual(names("fetch the BMD-45 CVPR paper from CVF and add it to my Ensemble files"), ["web-files"]);
  assert.deepEqual(names("log in to my Azure console and check yesterday's resource usage"), ["web-task", "sign-in"]);
  assert.deepEqual(names("Walmart says Robot or human? can you get past it"), ["sign-in"]);
  assert.deepEqual(names("what's the latest news on the Fed and its sources?"), ["research"]);
  assert.deepEqual(names("add yourself to the SWE crew"), []);
  assert.deepEqual(names("hello"), []);
  for (const skill of NODE_SKILLS) {
    const lines = skill.lines(every);
    assert.ok(lines.length >= 3 && lines.length <= 12, `${skill.name} is short`);
  }
  assert.equal(MAX_SKILLS, 2);
});

test("a skill needs its tools: without them it is not offered, and its lines follow what the turn has", () => {
  const before = (tool: string) => !["browser_shop", "browser_view", "browser_extract", "browser_login_check", "browser_fetch"].includes(tool);
  assert.deepEqual(names("compare PS5 prices with screenshots of each store", before), ["research"], "web search is there");
  assert.deepEqual(names("research the latest GPU reviews", before), ["research"]);
  assert.match(skillsBlock(skillsFor("research the latest GPU reviews", before), before), /open 1 to 3 of the best sources/);
  assert.match(skillsBlock(skillsFor("research the latest GPU reviews", every), every), /browser_extract on 1 to 3 of the best sources/);
  const signIn = skillsBlock(skillsFor("sign in to my bank", before), before);
  assert.match(signIn, /^Skills for this request:\nSign-in and human checks:\n/);
  assert.match(signIn, /try the page again/);
  assert.doesNotMatch(signIn, /browser_login_check/);
});

test("conversation turns offer the advanced browser and capture tools only for app or video work", () => {
  const tools = ["browser_open", "browser_screenshot", "web_task", ...ADVANCED_TOOLS].map((name) => ({ name }));
  const plain = tieredTools(tools, "send me a screenshot of the Google stock chart").map((tool) => tool.name);
  assert.deepEqual(plain, ["browser_open", "browser_screenshot", "web_task"]);
  for (const words of ["test the sign-up page of my web app", "record a video of the demo", "check the console errors on localhost:3000", "what does the browser console say?", "capture_app_start {\"command\":\"npm start\"}"]) {
    assert.ok(wantsAdvancedTools(words), words);
    assert.equal(tieredTools(tools, words).length, tools.length, words);
  }
  for (const words of ["log in to my Azure console and check yesterday's resource usage", "compare PS5 prices in a table", "what are my medical records?"]) assert.ok(!wantsAdvancedTools(words), words);
  assert.ok(wantsAdvancedTools("and then?", ["browser_open", "capture_video"]), "the conversation's last tools stay");
});
