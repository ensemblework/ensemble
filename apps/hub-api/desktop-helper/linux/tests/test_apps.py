import unittest

from desktop_helper import apps, sessionenv


class UnitTests(unittest.TestCase):
    def test_application_ids_from_systemd_units(self):
        cases = {
            "app-gnome-org.gnome.Calculator-12345.scope": "org.gnome.Calculator",
            "app-gnome-org.gnome.Evolution\\x2dalarm\\x2dnotify-2780.scope": "org.gnome.Evolution-alarm-notify",
            "app-cursor-3587639.scope": "cursor",
            "app-ensemble-org.gnome.TextEditor-1a2b3c4d.scope": "org.gnome.TextEditor",
            "snap.firefox.firefox-f079e53f-6ec6-4a82-ac5d-e7f29b987375.scope": "firefox_firefox",
            "app-gnome-org.gnome.Nautilus@12345.service": "org.gnome.Nautilus",
            "app-dbus\\x2d:1.2\\x2dorg.freedesktop.portal.IBus@0.service": None,
            "session-2.scope": None,
        }
        for unit, expected in cases.items():
            with self.subTest(unit=unit):
                self.assertEqual(apps.app_id_from_unit(unit), expected)

    def test_application_id_from_a_cgroup_file(self):
        text = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-org.gnome.Calculator-4242.scope\n"
        self.assertEqual(apps.app_id_from_cgroup(text), "org.gnome.Calculator")
        self.assertIsNone(apps.app_id_from_cgroup("0::/user.slice/user-1000.slice/session-2.scope\n"))

    def test_unit_names_escape_what_systemd_needs(self):
        self.assertEqual(apps.escape_unit("org.gnome.Text-Editor"), "org.gnome.Text\\x2dEditor")
        self.assertEqual(apps.unescape_unit(apps.escape_unit("a-b c")), "a-b c")

    def test_launch_uses_a_scope_of_its_own_when_systemd_can(self):
        command = apps.launch_command("/usr/share/applications/org.gnome.Calculator.desktop", "org.gnome.Calculator", systemd_run="/usr/bin/systemd-run", gio="/usr/bin/gio")
        self.assertEqual(command[:5], ["/usr/bin/systemd-run", "--user", "--scope", "--collect", "--quiet"])
        self.assertTrue(command[5].startswith("--unit=app-ensemble-org.gnome.Calculator-"))
        self.assertEqual(apps.app_id_from_unit(command[5][len("--unit="):] + ".scope"), "org.gnome.Calculator")
        self.assertEqual(command[-3:], ["/usr/bin/gio", "launch", "/usr/share/applications/org.gnome.Calculator.desktop"])
        self.assertEqual(apps.launch_command("/x.desktop", "x", systemd_run="", gio="/usr/bin/gio"), ["/usr/bin/gio", "launch", "/x.desktop"])

    def test_queries_match_ids_names_and_programs(self):
        entry = {"id": "org.gnome.Calculator", "name": "Calculator", "exec": "gnome-calculator", "generic": ""}
        self.assertEqual(apps.match_score("org.gnome.Calculator", entry), 3)
        self.assertEqual(apps.match_score("calculator", entry), 3)
        self.assertEqual(apps.match_score("gnome-calculator", entry), 2)
        self.assertEqual(apps.match_score("calc", entry), 1)
        self.assertEqual(apps.match_score("terminal", entry), 0)
        self.assertTrue(apps.matches_running("org.gnome.Calculator", ["gnome-calculator"], "gnome-calculator"))
        self.assertFalse(apps.matches_running("org.gnome.Calculator", ["Firefox"], "gnome-calculator"))


class SessionEnvTests(unittest.TestCase):
    def test_only_missing_session_keys_come_from_the_manager(self):
        manager = lambda: ["WAYLAND_DISPLAY=wayland-0", "DISPLAY=:0", "SECRET_TOKEN=nope", "XDG_CURRENT_DESKTOP=GNOME", "BROKEN"]
        env = sessionenv.complete({"HOME": "/home/x", "XDG_CURRENT_DESKTOP": "ubuntu:GNOME"}, manager)
        self.assertEqual(env["WAYLAND_DISPLAY"], "wayland-0")
        self.assertEqual(env["XDG_CURRENT_DESKTOP"], "ubuntu:GNOME")
        self.assertNotIn("SECRET_TOKEN", env)

    def test_a_failing_manager_changes_nothing(self):
        def broken():
            raise RuntimeError("no bus")
        self.assertEqual(sessionenv.complete({"A": "1"}, broken), {"A": "1"})


if __name__ == "__main__":
    unittest.main()
