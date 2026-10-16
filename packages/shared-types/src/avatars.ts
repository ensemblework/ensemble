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

/** Each word's letters and digits: "Mary-Jane O'Neil" reads as MaryJane, ONeil. Code points, so an accent or emoji is never split. */
function nameWords(text: string): string[][] {
  return text
    .normalize("NFC")
    .trim()
    .split(/\s+/)
    .map((word) => Array.from(word.replace(/[^\p{L}\p{N}]/gu, "")))
    .filter((chars) => chars.length > 0);
}

/**
 * Initials for a person without a picture avatar. The API and the Hub both use this, so a person
 * reads the same everywhere: the first letter or digit of the first and last words ("Test Five" →
 * TF, "Test 3" → T3), the first two of a one-word name, else from the email's local part.
 */
export function personInitials(name?: string | null, email?: string | null): string {
  const words = nameWords(name ?? "");
  if (words.length >= 2) return `${words[0]![0]}${words[words.length - 1]![0]}`.toUpperCase();
  if (words.length === 1) return words[0]!.slice(0, 2).join("").toUpperCase();
  const local = ((email ?? "").split("@")[0] ?? "").split("+")[0]!.replace(/[._-]+/g, " ");
  const parts = nameWords(local).filter((chars) => chars.some((char) => /\p{L}/u.test(char)));
  if (parts.length >= 2) return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
  return (parts[0] ?? []).slice(0, 2).join("").toUpperCase();
}

/**
 * Initials for people shown side by side. Two different names that would read the same ("Test
 * Two", "Test Three": TT) each get the next letter of their last word (TTw, TTh).
 */
export function distinctInitials(people: ReadonlyArray<{ name: string; initials?: string | null }>): string[] {
  const base = people.map((person) => person.initials || personInitials(person.name));
  return base.map((value, index) => {
    const name = people[index]!.name;
    if (!base.some((other, at) => at !== index && other === value && people[at]!.name !== name)) return value;
    const words = nameWords(name);
    const last = words[words.length - 1];
    if (words.length < 2 || !last || last.length < 2) return value;
    return `${words[0]![0]!.toUpperCase()}${last[0]!.toUpperCase()}${last[1]!.toLowerCase()}`;
  });
}

/** The gender group shown first, from the profile's gender answer. */
export function avatarGenderFor(gender: string | null | undefined): AvatarGender {
  if (gender === "Woman") return "f";
  if (gender === "Man") return "m";
  return "n";
}
