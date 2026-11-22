/** One section file as the generator stores it (scripts/generate.mjs). */
export type GeneratedSection = {
  /** The folder under sections/: `constitution` (every surface) or the surface that owns it. */
  folder: string;
  /** The text sent to the model: notes for people removed, trimmed. */
  text: string;
  /** The {{variables}} the text uses. */
  vars: readonly string[];
  /** SHA-256 of `text`, hex. */
  sha256: string;
};

/** One bundled skill (skills/<name>/SKILL.md at the repository root) as the generator stores it. */
export type BundledSkill = {
  /** The folder's name: lower-case words joined by hyphens. */
  name: string;
  /** When to use it, starting "Use when", at most 500 characters. */
  description: string;
  license: string;
  /** `metadata.priority`: p0 for the process skills (they lead others the request fits as well), else p1 or p2. */
  priority: string;
  /** `metadata.keywords`: words and phrases in a request that call for it. */
  keywords: readonly string[];
  /** `metadata.tools`: it is offered only when a turn has one of these tools; empty when it needs none. */
  tools: readonly string[];
  /** Every metadata field as written. */
  metadata: Readonly<Record<string, string>>;
  /** The instructions after the frontmatter, notes for people removed. */
  body: string;
  /** SHA-256 of the frontmatter fields and the body, hex. */
  sha256: string;
};
