import { MAX_FAVOURITES, type ThemeFavourite } from "./types.js";

export type FavouriteResult =
  | { ok: true; favourites: ThemeFavourite[] }
  | { ok: false; reason: "limit"; favourites: ThemeFavourite[] };

export function addFavourite(list: readonly ThemeFavourite[], next: ThemeFavourite): FavouriteResult {
  if (list.some((item) => item.id === next.id)) return { ok: true, favourites: [...list] };
  if (list.length >= MAX_FAVOURITES) return { ok: false, reason: "limit", favourites: [...list] };
  return { ok: true, favourites: [...list, clip(next)] };
}

export function replaceFavourite(list: readonly ThemeFavourite[], removeId: string, next: ThemeFavourite): ThemeFavourite[] {
  return [...list.filter((item) => item.id !== removeId && item.id !== next.id), clip(next)].slice(0, MAX_FAVOURITES);
}

export function removeFavourite(list: readonly ThemeFavourite[], id: string): ThemeFavourite[] {
  return list.filter((item) => item.id !== id);
}

/** Next starred theme. Returns null when nothing is starred. */
export function cycleFavourite(list: readonly ThemeFavourite[], activeId: string, direction: 1 | -1 = 1): string | null {
  if (!list.length) return null;
  const index = list.findIndex((item) => item.id === activeId);
  const next = index === -1 ? (direction === 1 ? 0 : list.length - 1) : (index + direction + list.length) % list.length;
  return list[next]?.id ?? null;
}

function clip(item: ThemeFavourite): ThemeFavourite {
  return { ...item, label: item.label.slice(0, 80) };
}
