export type SaveObject = Record<string, unknown>;
export type SaveClash = { path: string[]; saved: unknown; yours: unknown };
export type SaveConflict = { code: "SAVE_CONFLICT"; current: SaveObject; patch: SaveObject; conflicts: SaveClash[] };
export class InvalidSaveFieldError extends Error {
  readonly statusCode = 400;
  constructor() { super("Invalid save field."); }
}

export const saveObject = (value: unknown): value is SaveObject => value !== null && typeof value === "object" && !Array.isArray(value);

export function sameSaveValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => sameSaveValue(value, b[index]));
  if (!saveObject(a) || !saveObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameSaveValue(a[key], b[key]));
}

export function mergeSaveObject(base: SaveObject, patch: SaveObject): SaveObject {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw new InvalidSaveFieldError();
    result[key] = saveObject(value) && saveObject(base[key]) ? mergeSaveObject(base[key], value) : value;
  }
  return result;
}

/** Only changed leaves are written. Arrays are one value, never merged by position. */
export function compareSave(base: SaveObject, current: SaveObject, proposed: SaveObject) {
  const conflicts: SaveClash[] = [];
  const walk = (before: SaveObject, saved: SaveObject, wanted: SaveObject, prefix: string[]): SaveObject => {
    const patch: SaveObject = {};
    for (const [key, value] of Object.entries(wanted)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new InvalidSaveFieldError();
      if (sameSaveValue(value, before[key])) continue;
      const path = [...prefix, key];
      if (saveObject(value) && saveObject(before[key]) && saveObject(saved[key])) {
        const nested = walk(before[key], saved[key], value, path);
        if (Object.keys(nested).length) patch[key] = nested;
      } else {
        patch[key] = value;
        if (!sameSaveValue(before[key], saved[key]) && !sameSaveValue(value, saved[key])) conflicts.push({ path, saved: saved[key] ?? null, yours: value ?? null });
      }
    }
    return patch;
  };
  return { patch: walk(base, current, proposed, []), conflicts };
}

export function resolveSave(conflict: SaveConflict, choice: "saved" | "yours"): SaveObject {
  if (choice === "yours") return conflict.patch;
  const patch = structuredClone(conflict.patch);
  for (const clash of conflict.conflicts) {
    let target = patch;
    for (const key of clash.path.slice(0, -1)) {
      const nested = target[key];
      const next = saveObject(nested) ? nested : {};
      target[key] = next;
      target = next;
    }
    target[clash.path.at(-1)!] = clash.saved;
  }
  return patch;
}
