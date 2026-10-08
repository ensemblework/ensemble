import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PagesSection, type PageLinkProps } from "./pages-section.js";

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

test("Pages start collapsed on load, open for an open note, and expand when a page is created", async () => {
  let created = 0;
  const mounted = await render(
    <PagesSection pages={pages} pathname="/today" onCreate={() => { created += 1; }} onRename={() => undefined} onDelete={() => undefined} renderLink={(props) => <Anchor {...props} />} />,
  );
  try {
    const toggle = mounted.host.querySelector<HTMLButtonElement>("[aria-label='Toggle pages']")!;
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(mounted.host.querySelector("a")?.parentElement?.parentElement?.hidden, true);
    await act(async () => toggle.click());
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    await act(async () => toggle.click());
    await act(async () => mounted.host.querySelector<HTMLButtonElement>("[aria-label='New page']")!.click());
    assert.equal(created, 1);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
  } finally { await unmount(mounted); }
  const onPage = await render(
    <PagesSection pages={pages} pathname="/pages/page-old" onCreate={() => undefined} onRename={() => undefined} onDelete={() => undefined} renderLink={(props) => <Anchor {...props} />} />,
  );
  try {
    assert.equal(onPage.host.querySelector("[aria-label='Toggle pages']")?.getAttribute("aria-expanded"), "true");
  } finally { await unmount(onPage); }
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
    const nav = document.querySelector("nav[aria-label='Pages']");
    assert.ok(nav);
    assert.match(nav?.textContent ?? "", /Pages/);
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

test("delete asks for confirmation before removing a page", async () => {
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
    const dialog = document.querySelector("[role='dialog']");
    assert.ok(dialog);
    assert.match(dialog?.textContent ?? "", /Delete this page/);
    assert.deepEqual(deleted, []);
    const cancel = [...document.querySelectorAll("button")].find((node) => node.textContent === "Cancel");
    assert.ok(cancel);
    await act(async () => {
      cancel.click();
    });
    assert.equal(document.querySelector("[role='dialog']"), null);
    assert.deepEqual(deleted, []);

    await act(async () => {
      button.click();
    });
    const confirm = [...document.querySelectorAll("button")].find((node) => node.textContent === "Delete page");
    assert.ok(confirm);
    await act(async () => {
      confirm.click();
    });
    assert.deepEqual(deleted, ["page-new"]);
  } finally {
    await unmount(mounted);
  }
});
