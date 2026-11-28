import { useQuery, type QueryClient } from "@tanstack/react-query";
import { labelTone, type BoardLabelRecord, type LabelColor } from "@ensemble/shared-types";
import { api, type LabelListOf } from "./api";

/** The query key of one list: a board's (`ensemble` or a custom board's id), or the one an item picks from. */
export function labelListKey(of: LabelListOf): readonly string[] {
  const [kind, id] = Object.entries(of)[0] as [string, string];
  return ["labels", kind, id];
}

/** A board's labels (docs/02 §3.2), or the list an item picks from. */
export function useLabelList(of: LabelListOf | null) {
  return useQuery({
    queryKey: of ? labelListKey(of) : ["labels", "none"],
    queryFn: () => api.labels(of!),
    enabled: Boolean(of),
    staleTime: 30_000,
  });
}

/** Colours by lower-case name. */
export function labelColors(labels: readonly BoardLabelRecord[] | undefined): ReadonlyMap<string, LabelColor> {
  return new Map((labels ?? []).map((label) => [label.name.toLowerCase(), label.color]));
}

/** A label's colour on its board; a name the board does not have yet keeps the colour its name gives it. */
export function colorOfLabel(name: string, colors: ReadonlyMap<string, LabelColor> | null | undefined): LabelColor {
  return colors?.get(name.toLowerCase()) ?? labelTone(name);
}

/** After a label is renamed, recoloured or deleted: the lists and every item that shows labels. */
export function refreshLabelQueries(client: QueryClient): void {
  for (const queryKey of [["labels"], ["tasks"], ["task"], ["boards"], ["pages"], ["standalone-page"], ["deliverables"], ["home"]]) {
    void client.invalidateQueries({ queryKey });
  }
}
