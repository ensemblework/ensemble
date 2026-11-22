import json
import unittest

from desktop_helper import rpc


class FramingTests(unittest.TestCase):
    def test_reads_a_request_with_params(self):
        request = rpc.parse_line(b'{"jsonrpc":"2.0","id":7,"method":"frame.capture","params":{"display":3}}')
        self.assertEqual((request.id, request.method, request.params), (7, "frame.capture", {"display": 3}))
        self.assertFalse(request.is_notification)

    def test_a_message_without_id_is_a_notification(self):
        request = rpc.parse_line('{"jsonrpc":"2.0","method":"cancel","params":{"id":7}}')
        self.assertTrue(request.is_notification)

    def test_refuses_what_is_not_json_rpc(self):
        cases = {
            b"not json": "parse_error",
            b"\xff\xfe": "parse_error",
            b'{"id":1,"method":"x"}': "invalid_request",
            b'{"jsonrpc":"2.0","id":1}': "invalid_request",
            b'{"jsonrpc":"2.0","id":true,"method":"x"}': "invalid_request",
            b'{"jsonrpc":"2.0","id":{},"method":"x"}': "invalid_request",
            b'{"jsonrpc":"2.0","id":1,"method":"x","params":[1]}': "invalid_params",
            b"[1, 2]": "invalid_request",
        }
        for line, kind in cases.items():
            with self.subTest(line=line):
                with self.assertRaises(rpc.RpcError) as caught:
                    rpc.parse_line(line)
                self.assertEqual(caught.exception.kind, kind)

    def test_refuses_an_oversized_line(self):
        with self.assertRaises(rpc.RpcError) as caught:
            rpc.parse_line(b"{" + b" " * (rpc.MAX_LINE_BYTES + 1) + b"}")
        self.assertEqual(caught.exception.kind, "invalid_request")

    def test_responses_are_one_line_each(self):
        line = rpc.response(3, {"text": "two\nlines", "emoji": "ok"})
        self.assertTrue(line.endswith("\n"))
        self.assertEqual(line.count("\n"), 1)
        self.assertEqual(json.loads(line), {"jsonrpc": "2.0", "id": 3, "result": {"text": "two\nlines", "emoji": "ok"}})
        event = json.loads(rpc.notification("event", {"kind": "session.closed"}))
        self.assertNotIn("id", event)


class ErrorTests(unittest.TestCase):
    def test_errors_carry_a_stable_code_kind_and_ran(self):
        failure = rpc.error("input_failed", "The portal refused it.", ran="maybe", retryable=True)
        body = json.loads(rpc.error_response(9, failure))["error"]
        self.assertEqual(body["code"], -32006)
        self.assertEqual(body["data"], {"kind": "input_failed", "ran": "maybe", "retryable": True})

    def test_codes_are_unique(self):
        self.assertEqual(len(set(rpc.CODES.values())), len(rpc.CODES))

    def test_unknown_kinds_and_ran_values_fall_back_safely(self):
        failure = rpc.RpcError("no_such_kind", "x", ran="perhaps")
        self.assertEqual((failure.kind, failure.ran), ("internal", "maybe"))

    def test_extra_fields_ride_along(self):
        failure = rpc.error("target_not_found", "No app.", extra={"candidates": [{"id": "org.gnome.Calculator"}]})
        self.assertEqual(failure.to_error()["data"]["candidates"], [{"id": "org.gnome.Calculator"}])


class DeadlineTests(unittest.TestCase):
    def test_counts_down_and_raises_timeout_with_ran(self):
        now = [100.0]
        deadline = rpc.Deadline.from_params({"deadline_ms": 1500}, 30_000, clock=lambda: now[0])
        self.assertAlmostEqual(deadline.remaining(), 1.5)
        now[0] += 2
        self.assertTrue(deadline.expired())
        with self.assertRaises(rpc.RpcError) as caught:
            deadline.check("maybe")
        self.assertEqual((caught.exception.kind, caught.exception.ran), ("timeout", "maybe"))

    def test_rejects_bad_deadlines(self):
        for value in (0, -5, "soon", float("nan")):
            with self.subTest(value=value):
                with self.assertRaises(rpc.RpcError):
                    rpc.Deadline.from_params({"deadline_ms": value}, 1000)


class ParamTests(unittest.TestCase):
    def test_types_are_checked(self):
        self.assertEqual(rpc.param({"x": 4}, "x", (int, float)), 4)
        self.assertEqual(rpc.param({}, "x", (int, float), 2), 2)
        with self.assertRaises(rpc.RpcError):
            rpc.param({"x": True}, "x", (int, float))
        with self.assertRaises(rpc.RpcError):
            rpc.param({"x": 1}, "x", str)
        with self.assertRaises(rpc.RpcError):
            rpc.param({}, "x", str, required=True)


if __name__ == "__main__":
    unittest.main()
