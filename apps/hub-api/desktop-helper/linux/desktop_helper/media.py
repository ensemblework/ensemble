"""Frames and recordings with GStreamer. One pipeline per screen stream keeps the latest frame in an
appsink (screenshots are then instant); a recording is a second pipeline fed the same frames through an
appsrc with its own timestamps, so it starts at zero and ends cleanly on EOS."""
from __future__ import annotations

import os
import threading
import time
import zlib
from typing import Any, Callable

import gi

gi.require_version("Gst", "1.0")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import GdkPixbuf, GLib, Gst  # noqa: E402

from .mapping import fit  # noqa: E402
from .rpc import error  # noqa: E402

_initialised = False


def init() -> None:
    global _initialised
    if not _initialised:
        Gst.init(None)
        _initialised = True


def pump(seconds: float) -> None:
    """Lets the GLib main context dispatch (portal signals, bus messages) while we wait."""
    end = time.monotonic() + max(0.0, seconds)
    context = GLib.MainContext.default()
    while True:
        dispatched = context.iteration(False)
        if time.monotonic() >= end:
            return
        if not dispatched:
            time.sleep(min(0.01, max(0.0, end - time.monotonic())))


def wait_until(predicate: Callable[[], bool], timeout_s: float, step_s: float = 0.01) -> bool:
    end = time.monotonic() + max(0.0, timeout_s)
    context = GLib.MainContext.default()
    while not predicate():
        if time.monotonic() >= end:
            return False
        if not context.iteration(False):
            time.sleep(step_s)
    return True


class Frame:
    __slots__ = ("data", "width", "height", "stride", "seq", "at", "_hash")

    def __init__(self, data: bytes, width: int, height: int, stride: int, seq: int, at: float):
        self.data = data
        self.width = width
        self.height = height
        self.stride = stride
        self.seq = seq
        self.at = at
        self._hash: int | None = None

    @property
    def hash(self) -> int:
        if self._hash is None:
            self._hash = zlib.crc32(self.data)
        return self._hash

    def pixbuf(self):
        return GdkPixbuf.Pixbuf.new_from_bytes(GLib.Bytes.new(self.data), GdkPixbuf.Colorspace.RGB, False, 8, self.width, self.height, self.stride)


def encode(frame: Frame, crop: tuple[int, int, int, int] | None, size: tuple[int, int] | None, fmt: str = "jpeg", quality: int = 80) -> bytes:
    """The frame (or a native-pixel crop of it) at `size`, as JPEG or PNG bytes."""
    pix = frame.pixbuf()
    if crop is not None:
        x, y, w, h = crop
        x = max(0, min(x, frame.width - 1))
        y = max(0, min(y, frame.height - 1))
        w = max(1, min(w, frame.width - x))
        h = max(1, min(h, frame.height - y))
        if (x, y, w, h) != (0, 0, frame.width, frame.height):
            pix = pix.new_subpixbuf(x, y, w, h)
    if size is not None and (size[0] != pix.get_width() or size[1] != pix.get_height()):
        pix = pix.scale_simple(size[0], size[1], GdkPixbuf.InterpType.BILINEAR)
    if fmt == "png":
        ok, data = pix.save_to_bufferv("png", [], [])
    else:
        ok, data = pix.save_to_bufferv("jpeg", ["quality"], [str(max(30, min(95, int(quality))))])
    if not ok:
        raise error("capture_failed", "The picture could not be encoded.")
    return bytes(data)


