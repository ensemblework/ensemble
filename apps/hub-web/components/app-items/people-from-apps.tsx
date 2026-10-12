"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import type { AppItemSourceInfo } from "@ensemble/shared-types";
import { appItemsApi, type PeopleImport } from "@/lib/api-app-items";
import { plural } from "@/lib/format";
import { BrandLogo } from "../connectors/brand-logo";
import { useToast } from "../toast";
import { MenuItem, Popover, Spinner } from "../ui";
import { useAppItemSources } from "./use-app-items";

export function peopleAddedText(result: PeopleImport, app: string): string {
  const known = result.matched ? ` (${result.matched} already known)` : "";
  if (result.added) return `Added ${plural(result.added, "person", "people")} from ${app}${known}.`;
  return result.matched ? `No one new in ${app}${known}.` : `${app} had no one to add.`;
}

/** "Add people from…": a connected app's members, matched to People by email or handle. */
export function AddPeopleFromApps() {
  const client = useQueryClient();
  const toast = useToast();
  const { sources } = useAppItemSources();
  const withPeople = sources.filter((source) => source.people);
  const add = useMutation({
    mutationFn: (source: AppItemSourceInfo) => appItemsApi.addPeople(source.id),
    onSuccess: (result, source) => {
      toast(peopleAddedText(result, source.name), { tone: "ok" });
      void client.invalidateQueries({ queryKey: ["people"] });
      void client.invalidateQueries({ queryKey: ["entities"] });
      void client.invalidateQueries({ queryKey: ["desk-live"] });
    },
    onError: (error) => toast((error as Error).message, { tone: "error" }),
  });
  if (!withPeople.length) return null;
  return (
    <Popover
      align="right"
      width={220}
      trigger={(_open, toggle) => (
        <button type="button" className="btn" disabled={add.isPending} onClick={toggle}>
          {add.isPending ? <Spinner size={12} /> : <UserPlus size={13} />} Add people from…
        </button>
      )}
    >
      {(close) =>
        withPeople.map((source) => (
          <MenuItem
            key={source.id}
            onClick={() => {
              close();
              add.mutate(source);
            }}
          >
            <BrandLogo id={source.logo} name={source.name} size={16} decorative />
            {source.name}
          </MenuItem>
        ))
      }
    </Popover>
  );
}
