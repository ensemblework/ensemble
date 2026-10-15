/** One rule for initials across the API and the Hub (`packages/shared-types/src/avatars.ts`). */
export { distinctInitials, personInitials } from "@ensemble/shared-types";

export function firstName(name?: string | null): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? "";
}
