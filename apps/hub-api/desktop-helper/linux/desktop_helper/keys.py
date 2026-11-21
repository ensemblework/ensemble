"""Key names (xdotool style: `ctrl+s`, `Return`, `alt+Tab`, `super`) and text as X keysyms, which the
RemoteDesktop portal takes. Mutter types a keysym only when the active keyboard layout has it, and
presses Shift or AltGr for it itself; anything else is dropped, so text outside a conservative set is
typed another way (the caller's AT-SPI or clipboard route)."""
from __future__ import annotations

MODIFIERS: dict[str, int] = {
    "ctrl": 0xFFE3,
    "control": 0xFFE3,
    "control_l": 0xFFE3,
    "control_r": 0xFFE4,
    "shift": 0xFFE1,
    "shift_l": 0xFFE1,
    "shift_r": 0xFFE2,
    "alt": 0xFFE9,
    "alt_l": 0xFFE9,
    "alt_r": 0xFFEA,
    "altgr": 0xFE03,
    "iso_level3_shift": 0xFE03,
    "super": 0xFFEB,
    "super_l": 0xFFEB,
    "super_r": 0xFFEC,
    "meta": 0xFFEB,
    "win": 0xFFEB,
    "cmd": 0xFFEB,
    "command": 0xFFEB,
}

NAMED: dict[str, int] = {
    "return": 0xFF0D,
    "enter": 0xFF0D,
    "kp_enter": 0xFF8D,
    "escape": 0xFF1B,
    "esc": 0xFF1B,
    "tab": 0xFF09,
    "iso_left_tab": 0xFE20,
    "backspace": 0xFF08,
    "delete": 0xFFFF,
    "del": 0xFFFF,
    "insert": 0xFF63,
    "home": 0xFF50,
    "end": 0xFF57,
    "page_up": 0xFF55,
    "pageup": 0xFF55,
    "prior": 0xFF55,
    "page_down": 0xFF56,
    "pagedown": 0xFF56,
    "next": 0xFF56,
    "left": 0xFF51,
    "up": 0xFF52,
    "right": 0xFF53,
    "down": 0xFF54,
    "space": 0x0020,
    "menu": 0xFF67,
    "print": 0xFF61,
    "caps_lock": 0xFFE5,
    "num_lock": 0xFF7F,
    "scroll_lock": 0xFF14,
    "pause": 0xFF13,
    "plus": 0x002B,
    "minus": 0x002D,
    "comma": 0x002C,
    "period": 0x002E,
    "slash": 0x002F,
    "backslash": 0x005C,
    "semicolon": 0x003B,
    "apostrophe": 0x0027,
    "grave": 0x0060,
    "equal": 0x003D,
    "bracketleft": 0x005B,
    "bracketright": 0x005D,
}
for _n in range(1, 25):
    NAMED[f"f{_n}"] = 0xFFBE + _n - 1

ALIASES = {"⌘": "super", "^": "ctrl"}


class KeyError_(ValueError):
    pass


def char_keysym(char: str) -> int:
    """The keysym of one character: Latin-1 maps to itself, other code points to 0x01000000 + code point."""
    if len(char) != 1:
        raise KeyError_("one character at a time")
    if char == "\n" or char == "\r":
        return NAMED["return"]
    if char == "\t":
        return NAMED["tab"]
    code = ord(char)
    if 0x20 <= code <= 0x7E or 0xA0 <= code <= 0xFF:
        return code
    return 0x01000000 + code


def key_keysym(name: str) -> int:
    """One key by name (`Return`, `F5`, `a`, `A`, `plus`) as a keysym."""
    raw = name.strip()
    if not raw:
        raise KeyError_("an empty key name")
    if len(raw) == 1:
        return char_keysym(raw)
    lowered = ALIASES.get(raw, raw).lower()
    if lowered in MODIFIERS:
        return MODIFIERS[lowered]
    if lowered in NAMED:
        return NAMED[lowered]
    if lowered.startswith("0x"):
        try:
            value = int(lowered, 16)
        except ValueError:
            raise KeyError_(f"unknown key {name!r}")
        if 0 < value < 0x02000000:
            return value
    raise KeyError_(f"unknown key {name!r}")


def parse_combo(text: str) -> list[int]:
    """`ctrl+shift+t` as the keysyms to press in order (modifiers first) and release in reverse."""
    raw = text.strip()
    if not raw:
        raise KeyError_("no keys given")
    if raw == "+":
        return [0x002B]
    if raw.endswith("++"):
        head = raw[:-2]
        keys = (head.split("+") if head else []) + ["+"]
    else:
        keys = raw.split("+")
    if any(part == "" for part in keys):
        raise KeyError_(f"cannot read {text!r}")
    syms = [key_keysym(part) for part in keys]
    if len(syms) > 6:
        raise KeyError_("at most six keys at once")
    return syms


TYPABLE_EXTRA = {"\n", "\t"}


def layout_typable(char: str) -> bool:
    """Characters every common Latin keyboard layout has (Mutter types them with the right modifiers)."""
    return char in TYPABLE_EXTRA or 0x20 <= ord(char) <= 0x7E


def split_text(text: str) -> list[tuple[str, str]]:
    """Runs of the text: ("keys", chars typed as keysyms) and ("other", chars that need another route)."""
    runs: list[tuple[str, str]] = []
    for char in text.replace("\r\n", "\n"):
        kind = "keys" if layout_typable(char) else "other"
        if runs and runs[-1][0] == kind:
            runs[-1] = (kind, runs[-1][1] + char)
        else:
            runs.append((kind, char))
    return runs
