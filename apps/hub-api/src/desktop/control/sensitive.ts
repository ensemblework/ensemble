/**
 * Apps whose use the owner is asked about first, once per app and run: password managers, system
 * settings, terminals and banking or wallet apps. They are never refused for being sensitive; only the
 * hard floor refuses.
 */

export type SensitiveCategory = "password_manager" | "system_settings" | "terminal" | "banking";

const RULES: Array<{ category: SensitiveCategory; pattern: RegExp }> = [
  { category: "password_manager", pattern: /\b(?:keepass(?:xc)?|bitwarden|1password|onepassword|lastpass|dashlane|enpass|proton ?pass|nordpass|keeper|passbolt|kwalletmanager|seahorse|passwords and keys|gnome[- ]?keyring|secrets)\b/i },
  { category: "system_settings", pattern: /\b(?:org\.gnome\.settings|gnome-control-center|control center|systemsettings|system settings|settings|kcmshell\d*|unity-control-center|cinnamon-settings|xfce4-settings-manager|software-properties|org\.gnome\.software|snap-store|app center|gnome-software|discover|synaptic|update-manager|software & updates|firmware|users|org\.gnome\.diskutility|gnome-disks|gparted|nm-connection-editor|network connections)\b/i },
  { category: "terminal", pattern: /\b(?:ptyxis|gnome-terminal|terminal|console|kgx|konsole|xterm|uxterm|alacritty|kitty|wezterm|foot|tilix|terminator|ghostty|warp|xfce4-terminal|lxterminal|guake|yakuake|termius)\b/i },
  { category: "banking", pattern: /\b(?:bank|banking|wallet|electrum|exodus|ledger live|ledger-live|trezor|monero|bitcoin|gnucash|homebank|kmymoney|moneydance|money manager)\b/i },
];

/** The sensitive category of an app, from its application id and its name; null for other apps. */
export function sensitiveApp(app: { id?: string | null; name?: string | null }): SensitiveCategory | null {
  const text = `${app.id ?? ""} ${app.name ?? ""}`.replace(/_/g, " ");
  for (const rule of RULES) if (rule.pattern.test(text)) return rule.category;
  return null;
}

export const SENSITIVE_WORDS: Record<SensitiveCategory, string> = {
  password_manager: "a password manager",
  system_settings: "system settings",
  terminal: "a terminal",
  banking: "a banking or wallet app",
};

/** What the owner is asked about: a sensitive app, or their own screen's pointer and keyboard. */
export type GateCategory = SensitiveCategory | "screen";

export const GATE_WORDS: Record<GateCategory, string> = { ...SENSITIVE_WORDS, screen: "the owner's own screen" };
