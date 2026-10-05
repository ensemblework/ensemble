import type { TaskComplexity } from "@prisma/client";

export function inferComplexity(input: { title: string; description?: string }): TaskComplexity {
  const text = `${input.title} ${input.description ?? ""}`.toLowerCase();
  if (/\b(adr|architecture|migrate|redesign|multi-repo)\b/.test(text)) return "high";
  if (/\b(reply|bump|rename|typo|nit)\b/.test(text)) return "easy";
  if (/\b(refactor|investigate|load test)\b/.test(text)) return "high";
  return "medium";
}
