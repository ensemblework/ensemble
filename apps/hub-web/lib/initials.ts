/** First and last initials for an account or person. An email falls back to its local part. */
export function personInitials(name?: string | null, email?: string | null): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0]![0]}${words[words.length - 1]![0]}`.toUpperCase();
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  const local = (email ?? "").split("@")[0] ?? "";
  const parts = local.split(/[._\-+]+/).filter((part) => /[a-z]/i.test(part));
  if (parts.length >= 2) return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  const letters = local.replace(/[^a-z]/gi, "");
  return letters.slice(0, 2).toUpperCase();
}

export function firstName(name?: string | null): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? "";
}
