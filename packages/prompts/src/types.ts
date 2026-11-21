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
