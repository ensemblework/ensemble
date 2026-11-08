import { connectorReturnTo } from "./catalog-view";
import { continueInBrowser, inAccountApp } from "@/lib/native-app";
import { emitToast } from "@/lib/toast-bus";

/**
 * Full-page redirects (OAuth and MCP sign-in) and where they come back to. Tests replace `assign`.
 * In the desktop app's window the sign-in would finish in the system browser, which does not share
 * the window's session, so the app opens this page in the browser and the person connects there.
 */
export const browser = {
  assign: (url: string) => {
    if (inAccountApp()) {
      void continueInBrowser(`${window.location.pathname}${window.location.search}`).then((opened) => {
        // A consequence the screen does not show: the connection is finished elsewhere.
        if (opened) emitToast("Finish connecting in your browser. Ensemble here shows the connection when you come back.", { durationMs: 8000 });
        else window.location.assign(url);
      });
      return;
    }
    window.location.assign(url);
  },
  returnTo: (id: string) => connectorReturnTo(id, typeof window === "undefined" ? "/settings" : window.location.pathname),
};
