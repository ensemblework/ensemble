/**
 * Microsoft 365 tools for the assistant, through Microsoft Graph (v1.0):
 * Outlook mail and calendar, Teams chats, OneDrive, and Word, Excel and
 * PowerPoint files.
 *
 * Area "apps": reads run when the product is connected; every write waits for
 * Apply whatever the write policy says (assistant/apps.ts, agent.ts).
 */
import { microsoftFileTools } from "./microsoft/files.js";
import { microsoftMailCalendarTools } from "./microsoft/mail-calendar-teams.js";

export { odata } from "./microsoft/mail-calendar-teams.js";

export const microsoft365Tools = [...microsoftMailCalendarTools, ...microsoftFileTools];
