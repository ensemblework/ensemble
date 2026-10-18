import assert from "node:assert/strict";
import test from "node:test";
import { CONNECTOR_CATALOG, CONNECTOR_GUIDES } from "@ensemble/shared-types";
import type { McpConnection } from "@/lib/api-connectors";
import { categoryCounts, connectorUses, entryStatus, featuredEntries, filterEntries, statusLabel, storeCards, usableAuth } from "./catalog-view.js";
import { catalogWith } from "./test-fixtures.js";
import { tokenFields, trelloTokenUrl } from "./token-forms.js";

test("Settings shows exactly the five featured connectors, in order", () => {
  const featured = featuredEntries(catalogWith());
  assert.deepEqual(
    featured.map((entry) => entry.id),
    ["google_workspace", "microsoft_365", "notion", "linear", "github"],
  );
});

test("connected featured apps move to the top of the Settings list; the rest keep their order", () => {
  const featured = featuredEntries(catalogWith({ github: { connected: true, account: "mira-chen" }, notion: { mcp: { status: "connected", toolCount: 9, lastError: null } } }));
  assert.deepEqual(
    featured.map((entry) => entry.id),
    ["notion", "github", "google_workspace", "microsoft_365", "linear"],
  );
});

test("the store lists connected apps first, in catalog order, then everything else in catalog order", () => {
  const entries = catalogWith({
    trello: { connected: true, account: "mirachen" },
    granola: { mcp: { status: "connected", toolCount: 4, lastError: null } },
    linear: { mcp: { status: "pending", toolCount: 0, lastError: null } },
  });
  const all = filterEntries(entries, {}).map((entry) => entry.id);
  assert.deepEqual(all.slice(0, 2), ["trello", "granola"], "token and MCP connections both count");
  const rest = CONNECTOR_CATALOG.map((entry) => entry.id).filter((id) => id !== "trello" && id !== "granola");
  assert.deepEqual(all.slice(2), rest, "unconnected entries keep catalog order; pending is not connected");
  assert.deepEqual(filterEntries(entries, { category: "work_tracking" }).map((entry) => entry.id)[0], "trello");
  assert.deepEqual(filterEntries(entries, { query: "meeting notes" }).map((entry) => entry.id)[0], "granola");
});

test("connected custom servers join the connected apps at the top of the grid", () => {
  const entries = filterEntries(catalogWith({ notion: { connected: true } }), { category: "notes_docs" });
  const custom = [
    { id: "c1", name: "Fieldnote wiki", url: "https://mcp.fieldnote.example/mcp", status: "pending" },
    { id: "c2", name: "Fieldnote search", url: "https://search.fieldnote.example/mcp", status: "connected" },
  ] as McpConnection[];
  const order = storeCards(entries, custom).map((card) => (card.kind === "entry" ? card.entry.id : `mcp:${card.connection.id}`));
  assert.deepEqual(order.slice(0, 2), ["notion", "mcp:c2"]);
  assert.equal(order.at(-1), "mcp:c1");
  assert.equal(order.length, entries.length + 2);
});

test("search matches names, vendors, taglines and products; every word must match", () => {
  const entries = catalogWith();
  assert.deepEqual(filterEntries(entries, { query: "jira" }).map((entry) => entry.id), ["atlassian"]);
  assert.ok(filterEntries(entries, { query: "teams" }).some((entry) => entry.id === "microsoft_365"));
  assert.ok(filterEntries(entries, { query: "GMAIL" }).some((entry) => entry.id === "google_workspace"));
  assert.equal(filterEntries(entries, { query: "notion zzzz" }).length, 0);
});

test("categories, Connected and Import filter the store", () => {
  const entries = catalogWith({ notion: { connected: true, account: "mira@fieldnote.example" }, granola: { mcp: { status: "connected", toolCount: 4, lastError: null } } });
  assert.ok(filterEntries(entries, { category: "work_tracking" }).every((entry) => entry.category === "work_tracking"));
  assert.deepEqual(filterEntries(entries, { category: "connected" }).map((entry) => entry.id).sort(), ["granola", "notion"]);
  assert.ok(filterEntries(entries, { category: "import" }).every((entry) => entry.import));
  assert.ok(filterEntries(entries, { category: "import" }).some((entry) => entry.id === "csv"));
  const counts = categoryCounts(entries);
  assert.equal(counts.all, entries.length);
  assert.equal(counts.connected, 2);
});

test("every catalog entry can be connected; none is left as coming soon", () => {
  const entries = catalogWith();
  assert.deepEqual(entries.filter((entry) => entry.status === "soon").map((entry) => entry.id), []);
  for (const id of ["loom", "figma", "dropbox", "box", "hubspot", "intercom", "vercel", "cloudflare", "grafana", "aws", "azure_devops", "salesforce", "zendesk", "front", "discord", "xero", "zotero"]) {
    const entry = entries.find((row) => row.id === id);
    assert.ok(entry, id);
    assert.ok(usableAuth(entry!).length > 0, `${id} has a way in`);
  }
});

