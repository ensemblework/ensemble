"""Geometry between the three spaces: native frame pixels (what PipeWire delivers), logical stream
coordinates (what the RemoteDesktop portal takes for pointer input, per stream) and image pixels (what
the model is shown). With fractional scaling a stream's logical size differs from its frame size."""
from __future__ import annotations

import math

MAX_LONG_EDGE = 1568


def fit(width: int, height: int, long_edge: int = MAX_LONG_EDGE) -> tuple[int, int]:
    """The size an image is sent at: never larger than it is, its long side at most `long_edge`."""
    if width <= 0 or height <= 0:
        raise ValueError("an image has a positive size")
    long_edge = max(1, int(long_edge))
    scale = min(1.0, long_edge / max(width, height))
    return max(1, round(width * scale)), max(1, round(height * scale))


def clamp_region(region: tuple[float, float, float, float], stream_w: float, stream_h: float) -> tuple[float, float, float, float]:
    """A logical region inside the stream, at least one logical pixel each way."""
    x, y, w, h = (float(value) for value in region)
    if not all(math.isfinite(value) for value in (x, y, w, h)):
        raise ValueError("region values must be finite")
    x = min(max(0.0, x), max(0.0, stream_w - 1))
    y = min(max(0.0, y), max(0.0, stream_h - 1))
    w = min(max(1.0, w), stream_w - x)
    h = min(max(1.0, h), stream_h - y)
    return x, y, w, h


def logical_to_native(region: tuple[float, float, float, float], stream_size: tuple[float, float], frame_size: tuple[int, int]) -> tuple[int, int, int, int]:
    """The frame pixels a logical region covers, rounded outwards and kept inside the frame."""
    stream_w, stream_h = stream_size
    frame_w, frame_h = frame_size
    x, y, w, h = clamp_region(region, stream_w, stream_h)
    sx = frame_w / stream_w
    sy = frame_h / stream_h
    left = max(0, math.floor(x * sx))
    top = max(0, math.floor(y * sy))
    right = min(frame_w, math.ceil((x + w) * sx))
    bottom = min(frame_h, math.ceil((y + h) * sy))
    return left, top, max(1, right - left), max(1, bottom - top)


def clamp_point(x: float, y: float, stream_w: float, stream_h: float) -> tuple[float, float, bool]:
    """A logical point inside the stream (never on the next display); whether it had to be moved."""
    if not (math.isfinite(x) and math.isfinite(y)):
        raise ValueError("coordinates must be finite")
    edge_x = max(0.0, stream_w - 0.5)
    edge_y = max(0.0, stream_h - 0.5)
    cx = min(max(0.0, x), edge_x)
    cy = min(max(0.0, y), edge_y)
    return cx, cy, (cx != x or cy != y)


def image_to_logical(x: float, y: float, image_size: tuple[int, int], region: tuple[float, float, float, float]) -> tuple[float, float]:
    """A point of an image showing `region` (logical, inside one stream) as a logical stream point."""
    image_w, image_h = image_size
    rx, ry, rw, rh = region
    return rx + (x + 0.5) * rw / image_w, ry + (y + 0.5) * rh / image_h


def path(start: tuple[float, float], end: tuple[float, float], steps: int) -> list[tuple[float, float]]:
    """Points from `start` to `end` (both included), for a drag the app sees as a movement."""
    steps = max(1, int(steps))
    return [(start[0] + (end[0] - start[0]) * i / steps, start[1] + (end[1] - start[1]) * i / steps) for i in range(steps + 1)]
