import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { PageDocument } from "@ensemble/shared-types";
import { ApiError, SHARE_GONE_EVENT } from "@/lib/api";
import type { EditorControl } from "../editor/replace-doc";
import { usePageSave, type PageVersion } from "./page-save";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The page's events are the DOM window's.
globalThis.CustomEvent = window.CustomEvent as typeof CustomEvent;

const doc = (...texts: string[]): PageDocument => ({ type: "doc", content: texts.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })) });
const text = (page: PageDocument) => page.content.map((block) => (block.content ?? []).map((node) => node.text ?? "").join("")).join("\n");

type Saver = ReturnType<typeof usePageSave>;
type Options = Parameters<typeof usePageSave>[0];

/** A server holding one page, an editor that is just a document, and the hook between them. */
async function setup(start: PageDocument, extra: Partial<Options> = {}) {
  const server: PageVersion & { loads: number; saves: number; gone: boolean } = { revision: 1, content: start, loads: 0, saves: 0, gone: false };
  let shown = start;
  const control: EditorControl = { read: () => shown, accepts: () => true, replace: (next) => ((shown = next), true) };
  const events = { errors: [] as string[], kept: 0, lost: 0 };
  const options: Options = {
    load: async () => {
      server.loads += 1;
      if (server.gone) throw new ApiError("This share was removed, or it is not yours.", 404, "SHARE_GONE");
      return { revision: server.revision, content: server.content };
    },
    save: async (revision, content) => {
      server.saves += 1;
      if (server.gone) throw new ApiError("This share was removed, or it is not yours.", 404, "SHARE_GONE");
      if (revision !== server.revision) throw new ApiError("This page changed in another tab.", 409);
      server.revision += 1;
      server.content = content;
      return { revision: server.revision, content };
    },
    matches: (event) => event.id === "page-1",
    live: false,
    frozen: false,
    onError: (message) => events.errors.push(message),
    onKept: () => (events.kept += 1),
    onLost: () => (events.lost += 1),
    ...extra,
  };
  const out: { saver: Saver | null } = { saver: null };
  function Harness() {
    out.saver = usePageSave(options);
    out.saver.control.current = control;
    return null;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<Harness />));
  const saver = () => out.saver!;
  saver().adopt({ revision: 1, content: start });
  /** You type: the editor changes and tells the hook. */
  const type = async (next: PageDocument) => {
    shown = next;
    await act(async () => saver().edit(next));
  };
  /** Someone else saves on the server. */
  const theySave = (next: PageDocument) => {
    server.revision += 1;
    server.content = next;
  };
  const close = async () => {
    saver().cancel();
    await act(async () => root.unmount());
  };
  return { server, saver, type, theySave, events, shown: () => shown, close };
}

test("two people typing at the end of the same paragraph: the losing save merges, keeps both, and saves", async () => {
  const page = await setup(doc("Plan the launch"));
  try {
    page.theySave(doc("Plan the launch next week"));
    await page.type(doc("Plan the launch with Mira"));
    let ok = false;
    await act(async () => {
      ok = await page.saver().flush();
    });
    assert.ok(ok);
    assert.equal(text(page.server.content), "Plan the launch next week with Mira", "both texts are on the server");
    assert.equal(text(page.shown()), "Plan the launch next week with Mira", "and in the editor, in place");
    assert.equal(page.saver().revision.current, page.server.revision);
    assert.equal(page.saver().state, "saved");
    assert.deepEqual(page.events.errors, []);
  } finally {
    await page.close();
  }
});

