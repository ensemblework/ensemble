/** Who each Microsoft 365 tool belongs to and which Graph scopes it needs (connectors/products.ts names the products). */
import type { AppToolMeta } from "../../types.js";

const meta = (label: string, products: string[], scopes: AppToolMeta["scopes"]): AppToolMeta => ({
  provider: "microsoft",
  suite: "microsoft_365",
  products,
  scopes,
  label,
});

const FILES_READ = [["Files.Read", "Files.Read.All", "Files.ReadWrite", "Files.ReadWrite.All"]];
const FILES_WRITE = [["Files.ReadWrite", "Files.ReadWrite.All"]];

export const OUTLOOK_MAIL = meta("Outlook mail", ["outlook_mail"], [["Mail.Read", "Mail.ReadWrite"]]);
export const OUTLOOK_CALENDAR_READ = meta("Outlook calendar", ["outlook_calendar"], [["Calendars.Read", "Calendars.ReadWrite"]]);
export const OUTLOOK_CALENDAR_WRITE = meta("Outlook calendar", ["outlook_calendar"], [["Calendars.ReadWrite"]]);
export const TEAMS = meta("Microsoft Teams", ["teams"], [["Chat.Read", "Chat.ReadWrite"]]);
export const ONEDRIVE_READ = meta("OneDrive", ["onedrive", "office"], FILES_READ);
export const WORD_WRITE = meta("Word", ["office"], FILES_WRITE);
export const EXCEL_READ = meta("Excel", ["onedrive", "office"], FILES_READ);
export const EXCEL_WRITE = meta("Excel", ["office"], FILES_WRITE);
export const POWERPOINT_WRITE = meta("PowerPoint", ["office"], FILES_WRITE);

export const GRAPH = "https://graph.microsoft.com/v1.0";

/** New files go here so they are easy to find. OneDrive creates the folder on first upload. */
export const ENSEMBLE_FOLDER = "Ensemble";

export const OFFICE_TYPES = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const;
