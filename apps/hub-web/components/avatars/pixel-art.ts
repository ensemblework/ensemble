import { AVATAR_CHARACTERS, type AvatarCharacter, type AvatarScenery } from "@ensemble/shared-types";

export type AvatarDot = { x: number; y: number; tone: "x" | "o" | "a" };
export type SceneryPixel = { x: number; y: number; related: boolean; opacity: number };

export const AVATAR_DOTS: ReadonlyMap<AvatarCharacter, readonly AvatarDot[]> = new Map(AVATAR_CHARACTERS.map(character => [character.id,
  character.rows.flatMap((row, y) => [...row].flatMap((tone, x) => tone === "." ? [] : [{ x: 15 + x * 6, y: 15 + y * 6, tone: tone as AvatarDot["tone"] }])),
]));

function makeScenery(character: (typeof AVATAR_CHARACTERS)[number], scenery: AvatarScenery): readonly SceneryPixel[] {
  if (scenery === "none") return [];
  const cells = new Map<string, { x: number; y: number; related: boolean; amount: number }>();
  const tile = (x: number, y: number, related = false, amount = 1) => {
    if (x >= 0 && x < 12 && y >= 0 && y < 12) cells.set(`${x}:${y}`, { x, y, related, amount });
  };
  const ground = () => { for (let x = 0; x < 12; x++) tile(x, 11, true, 1.08); };
  if (scenery === "grove") {
    for (const [cx, top] of [[1, 2], [10, 0]] as const) {
      tile(cx, top, true, .75);
      for (let dx = -1; dx <= 1; dx++) tile(cx + dx, top + 1, true, .8);
      for (let dx = -2; dx <= 2; dx++) { tile(cx + dx, top + 2, true, .9); tile(cx + dx, top + 3, true, .95); }
      for (let y = top + 4; y < 11; y++) tile(cx, y, false, .7);
    }
    ground();
  } else if (scenery === "garden") {
    for (const [x, top] of [[1, 5], [10, 4]] as const) {
      for (let y = top; y < 11; y++) tile(x, y, false, .75);
      for (const [a, b] of [[x - 1, top], [x + 1, top - 1], [x - 1, top + 2], [x + 1, top + 3], [x, top - 2]] as const) tile(a, b, true, .95);
    }
    for (const [x, y] of [[4, 10], [5, 9], [5, 10], [6, 10], [8, 10], [8, 9], [7, 8]] as const) tile(x, y, true, .6);
    ground();
  } else {
    const ridge = scenery === "hills" ? [8, 7, 6, 5, 4, 3, 4, 5, 6, 5, 6, 7] : [3, 4, 5, 6, 8, 9, 9, 8, 6, 5, 4, 3];
    ridge.forEach((start, x) => { for (let y = start; y < 12; y++) tile(x, y, false, .6); });
    const near = scenery === "hills" ? [11, 10, 9, 9, 10, 10, 9, 8, 8, 9, 10, 11] : [9, 10, 10, 11, 11, 11, 11, 11, 11, 10, 10, 9];
    near.forEach((start, x) => { for (let y = start; y < 12; y++) tile(x, y, true, 1.05); });
    for (const [x, y] of [[0, 2], [1, 1], [1, 2], [2, 2], [9, 1], [10, 1], [10, 2], [11, 2]] as const) tile(x, y, true, .4);
  }
  const dots = AVATAR_DOTS.get(character.id)!;
  return [...cells.values()].flatMap(({ x, y, related, amount }) => {
    const cx = x * 6 + 3, cy = y * 6 + 3;
    if (character.voids.some(([col, row, width, height]) => cx >= 12 + col * 6 && cx < 12 + (col + width) * 6 && cy >= 12 + row * 6 && cy < 12 + (row + height) * 6)) return [];
    const near = dots.some(dot => Math.hypot(dot.x - cx, dot.y - cy) < 4.4);
    return [{ x: x * 6, y: y * 6, related, opacity: Number((.24 * amount * (near ? .4 : 1)).toFixed(3)) }];
  });
}

/** Fixed geometry is shared by small presence stacks and the larger account picker. */
const SCENERY = new Map(AVATAR_CHARACTERS.map(character => [character.id, {
  hills: makeScenery(character, "hills"), grove: makeScenery(character, "grove"),
  garden: makeScenery(character, "garden"), valley: makeScenery(character, "valley"), none: [],
}]));

export function avatarScenery(character: AvatarCharacter, scenery: AvatarScenery): readonly SceneryPixel[] {
  return SCENERY.get(character)?.[scenery] ?? [];
}
