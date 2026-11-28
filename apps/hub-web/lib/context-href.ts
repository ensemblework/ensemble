/**
 * Context's old widgets view (`?view=widgets`) and its Preferences, Sources and Artifacts tabs are gone.
 * An old or remembered link to them lands on Context itself: the same tab when Context has it (People,
 * Projects, Repos, Graph and the profile's own tabs), otherwise Overview. Other parameters stay.
 * Returns null when the address needs no change. Used by the server page and by the packaged UI.
 */
const GONE_TABS = new Set(["preferences", "sources", "artifacts"]);

export function cleanContextHref(params: URLSearchParams): string | null {
  const tab = params.get("tab") ?? "";
  if (params.get("view") !== "widgets" && !GONE_TABS.has(tab)) return null;
  const next = new URLSearchParams(params);
  next.delete("view");
  if (GONE_TABS.has(tab) || tab === "overview") next.delete("tab");
  const query = next.toString();
  return query ? `/context?${query}` : "/context";
}
