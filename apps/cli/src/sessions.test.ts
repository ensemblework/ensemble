import assert from "node:assert/strict";
import test from "node:test";
import { ago, formatSessions } from "./sessions.js";

test("sessions read as agent, folder, status and age, then the tasks and what the agent did", () => {
  const now = Date.parse("2026-10-28T12:00:00Z");
  const text = formatSessions(
    [
      { id: "a", agentName: "Claude Code", model: "claude-sonnet-5-5", folder: "its own checkout", title: "Fix the login", latestTask: { id: "t2", title: "Rate-limit the login" }, summary: "Added rate limiting.", status: "idle", tasks: 2, lastActiveAt: "2026-10-28T09:00:00Z" },
      { id: "b", agentName: "Codex", model: "default", folder: "api", title: "Write tests", latestTask: { id: "t3", title: "Write tests" }, summary: "", status: "working", tasks: 1, lastActiveAt: "2026-10-28T11:58:00Z" },
    ],
    now,
  );
  assert.equal(text, "1. Claude Code (claude-sonnet-5-5) · its own checkout · idle · 3h ago\n   Fix the login → Rate-limit the login\n   Added rate limiting.\n\n2. Codex · api · working · 2m ago\n   Write tests");
  assert.match(formatSessions([]), /No agent sessions on this computer yet/);
  assert.equal(ago("2026-10-25T12:00:00Z", now), "3d ago");
});