def write_private(path: str, data: bytes) -> None:
    """A new file only this user reads; never replaces one."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            view = view[written:]
    finally:
        os.close(fd)


class FrameSource:
    """A live video source (a portal stream's PipeWire node, or a test pattern) keeping its latest frame."""

    def __init__(self, source: str, log: Callable[[str], None]):
        init()
        self._log = log
        desc = (
            f"{source} ! queue max-size-buffers=2 leaky=downstream ! videoconvert ! video/x-raw,format=RGB "
            "! appsink name=frames emit-signals=true max-buffers=1 drop=true sync=false"
        )
        try:
            self.pipeline = Gst.parse_launch(desc)
        except GLib.Error as failure:
            raise error("capture_failed", f"The video pipeline could not be built ({failure.message}).")
        self._sink = self.pipeline.get_by_name("frames")
        self._sink.connect("new-sample", self._on_sample)
        self._lock = threading.Lock()
        self._latest: tuple[Any, int, float] | None = None
        self._seq = 0
        self._consumers: list[Callable[[Any], None]] = []
        self.error: str | None = None
        self.ended = False
        bus = self.pipeline.get_bus()
        bus.add_signal_watch()
        self._bus_handler = bus.connect("message", self._on_message)

    def _on_sample(self, sink) -> Gst.FlowReturn:
        sample = sink.emit("pull-sample")
        if sample is None:
            return Gst.FlowReturn.OK
        with self._lock:
            self._seq += 1
            self._latest = (sample, self._seq, time.monotonic())
            consumers = list(self._consumers)
        for consumer in consumers:
            try:
                consumer(sample)
            except Exception as failure:
                self._log(f"recording consumer failed: {type(failure).__name__}")
        return Gst.FlowReturn.OK

    def _on_message(self, _bus, message) -> None:
        if message.type == Gst.MessageType.ERROR:
            failure, _debug = message.parse_error()
            self.error = failure.message
            self._log(f"video source error: {failure.message}")
        elif message.type == Gst.MessageType.EOS:
            self.ended = True

    def start(self, first_frame_s: float = 5.0) -> bool:
        if self.pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
            raise error("capture_failed", "The video stream could not start.")
        return wait_until(lambda: self._latest is not None or self.error is not None, first_frame_s)

    def stop(self) -> None:
        with self._lock:
            self._consumers.clear()
        self.pipeline.set_state(Gst.State.NULL)
        bus = self.pipeline.get_bus()
        bus.disconnect(self._bus_handler)
        bus.remove_signal_watch()

    def add_consumer(self, consumer: Callable[[Any], None]) -> None:
        with self._lock:
            self._consumers.append(consumer)

    def remove_consumer(self, consumer: Callable[[Any], None]) -> None:
        with self._lock:
            if consumer in self._consumers:
                self._consumers.remove(consumer)

    def seq(self) -> int:
        with self._lock:
            return self._seq

    def frame(self) -> Frame | None:
        with self._lock:
            latest = self._latest
        if latest is None:
            return None
        sample, seq, at = latest
        caps = sample.get_caps()
        structure = caps.get_structure(0)
        width = structure.get_value("width")
        height = structure.get_value("height")
        buffer = sample.get_buffer()
        size = buffer.get_size()
        data = buffer.extract_dup(0, size)
        stride = size // height if height else width * 3
        return Frame(data, width, height, stride, seq, at)

    def settle(self, min_ms: float, timeout_ms: float, still_ms: float = 400.0, gap_ms: float = 120.0) -> tuple[bool, float, Frame | None]:
        """Waits until two frames read `gap_ms` apart match (or no new frame came for `still_ms`)."""
        started = time.monotonic()
        pump(min_ms / 1000.0)
        previous: Frame | None = None
        last_new = time.monotonic()
        while True:
            current = self.frame()
            now = time.monotonic()
            waited = (now - started) * 1000.0
            if current is not None and previous is not None:
                if current.seq == previous.seq and (now - last_new) * 1000.0 >= still_ms:
                    return True, waited, current
                if current.seq != previous.seq:
                    last_new = now
                    if current.hash == previous.hash:
                        return True, waited, current
            if waited >= timeout_ms:
                return False, waited, current
            if current is not None and (previous is None or current.seq != previous.seq):
                previous = current
            pump(gap_ms / 1000.0)


ENCODERS = [
    # GNOME's own recorder ladder: hardware H.264, then openh264, then x264 (where the owner installed it), then VP8 in WebM.
    {"name": "vah264lpenc", "codec": "h264", "container": "mp4", "desc": "vah264lpenc"},
    {"name": "vah264enc", "codec": "h264", "container": "mp4", "desc": "vah264enc"},
    {"name": "openh264enc", "codec": "h264", "container": "mp4", "desc": "openh264enc complexity=low"},
    {"name": "x264enc", "codec": "h264", "container": "mp4", "desc": "x264enc tune=zerolatency speed-preset=veryfast"},
    {"name": "vp8enc", "codec": "vp8", "container": "webm", "desc": "vp8enc deadline=1 cpu-used=8 end-usage=cbr target-bitrate=3000000 keyframe-max-dist=60 threads=4"},
]


def _tail(choice: dict[str, Any]) -> str:
    if choice["container"] == "mp4":
        parse = " ! h264parse" if Gst.ElementFactory.find("h264parse") else ""
        return f"{choice['desc']}{parse} ! mp4mux faststart=true"
    return f"{choice['desc']} ! webmmux"


_encoder_choice: dict[str, Any] | None = None
_encoder_checked = False


def encoder(log: Callable[[str], None]) -> dict[str, Any] | None:
    """The first encoder that really encodes here (a few test frames each), cached for the process."""
    global _encoder_choice, _encoder_checked
    if _encoder_checked:
        return _encoder_choice
    init()
    for choice in ENCODERS:
        if Gst.ElementFactory.find(choice["name"]) is None:
            continue
        mux = "mp4mux" if choice["container"] == "mp4" else "webmmux"
        if Gst.ElementFactory.find(mux) is None:
            continue
        desc = f"videotestsrc num-buffers=6 ! video/x-raw,width=64,height=64,framerate=30/1 ! videoconvert ! video/x-raw,format=I420 ! {_tail(choice)} ! fakesink"
        if _run_to_eos(desc, 8.0):
            _encoder_choice = dict(choice)
            break
        log(f"encoder {choice['name']} did not work here")
    _encoder_checked = True
    return _encoder_choice


def _run_to_eos(desc: str, timeout_s: float) -> bool:
    try:
        pipeline = Gst.parse_launch(desc)
    except GLib.Error:
        return False
    bus = pipeline.get_bus()
    pipeline.set_state(Gst.State.PLAYING)
    message = bus.timed_pop_filtered(int(timeout_s * Gst.SECOND), Gst.MessageType.EOS | Gst.MessageType.ERROR)
    pipeline.set_state(Gst.State.NULL)
    return message is not None and message.type == Gst.MessageType.EOS


def even(value: int) -> int:
    return max(2, value - (value % 2))


class Recording:
    """Frames from a FrameSource into a file, through an appsrc with timestamps from its own start."""

    def __init__(self, source: FrameSource, path: str, choice: dict[str, Any], fps: int, max_width: int, log: Callable[[str], None]):
        self.source = source
        self.path = path
        self.choice = choice
        self.fps = max(1, min(60, int(fps)))
        self.max_width = max(320, int(max_width))
        self._log = log
        self.started_at: float | None = None
        self.stopped_at: float | None = None
        self.stopped_reason: str | None = None
        self.error: str | None = None
        self.frames_in = 0
        self._caps: str | None = None
        self._eos = threading.Event()
        self._pipeline = None
        self._appsrc = None
        self._lock = threading.Lock()
        self._closing = False

    def start(self) -> None:
        frame = self.source.frame()
        if frame is None:
            raise error("recording_failed", "The screen stream has no frame yet.")
        width, height = frame.width, frame.height
        out_w, out_h = fit(width, height, max(self.max_width, 1))
        if out_w > self.max_width:
            out_w = self.max_width
        out_w, out_h = even(out_w), even(out_h)
        self._caps = f"video/x-raw,format=RGB,width={width},height={height},framerate=0/1"
        desc = (
            f"appsrc name=src is-live=true format=time do-timestamp=false block=false max-buffers=8 caps={self._caps} "
            "! queue max-size-buffers=6 leaky=downstream "
            f"! videorate ! video/x-raw,framerate={self.fps}/1 ! videoscale ! video/x-raw,width={out_w},height={out_h} "
            f"! videoconvert ! video/x-raw,format=I420 ! {_tail(self.choice)} ! filesink name=out location={_quote(self.path)}"
        )
        try:
            self._pipeline = Gst.parse_launch(desc)
        except GLib.Error as failure:
            raise error("recording_failed", f"The recording pipeline could not be built ({failure.message}).")
        self._appsrc = self._pipeline.get_by_name("src")
        bus = self._pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect("message", self._on_message)
        if self._pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
            raise error("recording_failed", "The recording could not start.")
        self.started_at = time.monotonic()
        self.out_size = (out_w, out_h)
        self.source.add_consumer(self._push)
        self._push(None, frame)

    def _push(self, sample, frame: Frame | None = None) -> None:
        with self._lock:
            if self._closing or self._appsrc is None or self.started_at is None:
                return
            if frame is not None:
                buffer = Gst.Buffer.new_wrapped(frame.data)
            else:
                caps = sample.get_caps().get_structure(0)
                if f"width={caps.get_value('width')}" not in self._caps or f"height={caps.get_value('height')}" not in self._caps:
                    self.stopped_reason = "size_changed"
                    GLib.idle_add(self._close_from_stream)
                    return
                buffer = sample.get_buffer().copy()
            buffer.pts = int((time.monotonic() - self.started_at) * Gst.SECOND)
            buffer.dts = Gst.CLOCK_TIME_NONE
            buffer.duration = Gst.CLOCK_TIME_NONE
            self._appsrc.emit("push-buffer", buffer)
            self.frames_in += 1

    def _close_from_stream(self) -> bool:
        self.finish(10.0)
        return False

    def _on_message(self, _bus, message) -> None:
        if message.type == Gst.MessageType.EOS:
            self._eos.set()
        elif message.type == Gst.MessageType.ERROR:
            failure, _debug = message.parse_error()
            self.error = failure.message
            self._log(f"recording error: {failure.message}")
            self._eos.set()

    @property
    def active(self) -> bool:
        return self.started_at is not None and self.stopped_at is None

    def finish(self, timeout_s: float = 15.0) -> bool:
        """EOS through the encoder and muxer, so the file is complete; True when it was."""
        with self._lock:
            if self.stopped_at is not None:
                return self.error is None
            self._closing = True
        self.source.remove_consumer(self._push)
        self.stopped_at = time.monotonic()
        if self._appsrc is not None:
            self._appsrc.emit("end-of-stream")
        done = wait_until(self._eos.is_set, timeout_s)
        if self._pipeline is not None:
            self._pipeline.set_state(Gst.State.NULL)
            bus = self._pipeline.get_bus()
            bus.remove_signal_watch()
        if not done:
            self.error = self.error or "The recording did not finish in time."
        return done and self.error is None

    def wall_ms(self) -> int:
        if self.started_at is None:
            return 0
        end = self.stopped_at if self.stopped_at is not None else time.monotonic()
        return int((end - self.started_at) * 1000)


def _quote(path: str) -> str:
    if '"' in path or "\n" in path:
        raise error("invalid_params", "That file name cannot be used.")
    return f'"{path}"'


def check_media(path: str, poster: str | None, preview: str | None, timeout_s: float = 120.0, log: Callable[[str], None] = lambda _m: None) -> dict[str, Any]:
    """Decodes the whole file: frames, real duration, size, codec; a poster frame from its middle."""
    init()
    if not os.path.isfile(path) or os.path.getsize(path) == 0:
        raise error("recording_failed", "The recording is empty.")
    codec = {"name": None}
    try:
        pipeline = Gst.parse_launch(f"filesrc location={_quote(path)} ! decodebin name=dec ! videoconvert ! video/x-raw,format=RGB ! appsink name=sink sync=false max-buffers=4")
    except GLib.Error as failure:
        raise error("recording_failed", f"The recording could not be read ({failure.message}).")
    decoder_bin = pipeline.get_by_name("dec")

    def on_element(_bin, element):
        factory = element.get_factory()
        klass = factory.get_metadata("klass") if factory else ""
        if "Decoder" in (klass or "") and "Video" in (klass or ""):
            codec["name"] = factory.get_name()

    decoder_bin.connect("element-added", on_element)
    sink = pipeline.get_by_name("sink")
    pipeline.set_state(Gst.State.PAUSED)
    state = pipeline.get_state(10 * Gst.SECOND)
    if state[0] == Gst.StateChangeReturn.FAILURE:
        pipeline.set_state(Gst.State.NULL)
        raise error("recording_failed", "The recording does not decode.")
    ok, container_ns = pipeline.query_duration(Gst.Format.TIME)
    middle = container_ns // 2 if ok and container_ns > 0 else None
    pipeline.set_state(Gst.State.PLAYING)
    frames = 0
    first = None
    last = None
    width = height = 0
    poster_frame: Frame | None = None
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        sample = sink.emit("try-pull-sample", 5 * Gst.SECOND)
        if sample is None:
            break
        buffer = sample.get_buffer()
        pts = buffer.pts
        frames += 1
        if pts != Gst.CLOCK_TIME_NONE:
            first = pts if first is None else min(first, pts)
            last = pts if last is None else max(last, pts)
        if poster_frame is None and (middle is None or (pts != Gst.CLOCK_TIME_NONE and pts >= middle)):
            structure = sample.get_caps().get_structure(0)
            width = structure.get_value("width")
            height = structure.get_value("height")
            size = buffer.get_size()
            poster_frame = Frame(buffer.extract_dup(0, size), width, height, size // height, frames, time.monotonic())
    pipeline.set_state(Gst.State.NULL)
    if frames == 0:
        raise error("recording_failed", "The recording has no frames.")
    step = 0
    if frames > 1 and first is not None and last is not None:
        step = (last - first) / (frames - 1)
    measured_ms = int(((last - first) + step) / Gst.MSECOND) if first is not None and last is not None else 0
    out: dict[str, Any] = {
        "frames": frames,
        "duration_ms": measured_ms,
        "container_duration_ms": int(container_ns / Gst.MSECOND) if ok and container_ns > 0 else None,
        "width": width,
        "height": height,
        "codec": codec["name"],
        "size": os.path.getsize(path),
    }
    if poster_frame is not None and poster:
        write_private(poster, encode(poster_frame, None, None, "jpeg", 85))
        out["poster"] = {"path": poster, "width": poster_frame.width, "height": poster_frame.height}
        if preview:
            pw, ph = fit(poster_frame.width, poster_frame.height, 320)
            write_private(preview, encode(poster_frame, None, (pw, ph), "jpeg", 75))
            out["preview"] = {"path": preview, "width": pw, "height": ph}
    return out
