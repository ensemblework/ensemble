"use client";
import { useEffect, useRef } from "react";
import type { AssistantPageContext } from "@ensemble/shared-types";
type Surface = NonNullable<AssistantPageContext["surface"]>;
const surfaces = new Map<string, Map<symbol, Partial<Surface>>>();

/** Only structured view state is supplied: filters, chosen record IDs and tile geometry. */
export function useAssistantSurface(path: string, value: Partial<Surface>) {
  const id = useRef(Symbol("surface"));
  const encoded = JSON.stringify(value);
  useEffect(() => {
    let entries = surfaces.get(path);
    if (!entries) { entries = new Map(); surfaces.set(path, entries); }
    entries.set(id.current, JSON.parse(encoded));
    return () => { entries!.delete(id.current); if (!entries!.size) surfaces.delete(path); };
  }, [path, encoded]);
}

export function assistantSurface(path: string): Surface | undefined {
  const entries = surfaces.get(path);
  if (!entries?.size) return undefined;
  const result = Object.assign({}, ...entries.values()) as Surface;
  return result.kind ? result : undefined;
}
