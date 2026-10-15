import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PagesSection, pageTreeOrder, type PageLinkProps } from "./pages-section.js";

test("nested pages are ordered under their parent, with safe roots for missing parents and cycles", () => {
  const ordered = pageTreeOrder([{ id: "child", title: "Child", parentId: "root" }, { id: "orphan", title: "Orphan", parentId: "gone" }, { id: "root", title: "Root" }, { id: "loop", title: "Loop", parentId: "loop" }]);
  assert.deepEqual(ordered.map((page) => [page.id, page.depth]), [["orphan", 0], ["root", 0], ["child", 1], ["loop", 0]]);
});

test("select pages sends one bulk deletion request", async () => {
  const deleted: string[][] = [];
  const mounted = await render(<PagesSection pages={[{ id: "a", title: "First" }, { id: "b", title: "Second", parentId: "a" }]} pathname="/pages/a" onCreate={() => {}} onRename={() => {}} onDelete={() => {}} onDeleteMany={(ids) => deleted.push(ids)} renderLink={(props) => <Anchor {...props} />} />);
  try {
    await act(async () => mounted.host.querySelector<HTMLButtonElement>('[aria-label="Select pages"]')!.click());
    await act(async () => mounted.host.querySelector<HTMLInputElement>('[aria-label="Select First"]')!.click());
    await act(async () => mounted.host.querySelector<HTMLButtonElement>('[aria-label="Expand First"]')!.click());
    await act(async () => mounted.host.querySelector<HTMLInputElement>('[aria-label="Select Second"]')!.click());
    const remove = [...mounted.host.querySelectorAll("button")].find((button) => button.textContent?.includes("Delete 2 pages"));
    assert.ok(remove);
    await act(async () => remove.click());
    assert.deepEqual(deleted, [["a", "b"]]);
  } finally { await unmount(mounted); }
});

function Anchor({ href, className, title, children }: PageLinkProps) {
  return (
    <a href={href} className={className} title={title}>
      {children}
    </a>
  );
}

async function render(node: React.ReactNode): Promise<{ root: Root; host: HTMLDivElement }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
  });
  return { root, host };
}

async function unmount(mounted: { root: Root; host: HTMLDivElement }) {
  await act(async () => {
    mounted.root.unmount();
  });
  mounted.host.remove();
}

const pages = [
  { id: "page-new", title: "Newer note" },
  { id: "page-old", title: "Older note" },
];

test("child pages start collapsed and can be expanded independently", async () => {
  const mounted = await render(<PagesSection pages={[{ id: "root", title: "Root" }, { id: "child", title: "Child", parentId: "root" }, { id: "other", title: "Other" }]} pathname="/pages/child" onCreate={() => {}} onRename={() => {}} onDelete={() => {}} renderLink={(props) => <Anchor {...props} />} />);
  try {
    assert.deepEqual([...mounted.host.querySelectorAll("a")].map((a) => a.textContent), ["Root", "Other"]);
    const toggle = mounted.host.querySelector<HTMLButtonElement>('[aria-label="Expand Root"]')!;
    await act(async () => toggle.click());
    assert.deepEqual([...mounted.host.querySelectorAll("a")].map((a) => a.textContent), ["Root", "Child", "Other"]);
    await act(async () => mounted.host.querySelector<HTMLButtonElement>('[aria-label="Collapse Root"]')!.click());
    assert.equal(mounted.host.querySelector('a[href="/pages/child"]'), null);
  } finally { await unmount(mounted); }
});

test("the Pages section lists notes as /pages links and + creates one", async () => {
  let created = 0;
  const mounted = await render(
    <PagesSection
      pages={pages}
      pathname="/today"
      onCreate={() => {
        created += 1;
      }}
      onRename={() => undefined}
      onDelete={() => undefined}
      renderLink={(props) => <Anchor {...props} />}
    />,
  );
  try {
    const nav = document.querySelector("nav[aria-label='Page tree']");
    assert.ok(nav);
    assert.match(nav?.textContent ?? "", /2 pages/);
    const links = [...document.querySelectorAll("a")].map((link) => link.getAttribute("href"));
    assert.deepEqual(links, ["/pages/page-new", "/pages/page-old"]);
    assert.equal(links.some((href) => href?.includes("/api/")), false);
    const create = document.querySelector("[aria-label='New page']");
    assert.ok(create instanceof HTMLButtonElement);
    await act(async () => {
      create.click();
    });
    assert.equal(created, 1);
  } finally {
    await unmount(mounted);
  }
});

