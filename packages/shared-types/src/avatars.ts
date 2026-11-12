/** Circular dot avatars shared by every account, independent of profession and gender. */
export const AVATAR_CHARACTERS = [
  {
    "id": 1,
    "label": "Pausing",
    "kind": "human",
    "rows": [
      "...xx...",
      "...xo...",
      "..xxxx..",
      ".x.xx.x.",
      "...oo...",
      "..x..x..",
      "..x..x..",
      ".ax..xx."
    ],
    "voids": [
      [
        3,
        5,
        2,
        3
      ]
    ]
  },
  {
    "id": 2,
    "label": "At a desk",
    "kind": "human",
    "rows": [
      "..xx....",
      "..xo....",
      "..x.....",
      ".xxoxa..",
      ".xo..oo.",
      "..xx....",
      "...xx...",
      "....xx.."
    ],
    "voids": []
  },
  {
    "id": 3,
    "label": "Running",
    "kind": "human",
    "rows": [
      ".....xx.",
      ".....xo.",
      "...xxx..",
      "..xox.x.",
      ".x.xx...",
      "..x..x..",
      ".x....x.",
      "ax....xx"
    ],
    "voids": [
      [
        3,
        5,
        2,
        3
      ]
    ]
  },
  {
    "id": 4,
    "label": "Dancing",
    "kind": "human",
    "rows": [
      "x...xx..",
      ".x..xo..",
      "..xxx...",
      "...ox.xa",
      "...xx...",
      "..x.x...",
      ".xx..x..",
      "......x."
    ],
    "voids": [
      [
        3,
        5,
        1,
        3
      ]
    ]
  },
  {
    "id": 5,
    "label": "Reaching",
    "kind": "human",
    "rows": [
      "......xa",
      "...xx.x.",
      "...xox..",
      "..xxx...",
      ".x.ox...",
      "...xx...",
      "..x..x..",
      ".xx..xx."
    ],
    "voids": [
      [
        3,
        6,
        2,
        2
      ]
    ]
  },
  {
    "id": 6,
    "label": "Little robot",
    "kind": "humanoid",
    "rows": [
      "...a....",
      "..xxxx..",
      "..x..x..",
      "...xx...",
      ".xxooxx.",
      "...xx...",
      "..x..x..",
      "..xx.xx."
    ],
    "voids": [
      [
        3,
        2,
        2,
        1
      ],
      [
        4,
        6,
        1,
        2
      ]
    ]
  },
  {
    "id": 7,
    "label": "Visitor",
    "kind": "humanoid",
    "rows": [
      "..xxxx..",
      ".xx..xx.",
      "..xooa..",
      "...xx...",
      "..xox...",
      ".x.xx.x.",
      "...xx...",
      "..x..x.."
    ],
    "voids": [
      [
        3,
        1,
        2,
        1
      ],
      [
        3,
        7,
        2,
        1
      ]
    ]
  },
  {
    "id": 8,
    "label": "Small explorer",
    "kind": "humanoid",
    "rows": [
      "...xx...",
      "..xxxx..",
      "..xooa..",
      "...xx...",
      ".xx..xx.",
      "..xxxx..",
      "..x..x..",
      ".xx..xx."
    ],
    "voids": [
      [
        3,
        4,
        2,
        1
      ],
      [
        3,
        6,
        2,
        2
      ]
    ]
  },
  {
    "id": 9,
    "label": "Elephant",
    "kind": "animal",
    "rows": [
      "........",
      "..xxx...",
      ".xxooxx.",
      ".xxooxxx",
      ".x...x.x",
      ".x...x.x",
      ".xx..x.a",
      ".....xx."
    ],
    "voids": [
      [
        2,
        4,
        3,
        2
      ],
      [
        3,
        6,
        2,
        2
      ],
      [
        6,
        4,
        1,
        3
      ]
    ]
  },
  {
    "id": 10,
    "label": "Dog",
    "kind": "animal",
    "rows": [
      "........",
      ".....xx.",
      "x...xooa",
      ".xxxxxx.",
      "..xxxxx.",
      "..x..x..",
      "..x..x..",
      ".xx..xx."
    ],
    "voids": [
      [
        3,
        5,
        2,
        3
      ]
    ]
  },
  {
    "id": 11,
    "label": "Cat",
    "kind": "animal",
    "rows": [
      "..x..x..",
      "..xxxx..",
      "..xoox..",
      "...xx...",
      "..xxx...",
      "..xoox.x",
      "..xxxx.x",
      "..xx.xa."
    ],
    "voids": [
      [
        4,
        7,
        1,
        1
      ],
      [
        6,
        5,
        1,
        2
      ]
    ]
  },
  {
    "id": 12,
    "label": "Bird",
    "kind": "animal",
    "rows": [
      "........",
      "..x.....",
      "..xx.xx.",
      "...xxoxa",
      "..xxoxx.",
      ".xxxx...",
      "xx.x....",
      "...x...."
    ],
    "voids": []
  }
] as const;
export type AvatarCharacter = (typeof AVATAR_CHARACTERS)[number]["id"];

