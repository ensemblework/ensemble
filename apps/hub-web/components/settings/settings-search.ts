import { SETTINGS_MAP } from "@ensemble/shared-types";
import { SETTINGS_DESTINATIONS } from "./navigation";
import { SETTINGS_TABS, type SettingsDialog, type SettingsTab } from "./url-state";

/** One result of the search at the top of the Settings nav. */
export type SettingsHit = {
  key: string;
  label: string;
  /** "Assistant › Models". */
  place: string;
  /** The settings map's one line on what it does, when it has one. */
  about?: string;
  tab: SettingsTab;
  /** The jump anchor that scrolls to and highlights the control; none for a whole tab. */
  anchor?: string;
  dialog?: SettingsDialog;
};

const normalize = (text: string) =>
  text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/colour/g, "color").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** 0 when a word of the query matches nothing; otherwise higher the closer the query is to the label. */
export function settingsScore(query: string, label: string, place: string, keywords = ""): number {
  const needle = normalize(query);
  if (!needle) return 0;
  const name = normalize(label);
  const words = needle.split(" ");
  const tokens = `${name} ${normalize(place)} ${normalize(keywords)}`.split(" ");
  if (!words.every((word) => tokens.some((token) => token.startsWith(word)))) return 0;
  return name === needle ? 100 : name.startsWith(needle) ? 80 : name.includes(needle) ? 60 : words.every((word) => name.includes(word)) ? 50 : 20;
}

// The settings map's line for each anchor (or dialog), shown under a result.
const ABOUT = new Map<string, string>();
for (const entry of SETTINGS_MAP) {
  const url = new URL(entry.href, "https://ensemble.test");
  const key = url.searchParams.get("dialog") ? `dialog:${url.searchParams.get("dialog")}` : url.hash.slice(1);
  if (key && !ABOUT.has(key)) ABOUT.set(key, entry.about);
}

const TAB_LABEL = new Map(SETTINGS_TABS.map((tab) => [tab.id, tab.label]));
const TAB_ORDER = new Map(SETTINGS_TABS.map((tab, index) => [tab.id, index]));

const CANDIDATES: Array<SettingsHit & { keywords: string; ownerOnly?: boolean }> = [
  ...SETTINGS_TABS.map((tab) => ({ key: `tab-${tab.id}`, label: tab.label, place: "Settings", about: tab.hint, tab: tab.id, keywords: tab.hint, ownerOnly: tab.id === "connections" || tab.id === "data" })),
  ...SETTINGS_DESTINATIONS.map((row) => {
    const tab = TAB_LABEL.get(row.tab)!;
    const heading = row.heading && row.heading !== row.label && row.heading !== tab ? row.heading : null;
    return {
      key: row.id,
      label: row.label,
      place: heading ? `${tab} › ${heading}` : tab,
      about: ABOUT.get(row.dialog ? `dialog:${row.dialog}` : row.id),
      tab: row.tab,
      anchor: row.dialog ? undefined : row.id,
      dialog: row.dialog,
      keywords: row.keywords,
      ownerOnly: row.ownerOnly,
    };
  }),
];

/** The best places in Settings for a few words, best first. Tabs that are hidden here are left out. */
export function searchSettings(query: string, options: { guest?: boolean; hidden?: readonly SettingsTab[]; limit?: number } = {}): SettingsHit[] {
  if (!normalize(query)) return [];
  const seen = new Set<string>();
  return CANDIDATES.filter((row) => !(options.guest && row.ownerOnly) && !options.hidden?.includes(row.tab))
    .map((row, index) => ({ row, index, score: settingsScore(query, row.label, row.place, row.keywords) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || TAB_ORDER.get(a.row.tab)! - TAB_ORDER.get(b.row.tab)! || a.index - b.index)
    .filter(({ row }) => {
      const key = `${row.tab}:${normalize(row.label)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, options.limit ?? 8)
    .map(({ row: { keywords: _keywords, ownerOnly: _ownerOnly, ...hit } }) => hit);
}
