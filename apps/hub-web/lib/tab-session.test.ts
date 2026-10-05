import assert from "node:assert/strict";
import test from "node:test";
import {
  MODULE_CACHE_KEY,
  PLOTS_WORKSPACE_KEY,
  SHELL_USER_KEY,
  clearTabSession,
  readModuleCache,
  readPlotsWorkspaceCache,
  syncModuleCache,
  writePlotsWorkspaceCache,
} from "./tab-session";

function memory() {
  const data = new Map<string, string>();
  return {
    data,
    getItem(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
    removeItem(key: string) {
      data.delete(key);
    },
  };
}

const workspace = {
  workspace: { id: "w1", title: "Plots", config: {}, code: "", updatedAt: "2026-01-01T00:00:00.000Z" },
};

test("a module cache is readable for the same user and hidden from the next one", () => {
  const storage = memory();
  syncModuleCache(storage, "user-a", "plots,meetings");
  assert.equal(readModuleCache(storage, "user-a"), "plots,meetings");
  assert.equal(readModuleCache(storage, null), "plots,meetings");
  assert.equal(readModuleCache(storage, "user-b"), null);
});

test("a user change drops the remembered shell user and the plots workspace", () => {
  const storage = memory();
  storage.setItem(SHELL_USER_KEY, JSON.stringify({ name: "A", email: "a@ensemble.test", via: "session" }));
  writePlotsWorkspaceCache(storage, "user-a", workspace);
  syncModuleCache(storage, "user-a", "plots");
  syncModuleCache(storage, "user-b", "meetings");
  assert.equal(storage.getItem(SHELL_USER_KEY), null);
  assert.equal(readPlotsWorkspaceCache(storage, "user-b"), undefined);
  assert.equal(readModuleCache(storage, "user-b"), "meetings");
  assert.equal(readModuleCache(storage, "user-a"), null);
});

test("a legacy module string is ignored once the user is known", () => {
  const storage = memory();
  storage.setItem(MODULE_CACHE_KEY, "plots");
  assert.equal(readModuleCache(storage, null), "plots");
  assert.equal(readModuleCache(storage, "user-a"), null);
});

test("sign-out clears the tab caches", () => {
  const storage = memory();
  syncModuleCache(storage, "user-a", "plots");
  storage.setItem(SHELL_USER_KEY, "{}");
  writePlotsWorkspaceCache(storage, "user-a", workspace);
  clearTabSession(storage);
  assert.equal(storage.getItem(MODULE_CACHE_KEY), null);
  assert.equal(storage.getItem(SHELL_USER_KEY), null);
  assert.equal(storage.getItem(PLOTS_WORKSPACE_KEY), null);
});

test("the plots workspace cache is not shown to a different user", () => {
  const storage = memory();
  writePlotsWorkspaceCache(storage, "user-a", workspace);
  assert.equal(readPlotsWorkspaceCache(storage, "user-a")?.workspace.id, "w1");
  assert.equal(readPlotsWorkspaceCache(storage, null)?.workspace.id, "w1");
  assert.equal(readPlotsWorkspaceCache(storage, "user-b"), undefined);
});