export const AVATAR_PALETTES = [
  { id: "apricot", label: "Apricot and raspberry", paper: "#F5F1E8", ink: "#9F4F1F", related: "#BC7D3F", accent: "#BD3D78" },
  { id: "terracotta", label: "Terracotta and coral", paper: "#F5F1E8", ink: "#954529", related: "#B46E4A", accent: "#D53F51" },
  { id: "lilac", label: "Lilac and tangerine", paper: "#F5F1E8", ink: "#68428D", related: "#9577AE", accent: "#C57828" },
  { id: "blue", label: "Blue and amber", paper: "#F5F1E8", ink: "#2E608F", related: "#5F8FB5", accent: "#B37B1C" },
  { id: "moss", label: "Moss and berry", paper: "#F5F1E8", ink: "#50692F", related: "#7D9155", accent: "#B4436D" },
  { id: "teal", label: "Teal and coral", paper: "#F5F1E8", ink: "#21645E", related: "#4F9284", accent: "#C7663C" },
] as const;
export type AvatarPalette = (typeof AVATAR_PALETTES)[number]["id"];
export const AVATAR_SCENERIES = [
  { id: "hills", label: "Hills" }, { id: "grove", label: "Grove" },
  { id: "garden", label: "Garden" }, { id: "valley", label: "Valley" }, { id: "none", label: "Plain" },
] as const;
export type AvatarScenery = (typeof AVATAR_SCENERIES)[number]["id"];
export type AvatarParts = { character: AvatarCharacter; palette: AvatarPalette; scenery: AvatarScenery };
export const DEFAULT_AVATAR: AvatarParts = { character: 1, palette: "apricot", scenery: "hills" };

/** A stable initial selection from a new opaque account seed, never profile attributes. */
export function defaultAvatarId(seed: string): string {
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619) >>> 0;
  return avatarId({ character: AVATAR_CHARACTERS[hash % AVATAR_CHARACTERS.length]!.id, palette: AVATAR_PALETTES[Math.floor(hash / 12) % AVATAR_PALETTES.length]!.id, scenery: "hills" });
}

/** Stored ids are versioned by their family; no gender or profession is part of a new selection. */
export function avatarId({ character, palette, scenery }: AvatarParts): string {
  return `dots.${character}.${palette}.${scenery}`;
}

const LEGACY_COLORS: Record<string, AvatarPalette> = { sky: "blue", mint: "teal", peach: "apricot", rose: "lilac", slate: "blue" };
const LEGACY_ROLES: Record<string, string> = { engineer: "sky", lawyer: "slate", teacher: "peach", student: "sky", manager: "mint", vibe: "rose" };

/** Existing saved portraits resolve to stable dot characters without rewriting account data. */
export function parseAvatar(id: string | null | undefined): AvatarParts | null {
  if (!id) return null;
  const parts = id.split(".");
  if (parts[0] === "dots") {
    const [_, raw, palette, scenery] = parts;
    if (parts.length !== 4 || !/^(?:[1-9]|1[0-2])$/.test(raw ?? "")) return null;
    if (!AVATAR_PALETTES.some(row => row.id === palette) || !AVATAR_SCENERIES.some(row => row.id === scenery)) return null;
    return { character: Number(raw) as AvatarCharacter, palette: palette as AvatarPalette, scenery: scenery as AvatarScenery };
  }
  const [role, gender, raw, background] = parts;
  if (parts.length < 3 || parts.length > 4 || !role || !Object.hasOwn(LEGACY_ROLES, role)) return null;
  if (!["f", "m", "n"].includes(gender ?? "") || !/^\d+$/.test(raw ?? "")) return null;
  const number = Number(raw);
  if (!Number.isInteger(number) || number < 1 || number > 10) return null;
  if (background !== undefined && !Object.hasOwn(LEGACY_COLORS, background)) return null;
  return { character: number as AvatarCharacter, palette: LEGACY_COLORS[background ?? LEGACY_ROLES[role]!]!, scenery: "hills" };
}

export function isAvatarId(id: unknown): id is string {
  return typeof id === "string" && parseAvatar(id) !== null;
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
