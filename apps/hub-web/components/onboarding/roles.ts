import { Briefcase, Code2, GraduationCap, Presentation, Scale, Sparkles, type LucideIcon } from "lucide-react";

export type Role = "student" | "teacher" | "lawyer" | "engineer" | "vibe" | "manager";

export const ROLES: ReadonlyArray<{ id: Role; label: string; line: string; icon: LucideIcon; profession: string; org: string }> = [
  { id: "student", label: "Student", line: "Classes, exams, and group work", icon: GraduationCap, profession: "Student", org: "School or university" },
  { id: "teacher", label: "Teacher", line: "Lessons, marking, and check-ins", icon: Presentation, profession: "Teacher", org: "School" },
  { id: "lawyer", label: "Lawyer", line: "Matters, drafts, and dates", icon: Scale, profession: "Lawyer", org: "Firm or company" },
  { id: "engineer", label: "Engineer", line: "Reviews, releases, and on-call", icon: Code2, profession: "Engineer", org: "Company" },
  { id: "vibe", label: "Builder", line: "Ship a side project with AI", icon: Sparkles, profession: "Builder", org: "Project or company" },
  { id: "manager", label: "Manager", line: "The team, 1:1s, and goals", icon: Briefcase, profession: "Manager", org: "Company" },
];

/** Guesses the role from a profession typed earlier, so returning people skip the question. */
export function roleFromProfession(profession: string | null | undefined): Role | null {
  const text = (profession ?? "").toLowerCase();
  if (!text) return null;
  if (/student|undergrad|phd|grad/.test(text)) return "student";
  if (/teach|lecturer|professor|tutor/.test(text)) return "teacher";
  if (/law|advocate|counsel|attorney|solicitor|barrister/.test(text)) return "lawyer";
  if (/manager|lead|director|head|vp|founder|ceo/.test(text)) return "manager";
  if (/builder|maker|vibe|indie/.test(text)) return "vibe";
  if (/engineer|developer|programmer|swe|devops|data/.test(text)) return "engineer";
  return null;
}
