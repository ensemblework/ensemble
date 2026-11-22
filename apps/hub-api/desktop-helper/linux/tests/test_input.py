"""The helper's input methods, with the portal replaced: where the pointer goes on scaled screens, when
typing stops, and what never goes through the clipboard."""
import unittest

from desktop_helper.rpc import Deadline

from tests.fakes import A11y, Portal, helper


def scaled(scale: float) -> dict[int, dict]:
    """One monitor of 2560x1440 frame pixels shown at `scale` (its logical size is the frame's divided by it)."""
    return {42: {"node": 42, "x": 0, "y": 0, "width": round(2560 / scale), "height": round(1440 / scale), "frame_width": 2560, "frame_height": 1440}}


def pointer_moves(portal: Portal) -> list[tuple[float, float]]:
    return [(call[2], call[3]) for call in portal.calls if call[0] == "pointer_to"]


class Pointer(unittest.TestCase):
    def test_positions_are_sent_in_the_streams_frame_pixels(self):
        for scale, expected in ((1, (100.0, 50.0)), (1.25, (125.0, 62.5)), (2, (200.0, 100.0))):
            with self.subTest(scale=scale):
                portal = Portal()
                found = helper(portal, geometry=scaled(scale))
                answer = found.input_pointer({"display": 42, "x": 100, "y": 50, "action": "click"}, Deadline(5000), 1)
                self.assertEqual(pointer_moves(portal), [expected])
                self.assertEqual((answer["x"], answer["y"]), (100.0, 50.0), "the answer stays in logical pixels")

    def test_the_far_edge_stays_inside_the_frame(self):
        portal = Portal()
        helper(portal, geometry=scaled(1.25)).input_pointer({"display": 42, "x": 5000, "y": 5000, "action": "move"}, Deadline(5000), 1)
        x, y = pointer_moves(portal)[0]
        self.assertLess(x, 2560)
        self.assertLess(y, 1440)
        self.assertGreater(x, 2558)

    def test_drags_and_scrolls_are_scaled_too(self):
        portal = Portal()
        found = helper(portal, geometry=scaled(2))
        found.input_drag({"display": 42, "from": [10, 10], "to": [20, 10], "steps": 2}, Deadline(5000), 1)
        self.assertEqual(pointer_moves(portal), [(20.0, 20.0), (30.0, 20.0), (40.0, 20.0)])
        portal.calls.clear()
        found.input_scroll({"display": 42, "x": 300, "y": 200, "direction": "down", "amount": 1}, Deadline(5000), 2)
        self.assertEqual(pointer_moves(portal), [(600.0, 400.0)])


class Typing(unittest.TestCase):
    TEXT = "the quick brown fox jumps over the lazy dog"

    def test_typing_stops_when_the_owner_uses_the_computer(self):
        portal = Portal()
        found = helper(portal, idle=lambda: (False, 5))
        answer = found.input_text({"text": self.TEXT}, Deadline(20000), 1)
        self.assertEqual(answer["stopped"], "owner_input")
        typed = portal.typed()
        self.assertTrue(0 < len(typed) < len(self.TEXT), typed)
        self.assertTrue(self.TEXT.startswith(typed))
        self.assertEqual(answer["typed"]["keysym"], len(typed))

    def test_typing_stops_when_the_window_in_front_changes(self):
        portal = Portal()
        a11y = A11y()
        found = helper(portal, a11y)
        original = portal.keysym

        def keysym(sym, pressed):
            original(sym, pressed)
            if len(portal.typed()) == 5:
                a11y.key = (777, 0)

        portal.keysym = keysym
        answer = found.input_text({"text": self.TEXT}, Deadline(20000), 1)
        self.assertEqual(answer["stopped"], "focus_moved")
        self.assertLess(len(portal.typed()), len(self.TEXT))

    def test_uninterrupted_typing_types_everything(self):
        portal = Portal()
        answer = helper(portal).input_text({"text": "hello"}, Deadline(20000), 1)
        self.assertIsNone(answer.get("stopped"))
        self.assertEqual(portal.typed(), "hello")


