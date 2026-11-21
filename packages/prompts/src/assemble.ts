import { createHash } from "node:crypto";
import { SECTIONS, type SectionName } from "./sections.generated.js";

/**
 * The three tiers of a request. `stable` (the constitution, a role and what it can do) is the same
 * byte for byte while the setup is the same; `context` (who is here, memories, skills) changes between
 * turns and is information, not instructions; `volatile` is the turn packet itself.
 */
export type Tier = "stable" | "context" | "volatile";
export const TIERS: readonly Tier[] = ["stable", "context", "volatile"];

/** Who the instructions are for. A surface may use its own folder's sections and the constitution's. */
export type Surface = "assistant" | "node" | "code";

/** A variable's value. A list renders one item per line; an empty list leaves its section out. */
export type Value = string | readonly string[];

export type SectionRequest = {
  name: SectionName;
  tier: Tier;
  /** Lower fills its tier's budget first. Default 0. */
  priority?: number;
  /** This section's variables, over the shared ones. */
  vars?: Readonly<Record<string, Value>>;
  /** A list variable whose last items are left out, whole, when the section does not fit its budget. */
  trim?: string;
};

export type AssembleInput = {
  surface: Surface;
  sections: readonly SectionRequest[];
  vars?: Readonly<Record<string, Value>>;
  /** Tokens per tier (characters / 4). A tier without one has no limit. */
  budgets?: Partial<Record<Tier, number>>;
};

export type AssembledSection = { name: string; tier: Tier; chars: number; tokens: number };

/** A section, or some items of its list, left out to fit its tier's budget. */
export type DroppedSection = { name: string; tier: Tier; reason: "budget"; tokens: number; items?: number };

export type Assembled = {
  /** Every tier, in order, separated by a blank line. */
  text: string;
  tiers: Record<Tier, string>;
  /** Hash of the section files used: which instruction files, at which revision. */
  version: string;
  /** Hash of `text`; `hashes` has one per tier. */
  hash: string;
  hashes: Record<Tier, string>;
  sections: AssembledSection[];
  dropped: DroppedSection[];
};

const SEPARATOR = "\n\n";
const VARIABLE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/** Characters / 4, the estimate used for every budget and log. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const shortHash = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** A section's text before its variables are filled in. */
export function sectionText(name: SectionName): string {
  const section = SECTIONS[name] as { text: string } | undefined;
  if (!section) throw new Error(`Unknown prompt section ${name}.`);
  return section.text;
}

/** A section with its variables filled in. A variable it uses must be given (an empty string is fine). */
export function renderSection(name: SectionName, vars: Readonly<Record<string, Value>> = {}): string {
  return fill(name, sectionText(name), vars);
}

function fill(name: string, text: string, vars: Readonly<Record<string, Value>>): string {
  return text.replace(VARIABLE, (_whole, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`Prompt section ${name} needs {{${key}}}.`);
    return typeof value === "string" ? value : value.join("\n");
  }).trim();
}

function allowed(surface: Surface, name: string): boolean {
  const folder = name.slice(0, name.indexOf("/"));
  return folder === "constitution" || folder === surface;
}

type Piece = { request: SectionRequest; index: number; text: string; vars: Readonly<Record<string, Value>> };

/**
 * The instructions for one request: the sections asked for, in the order given within each tier,
 * each tier filled up to its budget in priority order. A section that does not fit is left out
 * whole, or loses the last items of its `trim` list; either way it is listed in `dropped`. A section
 * that renders empty, or shows an empty list, is left out without a note.
 */
export function assemble(input: AssembleInput): Assembled {
  const shared = input.vars ?? {};
  const kept: Piece[] = [];
  const dropped: DroppedSection[] = [];
  input.sections.forEach((request, index) => {
    if (!allowed(input.surface, request.name)) throw new Error(`Prompt section ${request.name} is not for the ${input.surface} surface.`);
    const vars = { ...shared, ...request.vars };
    const lists = (SECTIONS[request.name].vars as readonly string[]).filter((key) => Array.isArray(vars[key]));
    if (lists.some((key) => (vars[key] as readonly string[]).length === 0)) return;
    const text = fill(request.name, sectionText(request.name), vars);
    if (text) kept.push({ request, index, text, vars });
  });

  const chosen: Piece[] = [];
  for (const tier of TIERS) {
    const pieces = kept.filter((piece) => piece.request.tier === tier);
    const budget = input.budgets?.[tier];
    if (budget === undefined) {
      chosen.push(...pieces);
      continue;
    }
    let room = budget * 4;
    const byPriority = [...pieces].sort((a, b) => (a.request.priority ?? 0) - (b.request.priority ?? 0) || a.index - b.index);
    for (const piece of byPriority) {
      const cost = piece.text.length + SEPARATOR.length;
      if (cost <= room) {
        chosen.push(piece);
        room -= cost;
        continue;
      }
      const fitted = piece.request.trim ? trimToFit(piece, room - SEPARATOR.length) : null;
      if (fitted) {
        chosen.push(fitted.piece);
        room -= fitted.piece.text.length + SEPARATOR.length;
        dropped.push({ name: piece.request.name, tier, reason: "budget", tokens: estimateTokens(piece.text) - estimateTokens(fitted.piece.text), items: fitted.items });
      } else {
        dropped.push({ name: piece.request.name, tier, reason: "budget", tokens: estimateTokens(piece.text) });
      }
    }
  }
  chosen.sort((a, b) => TIERS.indexOf(a.request.tier) - TIERS.indexOf(b.request.tier) || a.index - b.index);

  const tiers = Object.fromEntries(TIERS.map((tier) => [tier, chosen.filter((piece) => piece.request.tier === tier).map((piece) => piece.text).join(SEPARATOR)])) as Record<Tier, string>;
  const text = TIERS.map((tier) => tiers[tier]).filter(Boolean).join(SEPARATOR);
  const files = [...new Set(chosen.map((piece) => `${piece.request.name}:${SECTIONS[piece.request.name].sha256}`))].sort();
  return {
    text,
    tiers,
    version: shortHash(files.join("\n")),
    hash: shortHash(text),
    hashes: Object.fromEntries(TIERS.map((tier) => [tier, shortHash(tiers[tier])])) as Record<Tier, string>,
    sections: chosen.map((piece) => ({ name: piece.request.name, tier: piece.request.tier, chars: piece.text.length, tokens: estimateTokens(piece.text) })),
    dropped,
  };
}

/** The piece with as many of its `trim` list's first items as fit in `room` characters, or null when none fit. */
function trimToFit(piece: Piece, room: number): { piece: Piece; items: number } | null {
  const key = piece.request.trim!;
  const list = piece.vars[key];
  if (!Array.isArray(list)) throw new Error(`Prompt section ${piece.request.name} trims {{${key}}}, which is not a list.`);
  for (let count = list.length - 1; count > 0; count -= 1) {
    const vars = { ...piece.vars, [key]: list.slice(0, count) };
    const text = fill(piece.request.name, sectionText(piece.request.name), vars);
    if (text.length <= room) return { piece: { ...piece, text, vars }, items: list.length - count };
  }
  return null;
}
