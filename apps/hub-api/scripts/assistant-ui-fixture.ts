import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createHttpHarness } from "../src/test/http.js";
import { DEFAULT_SETTINGS, ONBOARDING_TOUR_KEY, READY_ONBOARDING_TOUR } from "@ensemble/shared-types";
process.env.HUB_WEB_ORIGIN = "http://localhost:3091";
const h = await createHttpHarness();
const { getTool } = await import("../src/assistant/registry.js");
const { loadSettings } = await import("../src/lib/settings.js");
const u = await h.asUser("assistant-ui@fieldnote.example");
await u.inject({ method: "POST", url: "/api/onboarding", payload: { role: "engineer", templateId: "branch-desk" } });
await h.prisma.user.update({ where: { id: u.id }, data: { profileCompletedAt: new Date(), emailVerifiedAt: new Date() } });
await h.prisma.preference.upsert({ where: { userId_key: { userId: u.id, key: ONBOARDING_TOUR_KEY } }, create: { userId: u.id, key: ONBOARDING_TOUR_KEY, value: { ...READY_ONBOARDING_TOUR, completed: true } as object }, update: {} });
const ctx = { app: h.app, prisma: h.prisma, userId: u.id, actor: "agent" as const, settings: await loadSettings(h.prisma, u.id), requestHeaders: { cookie: u.cookie } };
const read = async (name: string, input: unknown) => { const tool = getTool(name)!; return (await tool.run(ctx, tool.input.parse(input))).data as any; };
const board = await read("hub_read_layout", { surface: "board" });
const today = await read("hub_read_layout", { surface: "today" });
const page = await read("hub_create_page", { title: "UI verification", markdown: "Keep **this paragraph** intact.\n\nThe review is October 20." });
const blocks = await read("hub_read_page_blocks", { pageId: page.id });
const block = blocks.blocks.find((row: any) => row.markdown.includes("October 20"));
const conversation = await h.prisma.assistantConversation.create({ data: { userId: u.id, title: "Workspace verification" } });
const pending = [
 { name: "hub_edit_layout", input: { surface: "board", version: board.version, edits: [{ action: "add", type: "attention" }] } },
 { name: "hub_edit_layout", input: { surface: "today", version: today.version, edits: [{ action: "add", type: "calendar", c: 6, r: 5 }] } },
 { name: "hub_update_settings", input: { changes: [{ key: "appearance.theme", value: "light" }] } },
 { name: "hub_edit_page", input: { pageId: page.id, revision: blocks.revision, edits: [{ path: block.path, expected: block.markdown, action: "replace_text", find: "October 20", replacement: "October 22" }] } },
];
for (const call of pending) {
 const tool = getTool(call.name)!; const input = tool.input.parse(call.input);
 await h.prisma.assistantMessage.create({ data: { userId: u.id, conversationId: conversation.id, role: "assistant", content: "Ready to apply.", toolCalls: [{ id: randomUUID(), name: call.name, input, summary: await tool.preview!(ctx, input), isWrite: true, state: "awaiting_approval" }] as never } });
}
await h.app.listen({ host: "127.0.0.1", port: 4091 });
writeFileSync("/tmp/ensemble-assistant-ui.json", JSON.stringify({ cookie: u.cookie, conversationId: conversation.id, pageId: page.id }));
console.log("Isolated assistant UI fixture ready on port 4091.");
const stop = async () => { await h.close(); process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
