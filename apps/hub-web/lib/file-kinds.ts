/**
 * What a file is, by its name: the language the status bar names, the mark the explorer and tabs draw
 * (components/code/file-icon.tsx), and whether it has a Preview. Special names (package.json, Dockerfile,
 * README) come before extensions, as in VS Code.
 */
export type FileMark =
  | { kind: "badge"; text: string; bg: string; fg?: string }
  | { kind: "glyph"; glyph: "react" | "python" | "markdown" | "image" | "archive" | "lock" | "gear" | "terminal" | "database" | "table" | "text" | "git" | "docker" | "key" | "book" | "law" | "braces" | "pdf" | "font" | "audio" | "video" | "notebook" | "next"; color: string };

export type FileKind = { language: string; mark: FileMark; preview?: "markdown" | "html" | "svg" | "image" | "csv" };

const badge = (text: string, bg: string, fg = "#fff"): FileMark => ({ kind: "badge", text, bg, fg });
const glyph = (name: Extract<FileMark, { kind: "glyph" }>["glyph"], color: string): FileMark => ({ kind: "glyph", glyph: name, color });

const TS = "#3178c6";
const JS = "#e8d44d";

const EXTENSIONS: Record<string, FileKind> = {
  ts: { language: "TypeScript", mark: badge("TS", TS) },
  mts: { language: "TypeScript", mark: badge("TS", TS) },
  cts: { language: "TypeScript", mark: badge("TS", TS) },
  tsx: { language: "TypeScript React", mark: glyph("react", "#4fa8e8") },
  js: { language: "JavaScript", mark: badge("JS", JS, "#1f2328") },
  mjs: { language: "JavaScript", mark: badge("JS", JS, "#1f2328") },
  cjs: { language: "JavaScript", mark: badge("JS", JS, "#1f2328") },
  jsx: { language: "JavaScript React", mark: glyph("react", "#61dafb") },
  py: { language: "Python", mark: glyph("python", "#3776ab") },
  pyi: { language: "Python", mark: glyph("python", "#3776ab") },
  ipynb: { language: "Jupyter Notebook", mark: glyph("notebook", "#f37626") },
  java: { language: "Java", mark: badge("J", "#e76f00") },
  kt: { language: "Kotlin", mark: badge("K", "#7f52ff") },
  kts: { language: "Kotlin", mark: badge("K", "#7f52ff") },
  scala: { language: "Scala", mark: badge("SC", "#dc322f") },
  go: { language: "Go", mark: badge("GO", "#00add8") },
  rs: { language: "Rust", mark: badge("RS", "#ce7e4e") },
  c: { language: "C", mark: badge("C", "#5c6bc0") },
  h: { language: "C", mark: badge("H", "#a074c4") },
  cpp: { language: "C++", mark: badge("C++", "#f34b7d") },
  cc: { language: "C++", mark: badge("C++", "#f34b7d") },
  hpp: { language: "C++", mark: badge("H", "#f34b7d") },
  cs: { language: "C#", mark: badge("C#", "#9b4f96") },
  swift: { language: "Swift", mark: badge("SW", "#f05138") },
  m: { language: "Objective-C", mark: badge("M", "#438eff") },
  dart: { language: "Dart", mark: badge("DA", "#0175c2") },
  rb: { language: "Ruby", mark: badge("RB", "#cc342d") },
  php: { language: "PHP", mark: badge("php", "#777bb4") },
  lua: { language: "Lua", mark: badge("LU", "#4c6edb") },
  r: { language: "R", mark: badge("R", "#276dc3") },
  jl: { language: "Julia", mark: badge("JL", "#9558b2") },
  ex: { language: "Elixir", mark: badge("EX", "#6e4a7e") },
  exs: { language: "Elixir", mark: badge("EX", "#6e4a7e") },
  hs: { language: "Haskell", mark: badge("HS", "#5e5086") },
  zig: { language: "Zig", mark: badge("Z", "#f7a41d", "#1f2328") },
  pl: { language: "Perl", mark: badge("PL", "#39457e") },
  sh: { language: "Shell", mark: glyph("terminal", "#89e051") },
  bash: { language: "Shell", mark: glyph("terminal", "#89e051") },
  zsh: { language: "Shell", mark: glyph("terminal", "#89e051") },
  fish: { language: "Shell", mark: glyph("terminal", "#89e051") },
  ps1: { language: "PowerShell", mark: glyph("terminal", "#5391fe") },
  bat: { language: "Batch", mark: glyph("terminal", "#c1f12e") },
  sql: { language: "SQL", mark: glyph("database", "#e38c00") },
  prisma: { language: "Prisma", mark: badge("PR", "#5a67d8") },
  graphql: { language: "GraphQL", mark: badge("GQ", "#e10098") },
  gql: { language: "GraphQL", mark: badge("GQ", "#e10098") },
  proto: { language: "Protocol Buffers", mark: badge("PB", "#4285f4") },
  html: { language: "HTML", mark: badge("<>", "#e34c26"), preview: "html" },
  htm: { language: "HTML", mark: badge("<>", "#e34c26"), preview: "html" },
  css: { language: "CSS", mark: badge("#", "#663399") },
  scss: { language: "SCSS", mark: badge("S", "#cc6699") },
  sass: { language: "Sass", mark: badge("S", "#cc6699") },
  less: { language: "Less", mark: badge("L", "#1d365d") },
  vue: { language: "Vue", mark: badge("V", "#41b883") },
  svelte: { language: "Svelte", mark: badge("S", "#ff3e00") },
  astro: { language: "Astro", mark: badge("A", "#ff5d01") },
  json: { language: "JSON", mark: glyph("braces", "#cbcb41") },
  jsonc: { language: "JSON with Comments", mark: glyph("braces", "#cbcb41") },
  json5: { language: "JSON5", mark: glyph("braces", "#cbcb41") },
  yaml: { language: "YAML", mark: badge("Y", "#cb171e") },
  yml: { language: "YAML", mark: badge("Y", "#cb171e") },
  toml: { language: "TOML", mark: badge("T", "#9c4221") },
  xml: { language: "XML", mark: badge("<>", "#0060ac") },
  ini: { language: "Ini", mark: glyph("gear", "#9ca3af") },
  cfg: { language: "Config", mark: glyph("gear", "#9ca3af") },
  conf: { language: "Config", mark: glyph("gear", "#9ca3af") },
  env: { language: "Environment", mark: glyph("key", "#ecd53f") },
  md: { language: "Markdown", mark: glyph("markdown", "#519aba"), preview: "markdown" },
  markdown: { language: "Markdown", mark: glyph("markdown", "#519aba"), preview: "markdown" },
  mdx: { language: "MDX", mark: glyph("markdown", "#f9ac00"), preview: "markdown" },
  txt: { language: "Plain text", mark: glyph("text", "#9ca3af") },
  log: { language: "Log", mark: glyph("text", "#6b7280") },
  csv: { language: "CSV", mark: glyph("table", "#22a35a"), preview: "csv" },
  tsv: { language: "TSV", mark: glyph("table", "#22a35a"), preview: "csv" },
  xlsx: { language: "Excel", mark: glyph("table", "#1d6f42") },
  pdf: { language: "PDF", mark: glyph("pdf", "#e5252a") },
  svg: { language: "SVG", mark: badge("SVG", "#ffb13b", "#1f2328"), preview: "svg" },
  png: { language: "Image", mark: glyph("image", "#a074c4"), preview: "image" },
  jpg: { language: "Image", mark: glyph("image", "#a074c4"), preview: "image" },
  jpeg: { language: "Image", mark: glyph("image", "#a074c4"), preview: "image" },
  gif: { language: "Image", mark: glyph("image", "#a074c4"), preview: "image" },
  webp: { language: "Image", mark: glyph("image", "#a074c4"), preview: "image" },
  avif: { language: "Image", mark: glyph("image", "#a074c4"), preview: "image" },
  ico: { language: "Image", mark: glyph("image", "#a074c4"), preview: "image" },
  bmp: { language: "Image", mark: glyph("image", "#a074c4"), preview: "image" },
  zip: { language: "Archive", mark: glyph("archive", "#b7a26a") },
  gz: { language: "Archive", mark: glyph("archive", "#b7a26a") },
  tgz: { language: "Archive", mark: glyph("archive", "#b7a26a") },
  tar: { language: "Archive", mark: glyph("archive", "#b7a26a") },
  lock: { language: "Lockfile", mark: glyph("lock", "#9ca3af") },
  woff: { language: "Font", mark: glyph("font", "#f87171") },
  woff2: { language: "Font", mark: glyph("font", "#f87171") },
  ttf: { language: "Font", mark: glyph("font", "#f87171") },
  mp3: { language: "Audio", mark: glyph("audio", "#ef4444") },
  wav: { language: "Audio", mark: glyph("audio", "#ef4444") },
  mp4: { language: "Video", mark: glyph("video", "#f97316") },
  mov: { language: "Video", mark: glyph("video", "#f97316") },
  tf: { language: "Terraform", mark: badge("TF", "#7b42bc") },
  gradle: { language: "Gradle", mark: badge("G", "#02303a") },
  dockerfile: { language: "Dockerfile", mark: glyph("docker", "#2496ed") },
};

