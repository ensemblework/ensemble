#!/usr/bin/env python3
"""Ensemble's desktop helper for Linux. Speaks versioned JSON-RPC 2.0 over stdin and stdout, one JSON
object per line, one request at a time (see desktop_helper/rpc.py and server.py). Started and stopped
by Ensemble's runtime (apps/hub-api/src/desktop/control/helper-process.ts)."""
from __future__ import annotations

import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from desktop_helper import PROTOCOL, VERSION  # noqa: E402
from desktop_helper.rpc import RpcError, error, error_response, parse_line, response  # noqa: E402

MISSING = "Desktop control needs Python's GObject bindings with GStreamer and AT-SPI. On Ubuntu or Debian: sudo apt install python3-gi gir1.2-atspi-2.0 gir1.2-gstreamer-1.0 gstreamer1.0-pipewire gstreamer1.0-plugins-good"


def unavailable(reason: str) -> int:
    """Answers every request with why this helper cannot work here (a missing library), so the caller can say so."""
    for raw in iter(sys.stdin.buffer.readline, b""):
        try:
            request = parse_line(raw.rstrip(b"\n"))
        except RpcError as failure:
            sys.stdout.write(error_response(None, failure))
            sys.stdout.flush()
            continue
        if request.is_notification:
            continue
        if request.method == "hello":
            sys.stdout.write(response(request.id, {"protocol": PROTOCOL, "version": VERSION, "platform": "linux", "unavailable": reason, "methods": ["hello"]}))
        else:
            sys.stdout.write(error_response(request.id, error("unsupported_here", reason)))
        sys.stdout.flush()
    return 0


def check() -> int:
    """One line of JSON: whether the libraries, the screen stream source and an encoder are here. Starts no session."""
    import json

    out: dict[str, object] = {"protocol": PROTOCOL, "version": VERSION, "gi": False, "atspi": False, "gst": False, "pipewiresrc": False, "recorder": None}
    try:
        import gi

        gi.require_version("Gst", "1.0")
        gi.require_version("Atspi", "2.0")
        gi.require_version("GdkPixbuf", "2.0")
        out["gi"] = True
        from gi.repository import Atspi, Gst  # noqa: F401

        out["atspi"] = True
        Gst.init(None)
        out["gst"] = True
        out["pipewiresrc"] = Gst.ElementFactory.find("pipewiresrc") is not None
        from desktop_helper.media import encoder

        choice = encoder(lambda _message: None)
        out["recorder"] = choice["container"] if choice else None
    except (ImportError, ValueError) as failure:
        out["missing"] = type(failure).__name__
    sys.stdout.write(json.dumps(out) + "\n")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="ensemble_desktop.py", add_help=True)
    parser.add_argument("--state-dir", help="Folder for the portal's restore token (made 0700).")
    parser.add_argument("--test-source", default=None, help="A GStreamer source to use instead of the screen (tests only).")
    parser.add_argument("--check", action="store_true", help="Print what is installed as one JSON line and exit.")
    args = parser.parse_args(argv)
    if args.check:
        return check()
    if not args.state_dir:
        parser.error("--state-dir is required")
    try:
        import gi

        gi.require_version("Gst", "1.0")
        gi.require_version("Atspi", "2.0")
        gi.require_version("GdkPixbuf", "2.0")
        from desktop_helper.server import Helper, Writer
    except (ImportError, ValueError) as failure:
        sys.stderr.write(f"desktop-helper: {type(failure).__name__}: {str(failure)[:200]}\n")
        return unavailable(MISSING)
    helper = Helper(os.path.abspath(args.state_dir), Writer(sys.stdout), args.test_source)
    helper.run()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
