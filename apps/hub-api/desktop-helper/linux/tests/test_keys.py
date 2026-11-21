import unittest

from desktop_helper import keys


class ComboTests(unittest.TestCase):
    def test_xdotool_style_combos(self):
        self.assertEqual(keys.parse_combo("ctrl+s"), [0xFFE3, 0x73])
        self.assertEqual(keys.parse_combo("alt+Tab"), [0xFFE9, 0xFF09])
        self.assertEqual(keys.parse_combo("ctrl+shift+T"), [0xFFE3, 0xFFE1, 0x54])
        self.assertEqual(keys.parse_combo("Return"), [0xFF0D])
        self.assertEqual(keys.parse_combo("super"), [0xFFEB])
        self.assertEqual(keys.parse_combo("F5"), [0xFFC2])
        self.assertEqual(keys.parse_combo("ctrl++"), [0xFFE3, 0x2B])
        self.assertEqual(keys.parse_combo("+"), [0x2B])
        self.assertEqual(keys.parse_combo("Page_Down"), [0xFF56])

    def test_unknown_or_empty_names_are_refused(self):
        for text in ("", "ctrl+", "ctrl+nosuchkey", "a+b+c+d+e+f+g", "++x"):
            with self.subTest(text=text):
                with self.assertRaises(keys.KeyError_):
                    keys.parse_combo(text)


class TextTests(unittest.TestCase):
    def test_character_keysyms(self):
        self.assertEqual(keys.char_keysym("a"), 0x61)
        self.assertEqual(keys.char_keysym("é"), 0xE9)
        self.assertEqual(keys.char_keysym("€"), 0x010020AC)
        self.assertEqual(keys.char_keysym("\n"), 0xFF0D)
        self.assertEqual(keys.char_keysym("\t"), 0xFF09)

    def test_text_is_split_into_typable_runs(self):
        self.assertEqual(keys.split_text("hi é!\n"), [("keys", "hi "), ("other", "é"), ("keys", "!\n")])
        self.assertEqual(keys.split_text("日本"), [("other", "日本")])
        self.assertEqual(keys.split_text("a\r\nb"), [("keys", "a\nb")])


if __name__ == "__main__":
    unittest.main()
