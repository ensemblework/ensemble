export const DOCS_ASK_PATH = "/api/docs/ask";
export const DOCS_ORIGIN = "https://docs.ensemblework.com";
export const DOCS_RETURN = `${DOCS_ORIGIN}/#docs-chat`;
const PATHS = new Set([DOCS_ASK_PATH, "/api/docs/session", "/api/docs/history", "/api/docs/chats", "/api/docs/logout"]);
export const isDocsPath = (path: string) => PATHS.has(path);
