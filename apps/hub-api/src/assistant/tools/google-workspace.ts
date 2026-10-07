/**
 * Google Workspace tools for the assistant: Gmail and Drive reads, Calendar
 * events with invites, and Docs, Sheets and Slides the person can open.
 *
 * Area "apps": reads run when the product is connected; every write waits for
 * Apply whatever the write policy says (assistant/apps.ts, agent.ts).
 */
import { googleDocsTools } from "./google/docs.js";
import { googleMailCalendarTools } from "./google/mail-calendar.js";
import { googleSheetsSlidesTools } from "./google/sheets-slides.js";

export { docsAppendRequests } from "./google/docs.js";
export { slidesCreateRequests, rangeFor, columnName } from "./google/sheets-slides.js";

export const googleWorkspaceTools = [...googleMailCalendarTools, ...googleDocsTools, ...googleSheetsSlidesTools];
