/**
 * What goes into a committed trace or result: secret-looking values replaced, this computer's home and
 * the run's scratch folder named by placeholders, and long text cut so a trace stays small.
 */
import { homedir } from "node:os";

const SECRETS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bens_[A-Za-z0-9_-]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\bensemble_(?:[a-z]+_)?session=[^;\s"]+/gi,
  /\b((?:password|passwd|secret|token|api[_-]?key|access[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi,
];

export type Redactor = { text: (value: string, max?: number) => string; deep: <T>(value: T, max?: number) => T };

/** A redactor for this run: `places` maps absolute folders (the run's scratch root) to the placeholder written instead. */
export function redactor(places: Record<string, string> = {}, home = homedir()): Redactor {
  // Ensemble writes folders in the home as ~/…, so each place is named in that form too, and lower-cased, as the graders' notes write it.
  const named = Object.entries(places)
    .flatMap(([path, name]) => (path.startsWith(`${home}/`) ? [[path, name], [`~${path.slice(home.length)}`, name]] : [[path, name]]))
    .flatMap(([path, name]) => (path !== path.toLowerCase() ? [[path, name], [path.toLowerCase(), name]] : [[path, name]]));
  const swaps = [...named, [home, "~"]].filter(([path]) => path!.length > 1).sort((a, b) => b[0]!.length - a[0]!.length) as Array<[string, string]>;
  const text = (value: string, max = 4000): string => {
    let out = value;
    for (const pattern of SECRETS) out = out.replace(pattern, (whole, keep?: string) => (typeof keep === "string" && keep && whole.startsWith(keep) ? `${keep}[redacted]` : "[redacted]"));
    for (const [path, name] of swaps) out = out.split(path).join(name);
    return cut(out, max);
  };
  const deep = <T>(value: T, max = 4000): T => {
    if (typeof value === "string") return text(value, max) as T;
    if (Array.isArray(value)) return value.map((item) => deep(item, max)) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, deep(item, max)])) as T;
    return value;
  };
  return { text, deep };
}

/** The start of a long text and how much was left out. */
export function cut(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 40))} [… ${value.length - Math.max(0, max - 40)} more characters]`;
}
