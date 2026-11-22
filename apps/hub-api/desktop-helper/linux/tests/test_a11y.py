import unittest
from unittest import mock

from gi.repository import GLib

from desktop_helper import a11y
from desktop_helper.rpc import RpcError

from tests.fakes import ACTIVE, FOCUSED, SHOWING, Document, Node, browser

ENSEMBLE_PAGE = "https://app.ensemblework.com/r/1"


class Apps(a11y.A11y):
    def __init__(self, apps):
        super().__init__()
        self._fake_apps = apps

    def _apps(self):
        yield from self._fake_apps


def documents(*apps):
    with mock.patch.object(a11y.Atspi, "Document", Document), mock.patch.object(a11y, "app_id_for_pid", lambda _pid: None):
        return Apps(list(apps)).documents()


class Pages(unittest.TestCase):
    def test_chromium_names_its_page_by_uri(self):
        page = Node("document web", "Ensemble", interfaces=["Document"], attributes={"URI": ENSEMBLE_PAGE, "DocType": "html"})
        found = documents(browser("Chromium", "Chromium", page))
        self.assertEqual([(doc["app"], doc["url"], doc["active"]) for doc in found], [("Chromium", ENSEMBLE_PAGE, True)])

    def test_gnome_web_names_its_page_by_uri(self):
        page = Node("document web", "Ensemble", interfaces=["Document"], attributes={"URI": ENSEMBLE_PAGE})
        found = documents(browser("Web", "GTK", page))
        self.assertEqual([doc["url"] for doc in found], [ENSEMBLE_PAGE])

    def test_firefox_names_its_page_by_docurl(self):
        page = Node("document web", "Ensemble", interfaces=["Document"], attributes={"DocURL": ENSEMBLE_PAGE})
        found = documents(browser("Firefox", "Gecko", page))
        self.assertEqual([doc["url"] for doc in found], [ENSEMBLE_PAGE])

    def test_a_browser_window_whose_page_cannot_be_read_says_so(self):
        unreadable = Node("document web", "Page", interfaces=["Document"], attributes={})
        no_page = browser("Google Chrome", "Chromium", None, title="New Tab", active=False, pid=7)
        found = documents(browser("Chromium", "Chromium", unreadable), no_page)
        self.assertEqual(sorted((doc["app"], doc["url"], doc["window"]) for doc in found), [("Chromium", None, "Page"), ("Google Chrome", None, "New Tab")])

    def test_other_apps_and_minimised_windows_are_not_pages(self):
        editor = browser("Text Editor", "GTK", None)
        minimised = browser("Chromium", "Chromium", None)
        minimised.children[0].states.add(a11y.Atspi.StateType.ICONIFIED)
        self.assertEqual(documents(editor, minimised), [])


class Press(unittest.TestCase):
    def tree(self, node):
        found = a11y.A11y()
        found._trees["t1"] = {"nodes": {"e1": node}, "app": {"name": "Files"}}
        return found

    def test_in_the_background_a_press_never_moves_the_focus(self):
        label = Node("label", "Documents", interfaces=["Component"], states=(SHOWING,))
        with self.assertRaises(RpcError) as caught:
            self.tree(label).act("t1", "e1", "press", allow_focus=False)
        self.assertEqual(caught.exception.kind, "needs_screen")
        self.assertEqual(caught.exception.ran, "no")


def atspi_refusal():
    """What GTK 4 answers when asked to move its keyboard focus through accessibility: an error with no message."""
    return GLib.Error.new_literal(GLib.quark_from_string("atspi_error"), "", 1)


class RefusingComponent:
    @staticmethod
    def grab_focus(_node):
        raise atspi_refusal()


