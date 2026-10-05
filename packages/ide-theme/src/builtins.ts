import { convertTheme } from "./convert.js";
import {
  ENSEMBLE_DEFAULT_ID,
  type IdeTheme,
  type ThemeKind,
  type UiTheme,
} from "./types.js";

export type BuiltinMeta = {
  id: string;
  label: string;
  publisher: string;
  kind: ThemeKind;
  uiTheme: UiTheme;
  license: "MIT";
  attribution: string;
  sourceUrl: string;
  /** Shown instead of Light/Dark when the theme follows the rest of Ensemble. */
  badge?: string;
  file?: string;
};

export const ensembleDefaultTheme: IdeTheme = {
  id: ENSEMBLE_DEFAULT_ID,
  label: "Ensemble Default",
  publisher: "Ensemble",
  uiTheme: "vs-dark",
  kind: "dark",
  cssVars: {},
  editor: null,
  tokens: [],
};

/**
 * Popular color themes whose license allows redistribution (all MIT).
 * Material Theme (Equinusocio) and Monokai Pro are intentionally absent:
 * their licenses don't allow bundling. They can still be loaded from Open VSX
 * when the extension ships a JSON color theme.
 */
export const BUILTINS: BuiltinMeta[] = [
  {
    id: ENSEMBLE_DEFAULT_ID,
    label: "Ensemble Default",
    publisher: "Ensemble",
    kind: "dark",
    uiTheme: "vs-dark",
    license: "MIT",
    badge: "Default",
    attribution: "Ensemble's own colors. The code editor keeps CodeMirror's One Dark palette (MIT).",
    sourceUrl: "https://github.com/codemirror/theme-one-dark",
  },
  {
    id: "builtin:one-dark-pro",
    label: "One Dark Pro",
    publisher: "zhuangtongfa",
    kind: "dark",
    uiTheme: "vs-dark",
    license: "MIT",
    file: "one-dark-pro",
    attribution: "Copyright (c) 2013-2022 Binaryify. MIT.",
    sourceUrl: "https://github.com/Binaryify/OneDark-Pro",
  },
  {
    id: "builtin:catppuccin-mocha",
    label: "Catppuccin Mocha",
    publisher: "Catppuccin",
    kind: "dark",
    uiTheme: "vs-dark",
    license: "MIT",
    file: "catppuccin-mocha",
    attribution: "Copyright (c) 2021 Catppuccin. MIT.",
    sourceUrl: "https://github.com/catppuccin/vscode",
  },
  {
    id: "builtin:dracula",
    label: "Dracula",
    publisher: "dracula-theme",
    kind: "dark",
    uiTheme: "vs-dark",
    license: "MIT",
    file: "dracula",
    attribution: "Copyright (c) 2016 Dracula Theme. MIT.",
    sourceUrl: "https://github.com/dracula/visual-studio-code",
  },
  {
    id: "builtin:github-dark",
    label: "GitHub Dark",
    publisher: "GitHub",
    kind: "dark",
    uiTheme: "vs-dark",
    license: "MIT",
    file: "github-dark",
    attribution: "Copyright (c) 2020 Primer. MIT.",
    sourceUrl: "https://github.com/primer/github-vscode-theme",
  },
  {
    id: "builtin:github-light",
    label: "GitHub Light",
    publisher: "GitHub",
    kind: "light",
    uiTheme: "vs",
    license: "MIT",
    file: "github-light",
    attribution: "Copyright (c) 2020 Primer. MIT.",
    sourceUrl: "https://github.com/primer/github-vscode-theme",
  },
  {
    id: "builtin:ayu-dark",
    label: "Ayu Dark",
    publisher: "teabyii",
    kind: "dark",
    uiTheme: "vs-dark",
    license: "MIT",
    file: "ayu-dark",
    attribution: "Copyright (c) 2016 Ike Kurghinyan. MIT.",
    sourceUrl: "https://github.com/ayu-theme/vscode-ayu",
  },
  {
    id: "builtin:tokyo-night",
    label: "Tokyo Night",
    publisher: "enkia",
    kind: "dark",
    uiTheme: "vs-dark",
    license: "MIT",
    file: "tokyo-night",
    attribution: "Copyright (c) 2018-present Enkia. MIT.",
    sourceUrl: "https://github.com/enkia/tokyo-night-vscode-theme",
  },
  {
    id: "builtin:night-owl",
    label: "Night Owl",
    publisher: "sdras",
    kind: "dark",
    uiTheme: "vs-dark",
    license: "MIT",
    file: "night-owl",
    attribution: "Copyright (c) 2018 Sarah Drasner. MIT.",
    sourceUrl: "https://github.com/sdras/night-owl-vscode-theme",
  },
  {
    id: "builtin:nord",
    label: "Nord",
    publisher: "arcticicestudio",
    kind: "dark",
    uiTheme: "vs-dark",
    license: "MIT",
    file: "nord",
    attribution: "Copyright (c) 2017-present Arctic Ice Studio and Sven Greb. MIT.",
    sourceUrl: "https://github.com/nordtheme/visual-studio-code",
  },
  {
    id: "builtin:monokai",
    label: "Monokai",
    publisher: "Microsoft",
    kind: "dark",
    uiTheme: "vs-dark",
    license: "MIT",
    file: "monokai",
    attribution: "VS Code built-in Monokai. Copyright (c) 2015-present Microsoft Corporation. MIT. Monokai colors by Wimer Hazenberg.",
    sourceUrl: "https://github.com/microsoft/vscode",
  },
  {
    id: "builtin:solarized-dark",
    label: "Solarized Dark",
    publisher: "Microsoft",
    kind: "dark",
    uiTheme: "vs-dark",
    license: "MIT",
    file: "solarized-dark",
    attribution: "VS Code built-in Solarized Dark. Copyright (c) 2015-present Microsoft Corporation. MIT. Original Solarized palette by Ethan Schoonover (MIT).",
    sourceUrl: "https://github.com/microsoft/vscode",
  },
];