test("rename commits the new title from the Pages list", async () => {
  const renamed: Array<{ id: string; title: string }> = [];
  const mounted = await render(
    <PagesSection
      pages={pages}
      pathname="/pages/page-new"
      onCreate={() => undefined}
      onRename={(id, title) => renamed.push({ id, title })}
      onDelete={() => undefined}
      renderLink={(props) => <Anchor {...props} />}
    />,
  );
  try {
    const button = document.querySelector("[aria-label='Rename Newer note']");
    assert.ok(button instanceof HTMLButtonElement);
    await act(async () => {
      button.click();
    });
    const input = document.querySelector("input[aria-label='Rename Newer note']");
    assert.ok(input instanceof HTMLInputElement);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    assert.ok(setter);
    await act(async () => {
      setter.call(input, "Renamed note");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      // React 19 listens for focusout, which is the bubbling form of blur.
      input.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
    });
    assert.deepEqual(renamed, [{ id: "page-new", title: "Renamed note" }]);
  } finally {
    await unmount(mounted);
  }
});

test("delete moves a recoverable page to Trash immediately", async () => {
  const deleted: string[] = [];
  const mounted = await render(
    <PagesSection
      pages={pages}
      pathname="/today"
      onCreate={() => undefined}
      onRename={() => undefined}
      onDelete={(id) => deleted.push(id)}
      renderLink={(props) => <Anchor {...props} />}
    />,
  );
  try {
    const button = document.querySelector("[aria-label='Delete Newer note']");
    assert.ok(button instanceof HTMLButtonElement);
    await act(async () => {
      button.click();
    });
    assert.equal(document.querySelector("[role=dialog]"), null);
    assert.deepEqual(deleted, ["page-new"]);
  } finally {
    await unmount(mounted);
  }
});

test("the page count reads as a count of one or many, and + is off while a page is being made", async () => {
  const one = await render(<PagesSection pages={[{ id: "only", title: "Only page" }]} pathname="/pages" creating onCreate={() => undefined} onRename={() => undefined} onDelete={() => undefined} renderLink={(props) => <Anchor {...props} />} />);
  try {
    const nav = one.host.querySelector("nav[aria-label='Page tree']");
    assert.match(nav?.textContent ?? "", /^1 page(?!s)/);
    const create = one.host.querySelector<HTMLButtonElement>("[aria-label='New page']");
    assert.equal(create?.disabled, true);
  } finally { await unmount(one); }
  const none = await render(<PagesSection pages={[]} pathname="/pages" onCreate={() => undefined} onRename={() => undefined} onDelete={() => undefined} renderLink={(props) => <Anchor {...props} />} />);
  try {
    assert.match(none.host.textContent ?? "", /^0 pages/);
    assert.equal(none.host.querySelector<HTMLButtonElement>("[aria-label='New page']")?.disabled, false);
  } finally { await unmount(none); }
});

test("the second click of a double click on + does not make a second page", async () => {
  let created = 0;
  const mounted = await render(<PagesSection pages={pages} pathname="/pages" onCreate={() => { created += 1; }} onRename={() => undefined} onDelete={() => undefined} renderLink={(props) => <Anchor {...props} />} />);
  try {
    const create = mounted.host.querySelector<HTMLButtonElement>("[aria-label='New page']")!;
    await act(async () => {
      create.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 1 }));
      create.dispatchEvent(new window.MouseEvent("click", { bubbles: true, detail: 2 }));
    });
    assert.equal(created, 1);
  } finally { await unmount(mounted); }
});