const NAMES: Record<string, FileKind> = {
  "package.json": { language: "JSON", mark: badge("npm", "#cb3837") },
  "package-lock.json": { language: "JSON", mark: glyph("lock", "#cb3837") },
  "pnpm-lock.yaml": { language: "YAML", mark: glyph("lock", "#f9ad00") },
  "yarn.lock": { language: "Lockfile", mark: glyph("lock", "#2c8ebb") },
  "bun.lockb": { language: "Lockfile", mark: glyph("lock", "#fbf0df") },
  "tsconfig.json": { language: "JSON with Comments", mark: badge("TS", TS) },
  "jsconfig.json": { language: "JSON with Comments", mark: badge("JS", JS, "#1f2328") },
  dockerfile: { language: "Dockerfile", mark: glyph("docker", "#2496ed") },
  "docker-compose.yml": { language: "YAML", mark: glyph("docker", "#2496ed") },
  "docker-compose.yaml": { language: "YAML", mark: glyph("docker", "#2496ed") },
  "compose.yaml": { language: "YAML", mark: glyph("docker", "#2496ed") },
  ".gitignore": { language: "Ignore", mark: glyph("git", "#f05032") },
  ".gitattributes": { language: "Git", mark: glyph("git", "#f05032") },
  ".gitmodules": { language: "Git", mark: glyph("git", "#f05032") },
  ".dockerignore": { language: "Ignore", mark: glyph("docker", "#2496ed") },
  ".npmrc": { language: "Config", mark: badge("npm", "#cb3837") },
  ".nvmrc": { language: "Plain text", mark: glyph("gear", "#8cc84b") },
  ".editorconfig": { language: "EditorConfig", mark: glyph("gear", "#9ca3af") },
  ".prettierrc": { language: "JSON", mark: glyph("gear", "#56b3b4") },
  "makefile": { language: "Makefile", mark: glyph("terminal", "#6d8086") },
  license: { language: "Plain text", mark: glyph("law", "#d4a72c") },
  "license.md": { language: "Markdown", mark: glyph("law", "#d4a72c"), preview: "markdown" },
  "license.txt": { language: "Plain text", mark: glyph("law", "#d4a72c") },
  "readme.md": { language: "Markdown", mark: glyph("book", "#42a5f5"), preview: "markdown" },
  readme: { language: "Plain text", mark: glyph("book", "#42a5f5") },
  "changelog.md": { language: "Markdown", mark: glyph("book", "#8bc34a"), preview: "markdown" },
  "agents.md": { language: "Markdown", mark: glyph("book", "#d97757"), preview: "markdown" },
  "claude.md": { language: "Markdown", mark: glyph("book", "#d97757"), preview: "markdown" },
  "requirements.txt": { language: "Pip requirements", mark: glyph("python", "#3776ab") },
  "pyproject.toml": { language: "TOML", mark: glyph("python", "#3776ab") },
  "go.mod": { language: "Go module", mark: badge("GO", "#00add8") },
  "go.sum": { language: "Go checksums", mark: glyph("lock", "#00add8") },
  "cargo.toml": { language: "TOML", mark: badge("RS", "#ce7e4e") },
  "cargo.lock": { language: "Lockfile", mark: glyph("lock", "#ce7e4e") },
  "gemfile": { language: "Ruby", mark: badge("RB", "#cc342d") },
};

