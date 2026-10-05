import { ViewPlugin, type EditorView } from "@codemirror/view";

/** Ask CodeMirror to measure again once webfonts finish loading.

The editor caches character width on first paint. If that paint used the UI
sans (the mono face was still downloading, or the CSS variable was missing),
line wrapping and the gutter stay wrong after the real face arrives.
*/
export const remeasureOnFontLoad = ViewPlugin.fromClass(
  class {
    private readonly refresh: () => void;
    constructor(private readonly view: EditorView) {
      this.refresh = () => this.view.requestMeasure();
      void document.fonts?.ready.then(this.refresh).catch(() => undefined);
      document.fonts?.addEventListener("loadingdone", this.refresh);
    }
    destroy() {
      document.fonts?.removeEventListener("loadingdone", this.refresh);
    }
  },
);
