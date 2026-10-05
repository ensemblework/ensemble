/**
 * Built-in color themes redistributed with Ensemble.
 * Each one is MIT-licensed. The copyright notice travels with the theme.
 * Full license texts: the source repositories linked from each entry.
 *
 * Skipped on purpose:
 * - Material Theme (Equinusocio) — the published license does not clearly allow redistribution.
 * - Monokai Pro — a commercial theme, not licensed for bundling.
 * Both can still be applied from Open VSX when they ship a JSON color theme.
 *
 * Test fixtures in fixtures/ are the MIT-licensed Dark+ and Light+ themes from
 * Visual Studio Code (Copyright (c) 2015-present Microsoft Corporation), kept
 * as JSONC so include chains can be tested.
 */

export const ATTRIBUTIONS = [
  { name: "One Dark Pro", holder: "Copyright (c) 2013-2022 Binaryify", license: "MIT", source: "https://github.com/Binaryify/OneDark-Pro" },
  { name: "Catppuccin Mocha", holder: "Copyright (c) 2021 Catppuccin", license: "MIT", source: "https://github.com/catppuccin/vscode" },
  { name: "Dracula", holder: "Copyright (c) 2016 Dracula Theme", license: "MIT", source: "https://github.com/dracula/visual-studio-code" },
  { name: "GitHub Dark and GitHub Light", holder: "Copyright (c) 2020 Primer", license: "MIT", source: "https://github.com/primer/github-vscode-theme" },
  { name: "Ayu Dark", holder: "Copyright (c) 2016 Ike Kurghinyan", license: "MIT", source: "https://github.com/ayu-theme/vscode-ayu" },
  { name: "Tokyo Night", holder: "Copyright (c) 2018-present Enkia", license: "MIT", source: "https://github.com/enkia/tokyo-night-vscode-theme" },
  { name: "Night Owl", holder: "Copyright (c) 2018 Sarah Drasner", license: "MIT", source: "https://github.com/sdras/night-owl-vscode-theme" },
  { name: "Nord", holder: "Copyright (c) 2017-present Arctic Ice Studio and Sven Greb", license: "MIT", source: "https://github.com/nordtheme/visual-studio-code" },
  { name: "Monokai", holder: "Copyright (c) 2015-present Microsoft Corporation. Palette by Wimer Hazenberg.", license: "MIT", source: "https://github.com/microsoft/vscode" },
  { name: "Solarized Dark", holder: "Copyright (c) 2015-present Microsoft Corporation. Original palette by Ethan Schoonover (MIT).", license: "MIT", source: "https://github.com/microsoft/vscode" },
  { name: "Ensemble Default editor palette", holder: "CodeMirror One Dark, MIT", license: "MIT", source: "https://github.com/codemirror/theme-one-dark" },
] as const;
