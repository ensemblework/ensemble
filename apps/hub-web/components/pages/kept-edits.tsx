"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { Copy, FilePlus2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PageDocument } from "@ensemble/shared-types";
import { api, withLink, withShare } from "@/lib/api";
import { blocksFromPage, toMarkdown } from "@/lib/export/document";
import { useToast } from "../toast";

/** A new page in your own space with what is on screen. Runs outside the share or link. */
async function saveAsOwnPage(title: string, doc: PageDocument): Promise<string> {
  const own = <T,>(call: () => Promise<T>) => withLink(null, () => withShare(null, call));
  const { page } = await own(() => api.createPage());
  const fresh = await own(() => api.standalonePage(page.id));
  await own(() => api.saveStandalonePage(page.id, { revision: fresh.revision, content: doc }));
  await own(() => api.renamePage(page.id, `${title || "Untitled"} (your copy)`));
  return page.id;
}

/** Text that could not be saved, still on screen: copy it as Markdown, or keep it as a page of your own. */
export function KeptEdits({ message, title, read, ownCopy }: { message: string; title: string; read: () => PageDocument | null; ownCopy: boolean }) {
  const toast = useToast();
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const copy = () => {
    const doc = read();
    if (!doc) return;
    navigator.clipboard
      .writeText(toMarkdown({ title: title || "Untitled", blocks: blocksFromPage(doc) }))
      .then(() => toast("Copied as Markdown.", { tone: "ok" }))
      .catch(() => toast("Could not copy. Select the text on the page and copy it instead.", { tone: "error" }));
  };
  const keep = () => {
    const doc = read();
    if (!doc || saving) return;
    setSaving(true);
    saveAsOwnPage(title, doc)
      .then((id) => router.push(`/pages/${id}`))
      .catch((error: Error) => {
        setSaving(false);
        toast(error.message, { tone: "error" });
      });
  };
  return (
    <div role="alert" className="mt-3 rounded-lg border border-line-strong bg-panel px-3 py-2.5 text-[12.5px] leading-5">
      <p>{message}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className="btn" onClick={copy}>
          <Copy size={13} /> Copy my text
        </button>
        {ownCopy ? (
          <button type="button" className="btn" disabled={saving} onClick={keep}>
            <FilePlus2 size={13} /> {saving ? "Saving…" : "Save as my own page"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
