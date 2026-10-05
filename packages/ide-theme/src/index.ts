export {
  kindFromUiTheme,
  MAX_FAVOURITES,
  normalizeUiTheme,
  openVsxThemeId,
  parseOpenVsxThemeId,
  themeSource,
  TOKEN_ROLES,
  ENSEMBLE_DEFAULT_ID,
} from "./types.js";
export type {
  EditorColors,
  IdeTheme,
  ThemeFavourite,
  ThemeKind,
  TokenRole,
  TokenStyle,
  UiTheme,
  VsThemeDocument,
} from "./types.js";

export { ThemeSyntaxError, parseJsonc } from "./jsonc.js";
export { parseColor, formatColor } from "./color.js";
export { convertTheme, resolveThemeDocument, safeJoin, sanitizeIdeTheme } from "./convert.js";
export type { ConvertResult, ResolveResult } from "./convert.js";
export { convertExtensionThemes, listPackageThemes } from "./extension.js";
export type { ConvertedExtensionTheme, PackageThemeInfo, ThemeDirectoryExtension } from "./extension.js";
export { addFavourite, cycleFavourite, removeFavourite, replaceFavourite } from "./favourites.js";
export type { FavouriteResult } from "./favourites.js";
export { BUILTINS, builtinMeta, loadBuiltinTheme, ensembleDefaultTheme } from "./builtins.js";
export type { BuiltinMeta } from "./builtins.js";
