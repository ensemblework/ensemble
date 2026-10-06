import assert from "node:assert/strict";
import test from "node:test";
import { parseDiagram } from "./parse.js";
import { scanLine } from "./highlight.js";

function apply(source: string, from: number, to: number, insert: string): string {
  return source.slice(0, from) + insert + source.slice(to);
}

test("a shape typo underlines the word and offers the real shape", () => {
  const source = `node check "Check" shape dimond\n`;
  const parsed = parseDiagram(source);
  const item = parsed.diagnostics.find((entry) => /diamond/i.test(entry.message));
  assert.ok(item);
  assert.equal(item.severity, "warning");
  assert.equal(source.slice(item.from, item.to), "dimond");
  assert.equal(item.fixes?.[0]?.title, "Use diamond");
  const fixed = apply(source, item.fixes![0]!.from, item.fixes![0]!.to, item.fixes![0]!.insert);
  assert.equal(parseDiagram(fixed).diagnostics.length, 0);
  assert.equal(parsed.model.nodes.check?.shape, "diamond");
});

test("a missing block can be declared in one step", () => {
  const source = `node start "Start" shape circle\nedge start > missing\n`;
  const parsed = parseDiagram(source);
  const item = parsed.diagnostics.find((entry) => /no block named/i.test(entry.message));
  assert.ok(item);
  assert.equal(source.slice(item.from, item.to), "missing");
  assert.equal(item.target, "missing");
  const fix = item.fixes?.[0];
  assert.ok(fix);
  assert.match(fix.title, /Create block/);
  const fixed = apply(source, fix.from, fix.to, fix.insert);
  const again = parseDiagram(fixed);
  assert.equal(again.diagnostics.length, 0);
  assert.equal(again.model.nodes.missing?.shape, "rectangle");
  assert.equal(again.model.edges.e1?.to.node, "missing");
});

test("a group missing its brace offers to close it", () => {
  const source = `group platform "Platform" {\n  node api "API" shape server\n`;
  const parsed = parseDiagram(source);
  const item = parsed.diagnostics.find((entry) => /closing \}/.test(entry.message));
  assert.ok(item);
  assert.equal(item.target, "platform");
  assert.equal(source.slice(item.from, item.to), "{");
  const fix = item.fixes?.[0];
  assert.equal(fix?.insert.trim(), "}");
  const again = parseDiagram(apply(source, fix!.from, fix!.to, fix!.insert));
  assert.equal(again.diagnostics.length, 0);
  assert.equal(again.model.groups.platform?.label, "Platform");
});

test("an unclosed quote and a missing colon have fixes on the right range", () => {
  const quote = `node start "Start shape circle\n`;
  const quoted = parseDiagram(quote);
  const quoteItem = quoted.diagnostics.find((entry) => /quote/i.test(entry.message));
  assert.ok(quoteItem?.fixes?.[0]);
  const closed = apply(quote, quoteItem.fixes[0].from, quoteItem.fixes[0].to, quoteItem.fixes[0].insert);
  assert.equal(closed.trimEnd().endsWith('"'), true);
  assert.equal(parseDiagram(closed).diagnostics.some((entry) => /quote/i.test(entry.message)), false);

  const colon = `edge start > next yes\n`;
  const labeled = parseDiagram(colon);
  const colonItem = labeled.diagnostics.find((entry) => /colon/i.test(entry.message));
  assert.ok(colonItem);
  assert.equal(colon.slice(colonItem.from, colonItem.to), "yes");
  const withColon = apply(colon, colonItem.fixes![0]!.from, colonItem.fixes![0]!.to, colonItem.fixes![0]!.insert);
  assert.match(withColon, /next : yes/);
  assert.equal(parseDiagram(`node start "Start"\nnode next "Next"\n${withColon}`).diagnostics.filter((entry) => entry.severity !== "info").length, 0);
});

test("an unread line is an error covering that line", () => {
  const source = `node start "Start" shape circle\nthis is not a diagram\n`;
  const parsed = parseDiagram(source);
  const item = parsed.diagnostics.find((entry) => entry.severity === "error");
  assert.ok(item);
  assert.equal(item.line, 2);
  assert.match(item.message, /couldn’t read this line/i);
  assert.equal(source.slice(item.from, item.to), "this is not a diagram");
});

test("a line with no arrow can be connected in one step", () => {
  const source = `node start "Start"\nnode next "Next"\nedge start next\n`;
  const parsed = parseDiagram(source);
  const item = parsed.diagnostics.find((entry) => /arrow/i.test(entry.message));
  assert.ok(item);
  const fix = item.fixes?.[0];
  assert.equal(fix?.title, "Connect start to next");
  const fixed = apply(source, fix!.from, fix!.to, fix!.insert);
  const again = parseDiagram(fixed);
  assert.equal(again.diagnostics.filter((entry) => entry.severity === "error").length, 0);
  assert.equal(again.model.edges.e1?.from.node, "start");
  assert.equal(again.model.edges.e1?.to.node, "next");
});

test("a few hundred lines parse within 250ms of CPU time", () => {
  const lines = ["title Checkout", "direction down"];
  for (let index = 0; index < 500; index += 1) {
    lines.push(`node n${index} "Step ${index}" shape rectangle`);
    if (index > 0) lines.push(`edge n${index - 1} > n${index}`);
  }
  const started = process.cpuUsage();
  const parsed = parseDiagram(lines.join("\n"));
  const used = process.cpuUsage(started);
  assert.ok((used.user + used.system) / 1000 < 250);
  assert.equal(parsed.diagnostics.length, 0);
  assert.equal(Object.keys(parsed.model.nodes).length, 500);
});

test("the highlighter marks keywords, labels, shapes, colours, arrows, and comments", () => {
  const tokens = scanLine('node start "Start" shape circle color blue');
  assert.deepEqual(tokens.map((token) => token.kind), ["keyword", "id", "string", "keyword", "shape", "keyword", "color"]);
  const edge = scanLine("edge start --> mail : \"receipt\" # later");
  assert.deepEqual(edge.map((token) => token.kind), ["keyword", "id", "arrow", "id", "punctuation", "string", "comment"]);
  const layout = scanLine("  db 10 20 140 90");
  assert.deepEqual(layout.map((token) => token.kind), ["id", "number", "number", "number", "number"]);
});
