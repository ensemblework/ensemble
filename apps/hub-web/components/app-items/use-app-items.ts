"use client";

import { useQuery } from "@tanstack/react-query";
import type { AppItemSourceInfo } from "@ensemble/shared-types";
import { inItemView } from "@/lib/api";
import { APP_ITEM_QUERY, appItemsApi } from "@/lib/api-app-items";
import { useSpaceAccess } from "@/lib/access";
import { brandName } from "../connectors/brand-logo";

/**
 * Connected apps Ensemble can search. Always empty in a space shared with you
 * and on a shared item: connected apps belong to the space's owner.
 */
export function useAppItemSources() {
  const access = useSpaceAccess();
  const allowed = access.ready && !access.guest && !inItemView();
  const query = useQuery({ queryKey: APP_ITEM_QUERY.sources, queryFn: appItemsApi.sources, enabled: allowed, staleTime: 60_000, retry: false });
  const sources: AppItemSourceInfo[] = allowed ? (query.data?.sources ?? []) : [];
  const loading = allowed ? query.isPending : !access.ready && !inItemView();
  return { sources, allowed, loading, error: query.error as Error | null };
}

/** Name and logo for a source id, also when the app has since been disconnected. */
export function sourceInfo(sources: readonly AppItemSourceInfo[], id: string): { name: string; logo: string } {
  const found = sources.find((source) => source.id === id);
  return found ? { name: found.name, logo: found.logo } : { name: brandName(id), logo: id };
}