class Clipboard(unittest.TestCase):
    def test_a_secret_never_goes_through_the_clipboard(self):
        for fill in (True, False):
            with self.subTest(accessibility_fills_it=fill):
                portal = Portal()
                a11y = A11y(insert=True, fill=fill)
                answer = helper(portal, a11y).input_text({"text": "pässwörd", "secret": True}, Deadline(20000), 1)
                self.assertFalse([call for call in portal.calls if call[0] in ("offer", "snapshot", "restore")], portal.calls)
                self.assertEqual(a11y.inserted, [], "nor through insertion at the caret")
                if fill:
                    self.assertEqual(a11y.filled, ["pässwörd"])
                    self.assertEqual(portal.typed(), "", "the field is filled whole, not half typed")
                    self.assertIsNone(answer.get("stopped"))
                else:
                    self.assertEqual(answer["stopped"], "secret_untypeable")
                    self.assertEqual(portal.typed(), "", "nothing of it is typed")

    def test_the_owners_clipboard_comes_back_after_typing_through_it(self):
        portal = Portal(clipboard_text="what the owner copied")
        answer = helper(portal, A11y(insert=False)).input_text({"text": "日本"}, Deadline(20000), 1)
        self.assertEqual(answer["typed"]["clipboard"], 2)
        kinds = [call[0] for call in portal.calls if call[0] in ("snapshot", "offer", "restore", "clear")]
        self.assertEqual(kinds, ["snapshot", "offer", "restore"])
        self.assertIn(("restore", {"text": "what the owner copied"}), portal.calls)


class PortalClipboard(unittest.TestCase):
    """The portal session's own keeping of the owner's clipboard, against a bus that answers like the portal."""

    class Bus:
        def __init__(self, data: bytes):
            self.data = data
            self.set: list[list[str]] = []

        def call_with_unix_fd_list_sync(self, _name, _path, _iface, method, _params, *_rest):
            import os

            from gi.repository import GLib

            assert method == "SelectionRead"
            read, write = os.pipe()
            os.write(write, self.data)
            os.close(write)
            return GLib.Variant("(h)", (0,)), {0: read}

        def call_sync(self, _name, _path, _iface, method, params, *_rest):
            if method == "SetSelection":
                self.set.append(list(params.unpack()[1]["mime_types"]))

    def session(self, mimes, data=b"what the owner copied"):
        from desktop_helper.portal import PortalSession

        found = PortalSession.__new__(PortalSession)
        found.bus = self.Bus(data)
        found.clipboard = True
        found.handle = "/session/1"
        found._clip_text = None
        found._selection_mimes = list(mimes)
        found._selection_ours = False
        return found

    def test_text_on_the_clipboard_is_given_back(self):
        found = self.session(["text/plain;charset=utf-8", "text/html"])
        kept = found.clipboard_snapshot()
        self.assertEqual(kept, {"data": b"what the owner copied"})
        found.clipboard_offer("日本")
        found.clipboard_restore(kept)
        self.assertEqual(found._clip_text, b"what the owner copied")
        self.assertTrue(found.bus.set[-1], "offered again")
        found._selection_owner_changed(None, None, None, None, None, _Params(("/session/1", {"session_is_owner": False, "mime_types": ["text/plain"]})))
        self.assertIsNone(found._clip_text, "dropped once someone else copies")

    def test_what_cannot_be_given_back_is_cleared(self):
        found = self.session(["image/png"])
        kept = found.clipboard_snapshot()
        self.assertEqual(kept, {"lost": True})
        found.clipboard_restore(kept)
        self.assertEqual(found.bus.set[-1], [])
        self.assertIsNone(found._clip_text)


class _Params:
    def __init__(self, value):
        self.value = value

    def unpack(self):
        return self.value


class Failures(unittest.TestCase):
    def test_an_apps_refusal_is_named_as_one_not_error(self):
        import json

        from gi.repository import GLib

        from desktop_helper.rpc import parse_line
        from desktop_helper.server import Helper

        found = Helper.__new__(Helper)
        found.cancelled = set()

        def refuse(_params, _deadline, _id):
            raise GLib.Error.new_literal(GLib.quark_from_string("atspi_error"), "", 1)

        found.methods = {"a11y.do": refuse}
        answer = json.loads(found.handle(parse_line(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "a11y.do", "params": {}}).encode())))
        self.assertNotIn("failed: Error", answer["error"]["message"])
        self.assertIn("refused", answer["error"]["message"])
        self.assertEqual(answer["error"]["data"]["ran"], "maybe")


if __name__ == "__main__":
    unittest.main()