test("someone else's save arriving while you type is merged in at once and saved", async () => {
  const page = await setup(doc("Intro", "Body"));
  try {
    await page.type(doc("Intro, mine", "Body"));
    page.theySave(doc("Intro", "Body, theirs"));
    await act(async () => {
      window.dispatchEvent(new CustomEvent("ensemble:page", { detail: { id: "page-1", action: "save", revision: page.server.revision } }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await page.saver().flush();
    });
    assert.deepEqual(page.server.content.content.map((block) => block.content?.[0]?.text), ["Intro, mine", "Body, theirs"]);
    assert.equal(text(page.shown()), "Intro, mine\nBody, theirs");
    assert.equal(page.server.saves, 1, "merged before saving, so the save was not refused first");
  } finally {
    await page.close();
  }
});

test("your own save echoing back is not fetched, and an older version arriving late is ignored", async () => {
  const page = await setup(doc("One"));
  try {
    await page.type(doc("One two"));
    await act(async () => {
      await page.saver().flush();
    });
    const loads = page.server.loads;
    await act(async () => {
      window.dispatchEvent(new CustomEvent("ensemble:page", { detail: { id: "page-1", action: "save", revision: page.server.revision } }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(page.server.loads, loads, "no fetch for our own revision");
    const mine = page.server.revision;
    // A slow read returns the version before our save: it must not replace what we saved.
    page.server.revision = mine - 1;
    page.server.content = doc("One");
    await act(async () => {
      window.dispatchEvent(new CustomEvent("ensemble:page", { detail: { id: "page-1" } }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(text(page.shown()), "One two");
    assert.equal(page.saver().revision.current, mine);
  } finally {
    await page.close();
  }
});

test("the event for your own save, arriving before the save's answer, costs no request", async () => {
  const page = await setup(doc("Echo"), {
    save: async (revision, content) => {
      page.server.saves += 1;
      page.server.revision += 1;
      page.server.content = content;
      // The API publishes the event before it answers.
      window.dispatchEvent(new CustomEvent("ensemble:page", { detail: { id: "page-1", action: "save", revision: page.server.revision } }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { revision: page.server.revision, content };
    },
  });
  try {
    await page.type(doc("Echo, echo"));
    await act(async () => {
      await page.saver().flush();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(page.server.loads, 0);
    assert.equal(page.saver().revision.current, page.server.revision);
  } finally {
    await page.close();
  }
});

test("a save refused because the share is gone keeps the text and stops saving", async () => {
  const page = await setup(doc("Shared"));
  try {
    page.server.gone = true;
    let told = 0;
    const listen = () => (told += 1);
    window.addEventListener(SHARE_GONE_EVENT, listen);
    await page.type(doc("Shared, and my unsaved line"));
    let ok = true;
    await act(async () => {
      ok = await page.saver().flush();
    });
    window.removeEventListener(SHARE_GONE_EVENT, listen);
    assert.equal(ok, false);
    assert.equal(page.events.lost, 1);
    assert.equal(told, 1, "the shared viewer is told to check the share");
    assert.equal(text(page.shown()), "Shared, and my unsaved line", "the text stays on screen");
    assert.equal(text(page.saver().latest.current!), "Shared, and my unsaved line", "and can be copied");
    const saves = page.server.saves;
    await page.type(doc("Shared, and more"));
    await act(async () => {
      await page.saver().flush();
    });
    assert.equal(page.server.saves, saves, "no more saves after the share is gone");
  } finally {
    await page.close();
  }
});

test("saves that keep losing the race stop after a few tries and keep the text", async () => {
  let attempts = 0;
  const page = await setup(doc("Busy"), {
    // Someone else saves first every time.
    save: async () => {
      attempts += 1;
      page.server.revision += 1;
      throw new ApiError("This page changed in another tab.", 409);
    },
  });
  try {
    await page.type(doc("Busy, mine"));
    let ok = true;
    await act(async () => {
      ok = await page.saver().flush();
    });
    assert.equal(ok, false);
    assert.equal(attempts, 4, "the first save and three merged retries");
    assert.equal(page.saver().state, "error");
    assert.equal(page.events.errors.length, 1);
    assert.equal(text(page.shown()), "Busy, mine", "your text is still in the editor");
  } finally {
    await page.close();
  }
});