test("each connector says what Ensemble does with it", () => {
  const entries = catalogWith({ github: { connected: true, account: "mira-chen" } });
  const by = (id: string) => entries.find((entry) => entry.id === id)!;
  const github = connectorUses(by("github")).join(" ");
  assert.match(github, /clone the repositories/);
  assert.match(github, /Post an update back/);
  assert.match(github, /GitHub's own tools/);
  assert.match(connectorUses(by("notion")).join(" "), /Attach pages and databases/);
  assert.match(connectorUses(by("trello")).join(" "), /Import into Ensemble/);
  assert.match(connectorUses(by("granola")).join(" "), /ask the assistant to import recent notes into Meetings/);
  assert.match(connectorUses(by("zoom")).join(" "), /Ask the assistant about your Zoom meetings/);
  assert.ok(connectorUses(by("exa")).length > 0);
  const zotero = connectorUses(by("zotero")).join(" ");
  assert.match(zotero, /Attach references and collections to a task or project/);
  assert.match(zotero, /Turn references into tasks/);
  assert.match(zotero, /Post an update back/);
});

test("what a connector does is not over-promised", () => {
  const entries = catalogWith({
    google_workspace: { connected: true, sources: { gmail: { enabled: true, lastSyncAt: null, lastError: null } } },
    linear: { connected: true, sources: { linear: { enabled: true, lastSyncAt: null, lastError: null } } },
  });
  const by = (id: string) => entries.find((entry) => entry.id === id)!;
  const every = entries.flatMap((entry) => connectorUses(entry)).join(" ");
  assert.doesNotMatch(every, /Syncs into your context|proposed todos on Today|Meeting notes arrive/);
  assert.match(connectorUses(by("google_workspace")).join(" "), /Sync people adds the people you work with here to People\. Messages and files are saved only when you ask\./);
  assert.doesNotMatch(connectorUses(by("linear")).join(" "), /Sync people/, "Linear's source does not sync people");
  assert.match(connectorUses(by("google_workspace")).join(" "), /After your Apply, the assistant can change these for you: Calendar events and invites; Docs, Sheets and Slides\./);
  assert.match(connectorUses(by("granola")).join(" "), /Action items become proposed todos only if you ask/);
  assert.match(connectorUses(by("atlassian")).join(" "), /Post an update back to Jira \(when connected with an API token\)/);
  for (const entry of entries) {
    const uses = connectorUses(entry).join(" ");
    if (/it searches and reads/.test(uses)) assert.ok(entry.items, `${entry.id} only claims search when the assistant can search it`);
    if (!entry.items && !entry.mcp) assert.doesNotMatch(uses, /assistant can use/, entry.id);
  }
});

test("every token form uses the vendor's word from its step-by-step guide", () => {
  const providers = new Set(CONNECTOR_CATALOG.filter((entry) => entry.auth.includes("token")).map((entry) => entry.provider ?? entry.id));
  for (const provider of providers) {
    const entry = CONNECTOR_CATALOG.find((row) => row.provider === provider)!;
    const guide = CONNECTOR_GUIDES[entry.id];
    assert.ok(guide?.term, `${provider} has a guide that names the credential`);
    const labels = tokenFields(provider).map((field) => field.label.toLowerCase()).join(" | ");
    for (const part of guide.term.toLowerCase().split(" and ")) assert.ok(labels.includes(part), `${provider}: "${part}" appears in the form (${labels})`);
  }
  const trello = tokenFields("trello");
  assert.deepEqual(trello.map((field) => field.label), ["API key", "Token (from the Token link, starts with ATTA)"]);
});

test("Trello's Get a token link asks for read and write on the key that was typed", () => {
  assert.equal(trelloTokenUrl(""), null);
  assert.equal(trelloTokenUrl("ATTAabc0123456789abcdef0123456789"), null, "a token is not a key");
  assert.equal(trelloTokenUrl("not a key!"), null);
  const url = new URL(trelloTokenUrl(" 0123456789abcdef0123456789abcdef ")!);
  assert.equal(url.origin + url.pathname, "https://trello.com/1/authorize");
  assert.equal(url.searchParams.get("key"), "0123456789abcdef0123456789abcdef");
  assert.equal(url.searchParams.get("scope"), "read,write");
  assert.equal(url.searchParams.get("expiration"), "never");
  assert.equal(url.searchParams.get("response_type"), "token");
  assert.equal(url.searchParams.get("name"), "Ensemble");
  const field = tokenFields("trello").find((row) => row.name === "token")!;
  assert.equal(field.link?.href({ key: "0123456789abcdef0123456789abcdef" }), trelloTokenUrl("0123456789abcdef0123456789abcdef"));
  assert.equal(field.link?.href({}), null);
});

test("status labels say who is connected, and when the server is not set up", () => {
  const entries = catalogWith({
    google_workspace: { connected: true, account: "mira@fieldnote.example" },
    microsoft_365: { appReady: false, oauthReady: false },
    github: { appReady: true, oauthReady: false },
  });
  const by = (id: string) => entries.find((entry) => entry.id === id)!;
  assert.equal(statusLabel(by("google_workspace")), "Connected as mira@fieldnote.example");
  assert.equal(entryStatus(by("microsoft_365")), "not_set_up");
  assert.equal(statusLabel(by("microsoft_365")), "Not available to connect yet");
  // GitHub still works with a pasted token when its OAuth app is missing.
  assert.equal(statusLabel(by("github")), "Not connected");
  assert.equal(statusLabel(by("csv")), "Import from a file");
  assert.equal(statusLabel(by("aws")), "Not connected");
});