/** Config files whose stem names a tool (next.config.ts, vite.config.js, tailwind.config.ts…). */
const TOOLS: Array<[RegExp, FileMark]> = [
  [/^next\.config\./, glyph("next", "#e6edf3")],
  [/^vite\.config\./, badge("V", "#646cff")],
  [/^vitest\.config\./, badge("V", "#729b1b")],
  [/^tailwind\.config\./, badge("TW", "#38bdf8", "#0b1220")],
  [/^postcss\.config\./, badge("PC", "#dd3a0a")],
  [/^(\.eslintrc|eslint\.config\.)/, badge("ES", "#4b32c3")],
  [/^(\.prettierrc|prettier\.config\.)/, glyph("gear", "#56b3b4")],
  [/^playwright\.config\./, badge("PW", "#2ead33")],
  [/^jest\.config\./, badge("J", "#c21325")],
  [/^\.env(\..+)?$/, glyph("key", "#ecd53f")],
];

const PLAIN: FileKind = { language: "Plain text", mark: glyph("text", "#9ca3af") };

export function fileKind(path: string): FileKind {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  const named = NAMES[name];
  if (named) return named;
  for (const [pattern, mark] of TOOLS) if (pattern.test(name)) return { ...(EXTENSIONS[name.split(".").pop() ?? ""] ?? PLAIN), mark };
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return name === "dockerfile" ? EXTENSIONS.dockerfile! : PLAIN;
  return EXTENSIONS[name.slice(dot + 1)] ?? (name.startsWith("dockerfile.") ? EXTENSIONS.dockerfile! : PLAIN);
}

/** What the Preview button shows, only for files that have one. */
export const previewOf = (path: string) => fileKind(path).preview ?? null;