const LOADERS: Record<string, () => Promise<unknown>> = {
  "one-dark-pro": () => import("../themes/one-dark-pro.json", { with: { type: "json" } }),
  "catppuccin-mocha": () => import("../themes/catppuccin-mocha.json", { with: { type: "json" } }),
  dracula: () => import("../themes/dracula.json", { with: { type: "json" } }),
  "github-dark": () => import("../themes/github-dark.json", { with: { type: "json" } }),
  "github-light": () => import("../themes/github-light.json", { with: { type: "json" } }),
  "ayu-dark": () => import("../themes/ayu-dark.json", { with: { type: "json" } }),
  "tokyo-night": () => import("../themes/tokyo-night.json", { with: { type: "json" } }),
  "night-owl": () => import("../themes/night-owl.json", { with: { type: "json" } }),
  nord: () => import("../themes/nord.json", { with: { type: "json" } }),
  monokai: () => import("../themes/monokai.json", { with: { type: "json" } }),
  "solarized-dark": () => import("../themes/solarized-dark.json", { with: { type: "json" } }),
};

const memory = new Map<string, IdeTheme>();

export function builtinMeta(id: string): BuiltinMeta | undefined {
  return BUILTINS.find((item) => item.id === id);
}

export async function loadBuiltinTheme(id: string): Promise<IdeTheme | null> {
  if (id === ENSEMBLE_DEFAULT_ID) return ensembleDefaultTheme;
  const cached = memory.get(id);
  if (cached) return cached;
  const meta = builtinMeta(id);
  if (!meta?.file) return null;
  const loader = LOADERS[meta.file];
  if (!loader) return null;
  const mod = (await loader()) as { default?: unknown };
  const document = mod.default ?? mod;
  const converted = convertTheme({
    id: meta.id,
    label: meta.label,
    publisher: meta.publisher,
    uiTheme: meta.uiTheme,
    document,
  });
  if (!converted.ok) return null;
  memory.set(id, converted.theme);
  return converted.theme;
}
