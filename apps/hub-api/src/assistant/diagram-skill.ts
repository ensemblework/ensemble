import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FILE = "SKILL.md";

function candidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    resolve(here, "../../../../.github/skills/block-diagrams", FILE),
    resolve(process.cwd(), ".github/skills/block-diagrams", FILE),
    resolve(process.cwd(), "../../.github/skills/block-diagrams", FILE),
  ];
}

let cached: string | null = null;

/** The block-diagram skill, loaded from the repo so the assistant and the file stay one text. */
export function diagramSkillText(): string {
  if (cached) return cached;
  for (const path of candidates()) {
    try {
      cached = readFileSync(path, "utf8");
      return cached;
    } catch {
      /* try the next place the process might be started from */
    }
  }
  cached = "When the person asks for a diagram, use hub_validate_diagram, then hub_create_diagram or hub_update_diagram. Do not invent blocks.";
  return cached;
}

/** Full skill only when this turn is about a diagram. Other turns keep the short rule in the standing prompt. */
export function diagramGuidance(message: string, path?: string): string {
  const onDiagram = Boolean(path && /\/diagrams(?:\/|$)/.test(path));
  const asked = /\bdiagrams?\b|flowchart|architecture sketch|block diagram/i.test(message);
  if (!onDiagram && !asked) return "";
  return diagramSkillText();
}
