/**
 * Picture avatars: 15 per profession (5 women, 5 men, 5 gender-neutral), drawn in the Hub
 * from the id alone (`components/avatars/persona.tsx`). An id is `role.gender.n`, for example
 * `lawyer.f.3`. A person without one shows their initials.
 */
export const AVATAR_ROLES = ["engineer", "lawyer", "teacher", "student", "manager", "vibe"] as const;
export type AvatarRole = (typeof AVATAR_ROLES)[number];
export const AVATAR_GENDERS = ["f", "m", "n"] as const;
export type AvatarGender = (typeof AVATAR_GENDERS)[number];
export const AVATARS_PER_GROUP = 5;

export const AVATAR_ROLE_LABEL: Record<AvatarRole, string> = {
  engineer: "Engineer",
  lawyer: "Lawyer",
  teacher: "Teacher",
  student: "Student",
  manager: "Manager",
  vibe: "Maker",
};

export const AVATAR_GENDER_LABEL: Record<AvatarGender, string> = { f: "Women", m: "Men", n: "Neutral" };

export type AvatarParts = { role: AvatarRole; gender: AvatarGender; n: number };

export function parseAvatar(id: string | null | undefined): AvatarParts | null {
  if (!id) return null;
  const [role, gender, raw] = id.split(".");
  const n = Number(raw);
  if (!(AVATAR_ROLES as readonly string[]).includes(role ?? "")) return null;
  if (!(AVATAR_GENDERS as readonly string[]).includes(gender ?? "")) return null;
  if (!Number.isInteger(n) || n < 1 || n > AVATARS_PER_GROUP) return null;
  return { role: role as AvatarRole, gender: gender as AvatarGender, n };
}

export function isAvatarId(id: unknown): id is string {
  return typeof id === "string" && parseAvatar(id) !== null;
}

export function avatarIds(role: AvatarRole, gender: AvatarGender): string[] {
  return Array.from({ length: AVATARS_PER_GROUP }, (_, index) => `${role}.${gender}.${index + 1}`);
}

/** The avatar set that fits a signup role or a free-text profession. */
export function avatarRoleFor(role: string | null | undefined, profession?: string | null): AvatarRole {
  if (role && (AVATAR_ROLES as readonly string[]).includes(role)) return role as AvatarRole;
  const text = `${role ?? ""} ${profession ?? ""}`.toLowerCase();
  if (/law|legal|advocate|attorney|counsel/.test(text)) return "lawyer";
  if (/teach|professor|lecturer|tutor|educat/.test(text)) return "teacher";
  if (/student|learn|school|college|phd/.test(text)) return "student";
  if (/manag|lead|founder|director|product|ceo/.test(text)) return "manager";
  if (/design|creat|maker|artist|writer|vibe/.test(text)) return "vibe";
  return "engineer";
}

/** The gender group shown first, from the profile's gender answer. */
export function avatarGenderFor(gender: string | null | undefined): AvatarGender {
  if (gender === "Woman") return "f";
  if (gender === "Man") return "m";
  return "n";
}
