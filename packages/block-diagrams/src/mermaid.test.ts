import assert from "node:assert/strict";
import test from "node:test";
import { importMermaid } from "./mermaid.js";
import { errorCount, parseDiagram } from "./parse.js";
import { printDiagram } from "./print.js";

const FLOW = `flowchart TD
  start([Open the app]) --> check{Signed in?}
  check -->|yes| home[Home]
  check -->|no| login[Sign in]
  login --> check
  db[(Accounts)]
  login --> db
`;

test("imports a Mermaid flowchart into blocks and arrows", () => {
  const parsed = importMermaid(FLOW);
  assert.equal(errorCount(parsed.diagnostics), 0);
  assert.equal(parsed.model.meta.direction, "down");
  assert.equal(parsed.model.nodes.start?.shape, "rounded");
  assert.equal(parsed.model.nodes.check?.shape, "diamond");
  assert.equal(parsed.model.nodes.home?.label, "Home");
  assert.equal(parsed.model.nodes.db?.shape, "cylinder");
  assert.equal(parsed.model.nodes.db?.label, "Accounts");
  const labels = Object.values(parsed.model.edges).map((edge) => edge.label).sort();
  assert.deepEqual(labels.filter(Boolean), ["no", "yes"]);
});

test("parseDiagram accepts Mermaid and the printer emits Ensemble text", () => {
  const parsed = parseDiagram(FLOW);
  assert.equal(errorCount(parsed.diagnostics), 0);
  const printed = printDiagram(parsed.model);
  assert.match(printed, /^title |^direction /m);
  assert.match(printed, /node check "Signed in\?" shape diamond/);
  const again = parseDiagram(printed);
  assert.equal(again.diagnostics.length, 0);
  assert.equal(again.model.nodes.db?.shape, "cylinder");
});

test("reads subgraphs as groups", () => {
  const parsed = importMermaid(`flowchart LR
subgraph api [API]
  auth[Auth]
  db[(Database)]
end
web[Web] --> auth
auth --> db
`);
  assert.equal(errorCount(parsed.diagnostics), 0);
  assert.equal(parsed.model.meta.direction, "right");
  assert.equal(parsed.model.groups.api?.label, "API");
  assert.equal(parsed.model.nodes.auth?.group, "api");
  assert.equal(parsed.model.nodes.db?.group, "api");
  assert.equal(parsed.model.nodes.web?.group, null);
});
