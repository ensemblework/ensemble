import unittest
from unittest import mock

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
