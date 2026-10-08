"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { api, currentShare, type Entity } from "./api";

/** A stable getter the editor can call from inside ProseMirror plugins without re-creating them. */
export function useEntities(enabled = true) {
  // One shared item never lists the rest of its owner's space.
  const query = useQuery({ queryKey: ["entities"], queryFn: api.entities, staleTime: 60_000, enabled: enabled && !currentShare() });
  const ref = useRef<Entity[]>([]);
  ref.current = query.data?.entities ?? ref.current;
  const get = useCallback(() => ref.current, []);
  return { get, entities: query.data?.entities ?? [], loading: query.isLoading };
}
