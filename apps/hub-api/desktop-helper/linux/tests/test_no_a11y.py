"""The helper where no accessibility bus can be reached (no desktop session): it says so and keeps
running, rather than letting libatspi abort the whole process."""
import json
import os
import select
import subprocess
import sys
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "ensemble_desktop.py")


class NoAccessibilityBus(unittest.TestCase):
    def test_the_helper_says_accessibility_is_unavailable_and_keeps_running(self):
        with tempfile.TemporaryDirectory() as runtime, tempfile.TemporaryDirectory() as state:
            # No session bus, no accessibility bus, no display: an empty runtime folder and nothing else.
            env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": state, "XDG_RUNTIME_DIR": runtime, "LANG": "C.UTF-8", "PYTHONDONTWRITEBYTECODE": "1"}
            child = subprocess.Popen([sys.executable, SCRIPT, "--state-dir", state], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            answers = {}
            try:
                for request_id, method in enumerate(("hello", "status", "a11y.apps", "a11y.focus"), start=1):
                    child.stdin.write(json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": {"deadline_ms": 20000}}) + "\n")
                    child.stdin.flush()
                    answers[method] = self.answer(child, request_id)
            finally:
                child.stdin.close()
                code = child.wait(timeout=20)
        self.assertIn("result", answers["hello"])
        fact = answers["status"]["result"]["facts"]["a11y"]
        self.assertEqual(fact["state"], "unavailable")
        self.assertIn("accessibility", fact["detail"].lower())
        for method in ("a11y.apps", "a11y.focus"):
            self.assertEqual(answers[method]["error"]["data"]["kind"], "a11y_unavailable", method)
        self.assertEqual(code, 0, "it ended when its input closed, not by an abort")

    def answer(self, child, request_id):
        while True:
            ready, _, _ = select.select([child.stdout], [], [], 30)
            line = child.stdout.readline() if ready else ""
            if not line:
                child.kill()
                self.fail(f"the helper stopped answering (exit {child.wait(5)})")
            message = json.loads(line)
            if message.get("id") == request_id:
                return message


if __name__ == "__main__":
    unittest.main()