class Keyboard(unittest.TestCase):
    """GTK 4 apps (Calculator's display, text fields) refuse `GrabFocus`."""

    def tree(self, node):
        found = a11y.A11y()
        found._trees["t1"] = {"nodes": {"e2": node}, "app": {"name": "gnome-calculator"}}
        return found

    def test_an_element_that_has_the_keyboard_is_not_asked_to_take_it(self):
        display = Node("text", "", interfaces=["Component", "EditableText", "Text"], states=(SHOWING, FOCUSED))
        with mock.patch.object(a11y.Atspi, "Component", RefusingComponent):
            done = self.tree(display).act("t1", "e2", "focus")
        self.assertTrue(done["done"])
        self.assertIn("focused", done["states_after"])

    def test_an_app_that_keeps_its_keyboard_says_so_instead_of_failing(self):
        display = Node("text", "", interfaces=["Component", "EditableText", "Text"], states=(SHOWING,))
        with mock.patch.object(a11y.Atspi, "Component", RefusingComponent):
            done = self.tree(display).act("t1", "e2", "focus")
        self.assertFalse(done["done"])
        self.assertIn("does not let accessibility move its keyboard", done["refused"])

    def test_a_press_never_runs_a_text_fields_clipboard_action(self):
        display = Node("text", "", interfaces=["Component", "Action", "EditableText", "Text"], states=(SHOWING,))
        ran = []

        class Action:
            @staticmethod
            def do_action(_node, index):
                ran.append(index)
                return True

        with mock.patch.object(a11y.Atspi, "Component", RefusingComponent), mock.patch.object(a11y.Atspi, "Action", Action), mock.patch.object(a11y, "_actions", lambda _node: ["clipboard.copy", "selection.delete", "text.clear"]):
            with self.assertRaises(RpcError) as caught:
                self.tree(display).act("t1", "e2", "press")
        self.assertEqual(ran, [], "not its clipboard.copy")
        self.assertEqual(caught.exception.kind, "input_failed")
        self.assertIn("by its position", caught.exception.message)

    def test_a_button_is_still_pressed_by_its_click(self):
        button = Node("push button", "=", interfaces=["Component", "Action"], states=(SHOWING,))
        ran = []

        class Action:
            @staticmethod
            def do_action(_node, index):
                ran.append(index)
                return True

        with mock.patch.object(a11y.Atspi, "Action", Action), mock.patch.object(a11y, "_actions", lambda _node: ["menu.popup", "click"]):
            self.tree(button).act("t1", "e2", "press")
        self.assertEqual(ran, [1])

    def test_a_qt_press_is_its_press_not_its_set_focus(self):
        button = Node("push button", "OK", interfaces=["Component", "Action"], states=(SHOWING,))
        ran = []

        class Action:
            @staticmethod
            def do_action(_node, index):
                ran.append(index)
                return True

        with mock.patch.object(a11y.Atspi, "Action", Action), mock.patch.object(a11y, "_actions", lambda _node: ["SetFocus", "Press"]):
            self.tree(button).act("t1", "e2", "press")
        self.assertEqual(ran, [1])

    def test_an_element_whose_only_action_moves_the_focus_is_not_pressed_in_the_background(self):
        field = Node("text", "Name", interfaces=["Component", "Action", "EditableText", "Text"], states=(SHOWING,))
        ran = []

        class Action:
            @staticmethod
            def do_action(_node, index):
                ran.append(index)
                return True

        with mock.patch.object(a11y.Atspi, "Action", Action), mock.patch.object(a11y, "_actions", lambda _node: ["SetFocus"]):
            with self.assertRaises(RpcError) as caught:
                self.tree(field).act("t1", "e2", "press", allow_focus=False)
        self.assertEqual(ran, [], "its SetFocus would move the owner's focus")
        self.assertEqual(caught.exception.kind, "needs_screen")


class Desktop(unittest.TestCase):
    def test_an_app_that_went_away_is_skipped(self):
        calculator = Node("application", "gnome-calculator", children=[Node("frame", "Calculator", states=(SHOWING, ACTIVE))], pid=7)

        class Desk:
            @staticmethod
            def get_child_count():
                return 2

            @staticmethod
            def get_child_at_index(index):
                if index == 0:
                    raise atspi_refusal()
                return calculator

        found = a11y.A11y()
        with mock.patch.object(found, "desktop", lambda: Desk()), mock.patch.object(a11y, "app_id_for_pid", lambda _pid: None):
            self.assertIs(found.active()["app"], calculator)


class Secrets(unittest.TestCase):
    def test_a_secret_goes_into_the_focused_password_field_by_accessibility(self):
        field = Node("password text", "Password", interfaces=["EditableText", "Text"], states=(SHOWING, FOCUSED))
        other = Node("text", "Name", interfaces=["EditableText", "Text"], states=(SHOWING,))
        window = Node("frame", "Sign in", children=[Node("panel", children=[other, field])], states=(SHOWING, ACTIVE))
        app = Node("application", "Sign in", children=[window], pid=9)
        filled = []

        class EditableText:
            @staticmethod
            def set_text_contents(node, value):
                filled.append((node.name, value))
                return True

        with mock.patch.object(a11y.Atspi, "EditableText", EditableText), mock.patch.object(a11y, "app_id_for_pid", lambda _pid: None):
            self.assertTrue(Apps([app]).set_focused_secret("pässwörd"))
        self.assertEqual(filled, [("Password", "pässwörd")])

    def test_a_secret_never_goes_into_a_field_that_is_not_a_password(self):
        field = Node("text", "Search", interfaces=["EditableText", "Text"], states=(SHOWING, FOCUSED))
        window = Node("frame", "Find", children=[field], states=(SHOWING, ACTIVE))
        with mock.patch.object(a11y, "app_id_for_pid", lambda _pid: None):
            self.assertFalse(Apps([Node("application", "Find", children=[window], pid=9)]).set_focused_secret("pässwörd"))


if __name__ == "__main__":
    unittest.main()
