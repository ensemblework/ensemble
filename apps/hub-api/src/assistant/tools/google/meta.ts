/** Who each Google tool belongs to and which scopes it needs (connectors/products.ts names the products). */
import type { AppToolMeta } from "../../types.js";

const G = "https://www.googleapis.com/auth/";

const SCOPES = {
  gmailRead: [[`${G}gmail.readonly`, `${G}gmail.modify`, "https://mail.google.com/"]],
  calendarRead: [[`${G}calendar.events`, `${G}calendar.readonly`, `${G}calendar`, `${G}calendar.events.readonly`]],
  calendarWrite: [[`${G}calendar.events`, `${G}calendar`]],
  driveRead: [[`${G}drive.file`, `${G}drive.readonly`, `${G}drive`]],
  driveWrite: [[`${G}drive.file`, `${G}drive`]],
} as const;

const meta = (label: string, products: string[], scopes: AppToolMeta["scopes"]): AppToolMeta => ({
  provider: "google",
  suite: "google_workspace",
  products,
  scopes,
  label,
});

export const GMAIL = meta("Gmail", ["gmail"], SCOPES.gmailRead);
export const CALENDAR_READ = meta("Google Calendar", ["calendar"], SCOPES.calendarRead);
export const CALENDAR_WRITE = meta("Google Calendar", ["calendar"], SCOPES.calendarWrite);
export const DRIVE_READ = meta("Google Drive", ["drive_docs", "drive_search"], SCOPES.driveRead);
export const DOCS_WRITE = meta("Google Docs", ["drive_docs"], SCOPES.driveWrite);
export const SHEETS_READ = meta("Google Sheets", ["drive_docs", "drive_search"], SCOPES.driveRead);
export const SHEETS_WRITE = meta("Google Sheets", ["drive_docs"], SCOPES.driveWrite);
export const SLIDES_READ = meta("Google Slides", ["drive_docs", "drive_search"], SCOPES.driveRead);
export const SLIDES_WRITE = meta("Google Slides", ["drive_docs"], SCOPES.driveWrite);

export const FULL_DRIVE_SCOPES = [`${G}drive.readonly`, `${G}drive`];

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
export const DRIVE_API = "https://www.googleapis.com/drive/v3";
export const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
export const DOCS_API = "https://docs.googleapis.com/v1/documents";
export const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
export const SLIDES_API = "https://slides.googleapis.com/v1/presentations";

export const DRIVE_FILE_HINT = "with the basic Drive access Ensemble only sees files it created or that you picked";

export const docLink = (id: string) => `https://docs.google.com/document/d/${encodeURIComponent(id)}/edit`;
export const sheetLink = (id: string) => `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`;
export const slidesLink = (id: string) => `https://docs.google.com/presentation/d/${encodeURIComponent(id)}/edit`;
