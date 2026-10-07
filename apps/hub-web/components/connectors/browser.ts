import { connectorReturnTo } from "./catalog-view";

/** Full-page redirects (OAuth and MCP sign-in) and where they come back to. Tests replace `assign`. */
export const browser = {
  assign: (url: string) => window.location.assign(url),
  returnTo: (id: string) => connectorReturnTo(id, typeof window === "undefined" ? "/settings" : window.location.pathname),
};
