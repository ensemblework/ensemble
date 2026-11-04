import { Extension, type Editor } from "@tiptap/core";
import type { QueryClient } from "@tanstack/react-query";
import { PageLink } from "./imported-blocks";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    nestedPage: {
      /** `/page`: makes a page inside this one and puts a link to it where the caret is. */
      createNestedPage: (pos?: number) => ReturnType;
    };
  }
}

/** How deep pages nest: a page and three levels inside it (the API refuses deeper ones too). */
export const MAX_PAGE_DEPTH = 4;

export type NestedPageOptions = {
  /** Makes the page and inserts its link at `pos`. Null where pages cannot be made (a public link, a test). */
  create: ((editor: Editor, pos: number) => void) | null;
  /** Whether a page can go inside this one now (false at the deepest level). */
  allowed: () => boolean;
  /** The app's query cache: link blocks read the linked page's current title from it. */
  client: () => QueryClient | null;
};

type PageList = { pages: Array<{ id: string; title: string }> };

export const NestedPage = Extension.create<NestedPageOptions>({
  name: "nestedPage",
  addOptions() {
    return { create: null, allowed: () => true, client: () => null };
  },
  addCommands() {
    return {
      createNestedPage:
        (pos) =>
        ({ editor, state, dispatch }) => {
          if (!this.options.create || !this.options.allowed()) return false;
          if (dispatch) this.options.create(editor, pos ?? state.selection.from);
          return true;
        },
    };
  },
});

/** Whether `/page` can make a page in this editor. */
export function canNestPages(editor: Editor): boolean {
  const extension = editor.extensionManager.extensions.find((item) => item.name === "nestedPage");
  const options = extension?.options as NestedPageOptions | undefined;
  return Boolean(options?.create && options.allowed());
}

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>';

/**
 * A link to a page, as a block. It shows the page's title as it is now (renaming the page renames
 * every link to it); the saved label is only the fallback while the list loads.
 */
export function livePageLink(client: () => QueryClient | null) {
  return PageLink.extend({
    addNodeView() {
      return ({ node: initial }) => {
        let node = initial;
        const dom = document.createElement("a");
        dom.className = "page-link-block";
        dom.setAttribute("data-type", "pageLink");
        dom.contentEditable = "false";
        dom.innerHTML = ICON;
        const label = document.createElement("span");
        label.className = "page-link-title";
        dom.appendChild(label);
        const paint = () => {
          const pageId = typeof node.attrs.pageId === "string" ? node.attrs.pageId : null;
          dom.setAttribute("href", pageId ? `/pages/${pageId}` : `https://www.notion.so/${node.attrs.externalPageId ?? ""}`);
          const list = pageId ? client()?.getQueryData<PageList>(["pages"]) : undefined;
          const title = (pageId && list?.pages.find((page) => page.id === pageId)?.title) || String(node.attrs.label || "Untitled");
          if (label.textContent !== title) label.textContent = title;
        };
        paint();
        const cache = client()?.getQueryCache();
        const stop = cache?.subscribe((event) => {
          if (event.query.queryKey[0] === "pages") paint();
        });
        return {
          dom,
          update(next) {
            if (next.type !== node.type) return false;
            node = next;
            paint();
            return true;
          },
          ignoreMutation: () => true,
          destroy: () => stop?.(),
        };
      };
    },
  });
}
