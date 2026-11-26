import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { emitToast } from "@/lib/toast-bus";

export const CodeCopy = Extension.create({
  name: "codeCopy",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("codeCopy"),
        props: {
          nodeViews: {
            codeBlock(initial) {
              let node = initial;
              let destroyed = false;
              let attempt = 0;
              let timer: ReturnType<typeof setTimeout> | null = null;
              const dom = document.createElement("div");
              dom.className = "page-code-block";
              const pre = document.createElement("pre");
              const contentDOM = document.createElement("code");
              pre.append(contentDOM);
              const button = document.createElement("button");
              button.type = "button";
              button.setAttribute("contenteditable", "false");
              button.className = "page-code-copy";
              const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
              for (const [key, value] of Object.entries({
                viewBox: "0 0 24 24", width: "14", height: "14", fill: "none",
                stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round",
                "stroke-linejoin": "round", "aria-hidden": "true",
              })) svg.setAttribute(key, value);
              button.append(svg);
              const feedback = (copied: boolean) => {
                const label = copied ? "Copied" : "Copy code";
                button.setAttribute("aria-label", label);
                button.title = label;
                button.dataset.copied = String(copied);
                const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
                path.setAttribute("d", copied
                  ? "m20 6-11 11-5-5"
                  : "M9 9h12v12H9z M5 15H3V3h12v2");
                svg.replaceChildren(path);
              };
              const language = () => {
                contentDOM.className = node.attrs.language ? `language-${node.attrs.language}` : "";
              };
              const reset = () => {
                if (timer !== null) clearTimeout(timer);
                timer = null;
                feedback(false);
              };
              feedback(false);
              language();
              // A pointer copy keeps the writing caret; keyboard users can still focus the button.
              button.addEventListener("mousedown", (event) => event.preventDefault());
              button.addEventListener("click", async () => {
                const current = ++attempt;
                try {
                  if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
                  await navigator.clipboard.writeText(node.textContent);
                } catch {
                  if (destroyed || current !== attempt) return;
                  reset();
                  emitToast("Couldn't copy the code.", { tone: "error" });
                  return;
                }
                if (destroyed || current !== attempt) return;
                if (timer !== null) clearTimeout(timer);
                feedback(true);
                timer = setTimeout(reset, 2000);
              });
              dom.append(pre, button);
              return {
                dom,
                contentDOM,
                update(next) {
                  if (next.type !== node.type) return false;
                  node = next;
                  language();
                  return true;
                },
                stopEvent: (event) => button.contains(event.target as globalThis.Node),
                ignoreMutation: (mutation) => mutation.type === "selection"
                  ? document.activeElement === button
                  : mutation.target === dom || button.contains(mutation.target)
                    || (mutation.type === "attributes" && mutation.target === contentDOM),
                destroy() {
                  destroyed = true;
                  if (timer !== null) clearTimeout(timer);
                },
              };
            },
          },
        },
      }),
    ];
  },
});
