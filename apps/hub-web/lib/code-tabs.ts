/**
 * How many files the Code tab keeps open. Every open file's text lives in the browser (its versions
 * and any edit), so the IDE keeps at most MAX_OPEN_FILES: opening one more closes the oldest open
 * file that has nothing unsaved. Nothing is kept anywhere else: a closed file's text is dropped
 * from the browser's memory once it is saved (components/code/ide.tsx).
 */
export const MAX_OPEN_FILES = 10;

export type TabOpen = { tabs: string[]; closed: string | null } | { refused: string };

/** The tabs after opening `path`. `busy(path)`: that file has an edit not yet saved. */
export function openTab(tabs: string[], path: string, active: string | null, busy: (path: string) => boolean, max = MAX_OPEN_FILES): TabOpen {
  if (tabs.includes(path)) return { tabs, closed: null };
  if (tabs.length < max) return { tabs: [...tabs, path], closed: null };
  const oldest = tabs.find((row) => row !== active && !busy(row));
  if (!oldest) return { refused: `Up to ${max} files can be open at once. Close one, or wait until your edits are saved.` };
  return { tabs: [...tabs.filter((row) => row !== oldest), path], closed: oldest };
}
