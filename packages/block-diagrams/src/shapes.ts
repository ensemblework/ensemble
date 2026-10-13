import { textStyle, type PortName, type ShapeId, type TextStyle } from "./model.js";

export interface Point {
  x: number;
  y: number;
}

export type Ports = Record<PortName, Point>;

export interface ShapeGeometry {
  /** SVG path `d` for the outline. */
  outline: string;
  /** Extra strokes (server slots, note fold) that are not filled. */
  details: string;
  ports: Ports;
  filled: boolean;
}

const n = (value: number) => Math.round(value * 100) / 100;

function mid(a: Point, b: Point): Point {
  return { x: n((a.x + b.x) / 2), y: n((a.y + b.y) / 2) };
}

function along(a: Point, b: Point, t: number): Point {
  return { x: n(a.x + (b.x - a.x) * t), y: n(a.y + (b.y - a.y) * t) };
}

function poly(points: Point[]): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${n(point.x)} ${n(point.y)}`).join(" ") + " Z";
}

function boxPorts(w: number, h: number, inset = 1): Ports {
  const x0 = inset;
  const y0 = inset;
  const x1 = w - inset;
  const y1 = h - inset;
  return {
    n: { x: n(w / 2), y: y0 },
    ne: { x: n(x1), y: y0 },
    e: { x: n(x1), y: n(h / 2) },
    se: { x: n(x1), y: n(y1) },
    s: { x: n(w / 2), y: n(y1) },
    sw: { x: x0, y: n(y1) },
    w: { x: x0, y: n(h / 2) },
    nw: { x: x0, y: y0 },
  };
}

function roundedRect(w: number, h: number, radius: number): { outline: string; ports: Ports } {
  const x0 = 1;
  const y0 = 1;
  const x1 = w - 1;
  const y1 = h - 1;
  const r = Math.max(0, Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2));
  const outline = [
    `M ${n(x0 + r)} ${y0}`,
    `H ${n(x1 - r)}`,
    `A ${n(r)} ${n(r)} 0 0 1 ${n(x1)} ${n(y0 + r)}`,
    `V ${n(y1 - r)}`,
    `A ${n(r)} ${n(r)} 0 0 1 ${n(x1 - r)} ${n(y1)}`,
    `H ${n(x0 + r)}`,
    `A ${n(r)} ${n(r)} 0 0 1 ${x0} ${n(y1 - r)}`,
    `V ${n(y0 + r)}`,
    `A ${n(r)} ${n(r)} 0 0 1 ${n(x0 + r)} ${y0}`,
    "Z",
  ].join(" ");
  const corner = (cx: number, cy: number, dx: number, dy: number): Point => ({
    x: n(cx + dx * r * Math.SQRT1_2),
    y: n(cy + dy * r * Math.SQRT1_2),
  });
  const ports = boxPorts(w, h);
  if (r > 0) {
    ports.ne = corner(x1 - r, y0 + r, 1, -1);
    ports.se = corner(x1 - r, y1 - r, 1, 1);
    ports.sw = corner(x0 + r, y1 - r, -1, 1);
    ports.nw = corner(x0 + r, y0 + r, -1, -1);
  }
  return { outline, ports };
}

function ellipsePorts(cx: number, cy: number, rx: number, ry: number): Ports {
  const at = (deg: number): Point => {
    const rad = (deg * Math.PI) / 180;
    return { x: n(cx + rx * Math.cos(rad)), y: n(cy + ry * Math.sin(rad)) };
  };
  return { e: at(0), se: at(45), s: at(90), sw: at(135), w: at(180), nw: at(225), n: at(270), ne: at(315) };
}

function cylinder(w: number, h: number): ShapeGeometry {
  const rx = Math.max(1, w / 2 - 1);
  const ry = Math.max(8, Math.min(18, h * 0.16));
  const cx = w / 2;
  const top = ry + 1;
  const bottom = h - ry - 1;
  const left = cx - rx;
  const right = cx + rx;
  const outline = [
    `M ${n(left)} ${n(top)}`,
    `A ${n(rx)} ${n(ry)} 0 0 1 ${n(right)} ${n(top)}`,
    `L ${n(right)} ${n(bottom)}`,
    `A ${n(rx)} ${n(ry)} 0 0 1 ${n(left)} ${n(bottom)}`,
    "Z",
    `M ${n(right)} ${n(top)}`,
    `A ${n(rx)} ${n(ry)} 0 0 1 ${n(left)} ${n(top)}`,
  ].join(" ");
  const on = (cy: number, deg: number): Point => {
    const rad = (deg * Math.PI) / 180;
    return { x: n(cx + rx * Math.cos(rad)), y: n(cy + ry * Math.sin(rad)) };
  };
  return {
    outline,
    details: "",
    filled: true,
    ports: {
      n: on(top, -90),
      ne: on(top, -35),
      e: { x: n(right), y: n((top + bottom) / 2) },
      se: on(bottom, 35),
      s: on(bottom, 90),
      sw: on(bottom, 145),
      w: { x: n(left), y: n((top + bottom) / 2) },
      nw: on(top, -145),
    },
  };
}

function actor(w: number, h: number): ShapeGeometry {
  const cx = w / 2;
  const headR = Math.min(w * 0.22, h * 0.14, 18);
  const headCy = headR + 3;
  const neck = headCy + headR;
  const hip = h * 0.58;
  const armY = neck + (hip - neck) * 0.45;
  const hand = Math.max(8, w * 0.14);
  const footY = h * 0.86;
  const foot = w * 0.24;
  const outline = [
    `M ${n(cx - headR)} ${n(headCy)}`,
    `A ${n(headR)} ${n(headR)} 0 1 1 ${n(cx + headR)} ${n(headCy)}`,
    `A ${n(headR)} ${n(headR)} 0 1 1 ${n(cx - headR)} ${n(headCy)}`,
    `M ${n(cx)} ${n(neck)} L ${n(cx)} ${n(hip)}`,
    `M ${n(hand)} ${n(armY)} L ${n(w - hand)} ${n(armY)}`,
    `M ${n(cx)} ${n(hip)} L ${n(foot)} ${n(footY)}`,
    `M ${n(cx)} ${n(hip)} L ${n(w - foot)} ${n(footY)}`,
  ].join(" ");
  return {
    outline,
    details: "",
    filled: true,
    ports: {
      n: { x: n(cx), y: n(headCy - headR) },
      ne: { x: n(cx + headR * Math.SQRT1_2), y: n(headCy - headR * Math.SQRT1_2) },
      e: { x: n(w - hand), y: n(armY) },
      se: { x: n(w - foot), y: n(footY) },
      s: { x: n(cx), y: n(footY) },
      sw: { x: n(foot), y: n(footY) },
      w: { x: n(hand), y: n(armY) },
      nw: { x: n(cx - headR * Math.SQRT1_2), y: n(headCy - headR * Math.SQRT1_2) },
    },
  };
}

function cubic(a: Point, b: Point, c: Point, d: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
    y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y,
  };
}

function cloud(w: number, h: number): ShapeGeometry {
  const p = (x: number, y: number) => `${n(w * x)} ${n(h * y)}`;
  const at = (x: number, y: number): Point => ({ x: w * x, y: h * y });
  const curves: Array<[Point, Point, Point, Point]> = [
    [at(0.28, 0.58), at(0.06, 0.58), at(0.04, 0.4), at(0.2, 0.36)],
    [at(0.2, 0.36), at(0.18, 0.18), at(0.36, 0.1), at(0.48, 0.24)],
    [at(0.48, 0.24), at(0.58, 0.08), at(0.78, 0.12), at(0.78, 0.32)],
    [at(0.78, 0.32), at(0.98, 0.34), at(0.98, 0.58), at(0.76, 0.64)],
    [at(0.76, 0.64), at(0.74, 0.86), at(0.42, 0.9), at(0.3, 0.66)],
  ];
  const samples: Point[] = [];
  for (const [a, b, c, d] of curves) {
    for (let step = 0; step <= 32; step += 1) samples.push(cubic(a, b, c, d, step / 32));
  }
  const closeFrom = at(0.3, 0.66);
  const closeTo = at(0.28, 0.58);
  for (let step = 0; step <= 8; step += 1) {
    const t = step / 8;
    samples.push({ x: closeFrom.x + (closeTo.x - closeFrom.x) * t, y: closeFrom.y + (closeTo.y - closeFrom.y) * t });
  }
  const pick = (score: (point: Point) => number): Point => {
    let best = samples[0]!;
    let bestScore = score(best);
    for (const point of samples) {
      const value = score(point);
      if (value > bestScore) {
        best = point;
        bestScore = value;
      }
    }
    return { x: n(best.x), y: n(best.y) };
  };
  const outline = [
    `M ${p(0.28, 0.58)}`,
    `C ${p(0.06, 0.58)} ${p(0.04, 0.4)} ${p(0.2, 0.36)}`,
    `C ${p(0.18, 0.18)} ${p(0.36, 0.1)} ${p(0.48, 0.24)}`,
    `C ${p(0.58, 0.08)} ${p(0.78, 0.12)} ${p(0.78, 0.32)}`,
    `C ${p(0.98, 0.34)} ${p(0.98, 0.58)} ${p(0.76, 0.64)}`,
    `C ${p(0.74, 0.86)} ${p(0.42, 0.9)} ${p(0.3, 0.66)}`,
    "Z",
  ].join(" ");
  return {
    outline,
    details: "",
    filled: true,
    ports: {
      n: pick((point) => -point.y),
      ne: pick((point) => point.x * 1.15 - point.y),
      e: pick((point) => point.x),
      se: pick((point) => point.x + point.y),
      s: pick((point) => point.y),
      sw: pick((point) => -point.x + point.y),
      w: pick((point) => -point.x),
      nw: pick((point) => -point.x * 1.15 - point.y),
    },
  };
}

function documentShape(w: number, h: number): ShapeGeometry {
  const left = 1;
  const right = w - 1;
  const top = 1;
  const neck = h - Math.min(16, h * 0.18);
  const dip = h - 1;
  const p0 = { x: right, y: neck };
  const c1 = { x: w * 0.72, y: dip };
  const p1 = { x: w * 0.5, y: neck + (dip - neck) * 0.35 };
  const c2 = { x: w * 0.28, y: neck - 4 };
  const p2 = { x: left, y: neck };
  const at = (a: Point, control: Point, b: Point, t: number): Point => {
    const u = 1 - t;
    return {
      x: n(u * u * a.x + 2 * u * t * control.x + t * t * b.x),
      y: n(u * u * a.y + 2 * u * t * control.y + t * t * b.y),
    };
  };
  const outline = [
    `M ${left} ${top}`,
    `H ${n(right)}`,
    `V ${n(neck)}`,
    `Q ${n(c1.x)} ${n(c1.y)} ${n(p1.x)} ${n(p1.y)}`,
    `Q ${n(c2.x)} ${n(c2.y)} ${n(p2.x)} ${n(p2.y)}`,
    "Z",
  ].join(" ");
  const south = at(p0, c1, p1, 0.55);
  return {
    outline,
    details: "",
    filled: true,
    ports: {
      n: { x: n(w / 2), y: top },
      ne: { x: n(right), y: n(h * 0.28) },
      e: { x: n(right), y: n((top + neck) / 2) },
      se: at(p0, c1, p1, 0.25),
      s: south,
      sw: at(p1, c2, p2, 0.6),
      w: { x: left, y: n((top + neck) / 2) },
      nw: { x: left, y: n(h * 0.28) },
    },
  };
}

function note(w: number, h: number): ShapeGeometry {
  const fold = Math.min(18, w * 0.22, h * 0.28);
  const x0 = 1;
  const y0 = 1;
  const x1 = w - 1;
  const y1 = h - 1;
  const outline = `M ${x0} ${y0} H ${n(x1 - fold)} L ${n(x1)} ${n(y0 + fold)} V ${n(y1)} H ${x0} Z`;
  const details = `M ${n(x1 - fold)} ${y0} V ${n(y0 + fold)} H ${n(x1)}`;
  return {
    outline,
    details,
    filled: true,
    ports: {
      n: { x: n(Math.min(w / 2, x1 - fold - 4)), y: y0 },
      ne: { x: n(x1), y: n(y0 + fold) },
      e: { x: n(x1), y: n(h / 2) },
      se: { x: n(x1), y: n(y1) },
      s: { x: n(w / 2), y: n(y1) },
      sw: { x: x0, y: n(y1) },
      w: { x: x0, y: n(h / 2) },
      nw: { x: x0, y: y0 },
    },
  };
}

function server(w: number, h: number): ShapeGeometry {
  const body = roundedRect(w, h, 8);
  const top = 1;
  const bottom = h - 1;
  const left = 10;
  const right = w - 10;
  const details = [1 / 3, 2 / 3]
    .map((t) => {
      const y = n(top + (bottom - top) * t);
      return `M ${n(left)} ${y} H ${n(right)}`;
    })
    .join(" ");
  return { outline: body.outline, details, ports: body.ports, filled: true };
}

/** A cylinder on its side: a message queue or stream. The rim shows at the right end. */
function queue(w: number, h: number): ShapeGeometry {
  const rx = Math.max(4, Math.min(16, w * 0.14));
  const ry = Math.max(4, h / 2 - 1);
  const cy = h / 2;
  const top = cy - ry;
  const bottom = cy + ry;
  const left = 1 + rx;
  const right = w - 1 - rx;
  const outline = [
    `M ${n(left)} ${n(top)}`,
    `L ${n(right)} ${n(top)}`,
    `A ${n(rx)} ${n(ry)} 0 0 1 ${n(right)} ${n(bottom)}`,
    `L ${n(left)} ${n(bottom)}`,
    `A ${n(rx)} ${n(ry)} 0 0 1 ${n(left)} ${n(top)}`,
    "Z",
  ].join(" ");
  const details = `M ${n(right)} ${n(top)} A ${n(rx)} ${n(ry)} 0 0 0 ${n(right)} ${n(bottom)}`;
  const on = (cx: number, deg: number): Point => {
    const rad = (deg * Math.PI) / 180;
    return { x: n(cx + rx * Math.cos(rad)), y: n(cy + ry * Math.sin(rad)) };
  };
  return {
    outline,
    details,
    filled: true,
    ports: {
      n: { x: n(w / 2), y: n(top) },
      ne: on(right, -45),
      e: { x: n(w - 1), y: n(cy) },
      se: on(right, 45),
      s: { x: n(w / 2), y: n(bottom) },
      sw: on(left, 135),
      w: { x: 1, y: n(cy) },
      nw: on(left, 225),
    },
  };
}

/** Flowchart "predefined process": a box with a bar inside each side. */
function subroutine(w: number, h: number): ShapeGeometry {
  const bar = Math.min(10, w * 0.1);
  const outline = poly([{ x: 1, y: 1 }, { x: w - 1, y: 1 }, { x: w - 1, y: h - 1 }, { x: 1, y: h - 1 }]);
  const details = `M ${n(1 + bar)} 1 V ${n(h - 1)} M ${n(w - 1 - bar)} 1 V ${n(h - 1)}`;
  return { outline, details, filled: true, ports: boxPorts(w, h) };
}

/** A browser window: a web app or site. */
function browser(w: number, h: number): ShapeGeometry {
  const body = roundedRect(w, h, 6);
  const bar = Math.min(16, Math.max(10, h * 0.2));
  const dot = (cx: number) => `M ${n(cx - 2)} ${n(bar / 2 + 0.5)} A 2 2 0 1 1 ${n(cx + 2)} ${n(bar / 2 + 0.5)} A 2 2 0 1 1 ${n(cx - 2)} ${n(bar / 2 + 0.5)}`;
  const details = [`M 1 ${n(bar)} H ${n(w - 1)}`, dot(9), dot(16), dot(23)].join(" ");
  return { outline: body.outline, details, filled: true, ports: body.ports };
}

/** Flowchart "delay": flat on the left, round on the right. */
function delay(w: number, h: number): ShapeGeometry {
  const ry = Math.max(4, h / 2 - 1);
  const rx = Math.max(4, Math.min(ry, (w - 2) / 2));
  const cx = w - 1 - rx;
  const cy = h / 2;
  const outline = `M 1 1 H ${n(cx)} A ${n(rx)} ${n(ry)} 0 0 1 ${n(cx)} ${n(h - 1)} H 1 Z`;
  const on = (deg: number): Point => {
    const rad = (deg * Math.PI) / 180;
    return { x: n(cx + rx * Math.cos(rad)), y: n(cy + ry * Math.sin(rad)) };
  };
  return {
    outline,
    details: "",
    filled: true,
    ports: {
      n: { x: n(Math.min(w / 2, cx)), y: 1 },
      ne: on(-45),
      e: { x: n(w - 1), y: n(cy) },
      se: on(45),
      s: { x: n(Math.min(w / 2, cx)), y: n(h - 1) },
      sw: { x: 1, y: n(h - 1) },
      w: { x: 1, y: n(cy) },
      nw: { x: 1, y: 1 },
    },
  };
}

/** Outline path plus the 8 connection points that sit on that outline. */
export function shapeGeometry(shape: ShapeId, w: number, h: number): ShapeGeometry {
  const width = Math.max(8, w);
  const height = Math.max(8, h);
  switch (shape) {
    case "rectangle":
      return { outline: poly([{ x: 1, y: 1 }, { x: width - 1, y: 1 }, { x: width - 1, y: height - 1 }, { x: 1, y: height - 1 }]), details: "", ports: boxPorts(width, height), filled: true };
    case "rounded":
      return { ...roundedRect(width, height, Math.min(16, height / 2 - 1)), details: "", filled: true };
    case "diamond": {
      const north = { x: width / 2, y: 1 };
      const east = { x: width - 1, y: height / 2 };
      const south = { x: width / 2, y: height - 1 };
      const west = { x: 1, y: height / 2 };
      return {
        outline: poly([north, east, south, west]),
        details: "",
        filled: true,
        ports: {
          n: { x: n(north.x), y: n(north.y) },
          ne: mid(north, east),
          e: { x: n(east.x), y: n(east.y) },
          se: mid(east, south),
          s: { x: n(south.x), y: n(south.y) },
          sw: mid(south, west),
          w: { x: n(west.x), y: n(west.y) },
          nw: mid(west, north),
        },
      };
    }
    case "circle": {
      const rad = Math.min(width, height) / 2 - 1;
      const cx = width / 2;
      const cy = height / 2;
      return {
        outline: `M ${n(cx - rad)} ${n(cy)} A ${n(rad)} ${n(rad)} 0 1 1 ${n(cx + rad)} ${n(cy)} A ${n(rad)} ${n(rad)} 0 1 1 ${n(cx - rad)} ${n(cy)}`,
        details: "",
        filled: true,
        ports: ellipsePorts(cx, cy, rad, rad),
      };
    }
    case "ellipse": {
      const rx = width / 2 - 1;
      const ry = height / 2 - 1;
      const cx = width / 2;
      const cy = height / 2;
      return {
        outline: `M ${n(cx - rx)} ${n(cy)} A ${n(rx)} ${n(ry)} 0 1 1 ${n(cx + rx)} ${n(cy)} A ${n(rx)} ${n(ry)} 0 1 1 ${n(cx - rx)} ${n(cy)}`,
        details: "",
        filled: true,
        ports: ellipsePorts(cx, cy, rx, ry),
      };
    }
    case "cylinder":
      return cylinder(width, height);
    case "server":
      return server(width, height);
    case "triangle": {
      const north = { x: width / 2, y: 1 };
      const east = { x: width - 1, y: height - 1 };
      const west = { x: 1, y: height - 1 };
      return {
        outline: poly([north, east, west]),
        details: "",
        filled: true,
        ports: {
          n: { x: n(north.x), y: n(north.y) },
          ne: along(north, east, 0.42),
          e: mid(north, east),
          se: { x: n(east.x), y: n(east.y) },
          s: mid(east, west),
          sw: { x: n(west.x), y: n(west.y) },
          w: mid(west, north),
          nw: along(north, west, 0.42),
        },
      };
    }
    case "parallelogram": {
      const skew = Math.min(28, width * 0.18);
      const nw = { x: 1 + skew, y: 1 };
      const ne = { x: width - 1, y: 1 };
      const se = { x: width - 1 - skew, y: height - 1 };
      const sw = { x: 1, y: height - 1 };
      return {
        outline: poly([nw, ne, se, sw]),
        details: "",
        filled: true,
        ports: { nw: { x: n(nw.x), y: n(nw.y) }, n: mid(nw, ne), ne: { x: n(ne.x), y: n(ne.y) }, e: mid(ne, se), se: { x: n(se.x), y: n(se.y) }, s: mid(se, sw), sw: { x: n(sw.x), y: n(sw.y) }, w: mid(sw, nw) },
      };
    }
    case "trapezoid": {
      const inset = Math.min(32, width * 0.16);
      const nw = { x: inset, y: 1 };
      const ne = { x: width - inset, y: 1 };
      const se = { x: width - 1, y: height - 1 };
      const sw = { x: 1, y: height - 1 };
      return {
        outline: poly([nw, ne, se, sw]),
        details: "",
        filled: true,
        ports: { nw: { x: n(nw.x), y: n(nw.y) }, n: mid(nw, ne), ne: { x: n(ne.x), y: n(ne.y) }, e: mid(ne, se), se: { x: n(se.x), y: n(se.y) }, s: mid(se, sw), sw: { x: n(sw.x), y: n(sw.y) }, w: mid(sw, nw) },
      };
    }
    case "hexagon": {
      const top = { x: width / 2, y: 1 };
      const ur = { x: width - 1, y: height * 0.27 };
      const lr = { x: width - 1, y: height * 0.73 };
      const bottom = { x: width / 2, y: height - 1 };
      const ll = { x: 1, y: height * 0.73 };
      const ul = { x: 1, y: height * 0.27 };
      return {
        outline: poly([top, ur, lr, bottom, ll, ul]),
        details: "",
        filled: true,
        ports: {
          n: { x: n(top.x), y: n(top.y) },
          ne: { x: n(ur.x), y: n(ur.y) },
          e: mid(ur, lr),
          se: { x: n(lr.x), y: n(lr.y) },
          s: { x: n(bottom.x), y: n(bottom.y) },
          sw: { x: n(ll.x), y: n(ll.y) },
          w: mid(ll, ul),
          nw: { x: n(ul.x), y: n(ul.y) },
        },
      };
    }
    case "document":
      return documentShape(width, height);
    case "cloud":
      return cloud(width, height);
    case "actor":
      return actor(width, height);
    case "note":
      return note(width, height);
    case "queue":
      return queue(width, height);
    case "subroutine":
      return subroutine(width, height);
    case "browser":
      return browser(width, height);
    case "delay":
      return delay(width, height);
    default: {
      const _exhaustive: never = shape;
      return _exhaustive;
    }
  }
}

export function shapePath(shape: ShapeId, w: number, h: number): string {
  return shapeGeometry(shape, w, h).outline;
}

export function shapePorts(shape: ShapeId, w: number, h: number): Ports {
  return shapeGeometry(shape, w, h).ports;
}

export const DEFAULT_SIZE: Record<ShapeId, { w: number; h: number }> = {
  rectangle: { w: 120, h: 46 },
  rounded: { w: 120, h: 46 },
  diamond: { w: 112, h: 74 },
  circle: { w: 72, h: 72 },
  ellipse: { w: 108, h: 56 },
  cylinder: { w: 104, h: 70 },
  server: { w: 116, h: 78 },
  triangle: { w: 104, h: 76 },
  parallelogram: { w: 116, h: 46 },
  document: { w: 116, h: 66 },
  cloud: { w: 128, h: 86 },
  actor: { w: 96, h: 112 },
  hexagon: { w: 108, h: 64 },
  note: { w: 116, h: 74 },
  trapezoid: { w: 124, h: 48 },
  queue: { w: 132, h: 52 },
  subroutine: { w: 132, h: 48 },
  browser: { w: 140, h: 84 },
  delay: { w: 112, h: 52 },
};

/** Average advance of the 13px medium label face. Keeps sizing free of a DOM. */
const LABEL_CHAR = 7.5;
const LABEL_LINE = 16;
const ACTOR_FIGURE = 78;
/** Default label sizes, px: in a block, in a text box, on a line. */
export const LABEL_SIZE = { block: 13, text: 12.5, edge: 11 } as const;

/** Advance per character and line height for a label style. Bold runs about 6% wider. */
export function labelMetrics(font: Partial<TextStyle> | null | undefined, base: number = LABEL_SIZE.block): { size: number; char: number; line: number } {
  const style = textStyle(font);
  const size = style.size ?? base;
  const scale = size / LABEL_SIZE.block;
  return { size, char: LABEL_CHAR * scale * (style.bold ? 1.06 : 1), line: Math.round(LABEL_LINE * scale * 10) / 10 };
}

function labelText(label: string): string {
  return label.replace(/\s+/g, " ").trim() || " ";
}

function textAdvance(line: string, char = LABEL_CHAR): number {
  return Math.max(1, line.length) * char;
}

function wrapWords(label: string, maxWidth: number, char = LABEL_CHAR): string[] {
  const words = labelText(label).split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (current && textAdvance(next, char) > maxWidth) {
      lines.push(current);
      current = word;
    } else current = next;
  }
  if (current) lines.push(current);
  return lines;
}

/** Wrapped label lines, at most `maxLines`. A single long word stays intact so the block can grow for it. */
export function wrapLabel(label: string, maxWidth: number, maxLines = 2, font?: Partial<TextStyle> | null): string[] {
  return wrapWords(label, maxWidth, labelMetrics(font).char).slice(0, Math.max(1, maxLines));
}

export interface TextFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Rectangle inside the outline where the label is allowed to sit. */
export function textFrame(shape: ShapeId, w: number, h: number): TextFrame {
  switch (shape) {
    case "diamond":
    case "triangle":
      return { x: w * 0.28, y: h * 0.34, w: w * 0.44, h: h * 0.32 };
    case "hexagon":
      return { x: w * 0.18, y: h * 0.3, w: w * 0.64, h: h * 0.4 };
    case "circle":
    case "ellipse":
      return { x: w * 0.2, y: h * 0.28, w: w * 0.6, h: h * 0.44 };
    case "cloud":
      return { x: w * 0.24, y: h * 0.34, w: w * 0.52, h: h * 0.34 };
    case "parallelogram": {
      const skew = Math.min(22, w * 0.16);
      return { x: skew * 0.55 + 8, y: 7, w: Math.max(24, w - skew - 16), h: Math.max(16, h - 14) };
    }
    case "trapezoid": {
      const inset = Math.min(24, w * 0.16);
      return { x: inset * 0.45 + 8, y: 7, w: Math.max(24, w - inset - 16), h: Math.max(16, h - 14) };
    }
    case "cylinder": {
      const ry = Math.max(8, Math.min(16, h * 0.16));
      return { x: 12, y: ry + 4, w: Math.max(24, w - 24), h: Math.max(16, h - ry * 2 - 10) };
    }
    case "document":
      return { x: 12, y: 8, w: Math.max(24, w - 24), h: Math.max(16, h * 0.58) };
    case "note":
      return { x: 10, y: 10, w: Math.max(24, w - 28), h: Math.max(16, h - 22) };
    case "queue": {
      const rx = Math.max(4, Math.min(16, w * 0.14));
      return { x: rx + 6, y: 6, w: Math.max(24, w - rx * 2 - 16), h: Math.max(16, h - 12) };
    }
    case "subroutine": {
      const bar = Math.min(10, w * 0.1);
      return { x: bar + 7, y: 7, w: Math.max(24, w - bar * 2 - 14), h: Math.max(16, h - 14) };
    }
    case "browser": {
      const bar = Math.min(16, Math.max(10, h * 0.2));
      return { x: 10, y: bar + 5, w: Math.max(24, w - 20), h: Math.max(16, h - bar - 11) };
    }
    case "delay": {
      const rx = Math.max(4, Math.min(h / 2 - 1, (w - 2) / 2));
      return { x: 10, y: 7, w: Math.max(24, w - rx * 0.6 - 16), h: Math.max(16, h - 14) };
    }
    case "actor": {
      const top = Math.min(ACTOR_FIGURE + 12, Math.max(16, h - LABEL_LINE));
      const hand = Math.max(8, w * 0.14);
      return { x: hand, y: top, w: Math.max(24, w - hand * 2), h: Math.max(LABEL_LINE, h - top - 2) };
    }
    default:
      return { x: 10, y: 7, w: Math.max(24, w - 20), h: Math.max(16, h - 14) };
  }
}

/** Height of the stick figure. The label sits underneath, clear of the ports. */
export function outlineSize(shape: ShapeId, w: number, h: number): { w: number; h: number } {
  if (shape !== "actor") return { w, h };
  const frame = textFrame(shape, w, h);
  return { w, h: Math.max(48, frame.y - 6) };
}

function sizeLimits(shape: ShapeId): { maxW: number; maxH: number } {
  if (shape === "circle") return { maxW: 150, maxH: 150 };
  if (shape === "actor") return { maxW: 176, maxH: 160 };
  if (shape === "diamond" || shape === "triangle") return { maxW: 210, maxH: 160 };
  return { maxW: 240, maxH: 150 };
}

/** The size a new block gets: the default for its shape, grown until the label fits on two lines. */
export function nodeSize(shape: ShapeId, label: string, font?: Partial<TextStyle> | null): { w: number; h: number } {
  const base = DEFAULT_SIZE[shape];
  const metrics = labelMetrics(font);
  const grow = Math.max(1, metrics.size / LABEL_SIZE.block);
  const limits = sizeLimits(shape);
  const maxW = limits.maxW * grow;
  const maxH = limits.maxH * grow;
  let w = base.w;
  let h = base.h;
  const text = labelText(label);
  for (let pass = 0; pass < 48; pass += 1) {
    const inner = Math.max(20, textFrame(shape, w, h).w);
    const natural = wrapWords(text, inner, metrics.char);
    const lines = natural.slice(0, 2);
    const widest = Math.max(...lines.map((line) => textAdvance(line, metrics.char)));
    const frame = textFrame(shape, w, h);
    const needsWidth = (natural.length > 2 || widest + 4 > frame.w) && w < maxW;
    const needsHeight = lines.length * metrics.line + 3 > frame.h && h < maxH;
    if (!needsWidth && !needsHeight) break;
    if (needsWidth) w = Math.min(maxW, w + 12);
    else h = Math.min(maxH, h + 8);
  }
  if (shape === "circle") w = h = Math.max(w, h);
  return { w: Math.round(w), h: Math.round(h) };
}

/** Lines a label may wrap to before a block is too small for it. */
const MIN_LINES = 3;

/**
 * The smallest a block can be resized to: its label on at most three lines, its longest word
 * unbroken, and never below about half the shape's default (a person keeps room for the figure).
 */
export function minNodeSize(shape: ShapeId, label: string, font?: Partial<TextStyle> | null): { w: number; h: number } {
  const base = DEFAULT_SIZE[shape];
  const metrics = labelMetrics(font);
  const floor = { w: Math.round(base.w * 0.5), h: Math.round(shape === "actor" ? 64 + metrics.line : base.h * 0.55) };
  const text = labelText(label);
  const longest = Math.max(...text.split(" ").map((word) => textAdvance(word, metrics.char)));
  const heightFor = (w: number, lines: number): number => {
    let h = floor.h;
    while (h < 2000 && textFrame(shape, w, h).h < lines * metrics.line + 2) h += 2;
    return h;
  };
  for (let w = floor.w; w < 2400; w += 2) {
    const frame = textFrame(shape, w, floor.h);
    if (frame.w < longest + 2) continue;
    const lines = wrapWords(text, frame.w, metrics.char).length;
    if (lines > MIN_LINES) continue;
    const h = heightFor(w, lines);
    if (shape === "circle") {
      const side = Math.max(w, h);
      return { w: side, h: side };
    }
    return { w, h };
  }
  return nodeSize(shape, label, font);
}

/** A text box's size: every line on one row, as typed. */
export function textSize(text: string, font?: Partial<TextStyle> | null): { w: number; h: number } {
  const metrics = labelMetrics(font, LABEL_SIZE.text);
  const lines = text.split("\n");
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 1);
  const scale = metrics.size / LABEL_SIZE.text;
  return {
    w: Math.min(380 * Math.max(1, scale), Math.max(96, Math.round(longest * metrics.char + 28))),
    h: Math.max(40, Math.round(lines.length * 20 * scale + 16)),
  };
}

/** The smallest a text box can be resized to: its longest word fits, and every wrapped line shows. */
export function minTextSize(text: string, font?: Partial<TextStyle> | null, width?: number): { w: number; h: number } {
  const metrics = labelMetrics(font, LABEL_SIZE.text);
  const words = text.split(/\s+/).filter(Boolean);
  const w = Math.max(48, Math.round(Math.max(1, ...words.map((word) => word.length)) * metrics.char + 16));
  const inner = Math.max(w, width ?? w) - 16;
  const rows = text.split("\n").reduce((sum, line) => sum + Math.max(1, wrapWords(line, inner, metrics.char).length), 0);
  return { w, h: Math.max(28, Math.round(rows * 20 * (metrics.size / LABEL_SIZE.text) + 12)) };
}

/** Padding so a label sits inside the outline instead of on the corners. */
export function labelPadding(shape: ShapeId, w: number, h: number): string {
  const frame = textFrame(shape, w, h);
  const top = Math.max(0, Math.round(frame.y));
  const right = Math.max(0, Math.round(w - frame.x - frame.w));
  const bottom = Math.max(0, Math.round(h - frame.y - frame.h));
  const left = Math.max(0, Math.round(frame.x));
  return `${top}px ${right}px ${bottom}px ${left}px`;
}

export interface PlacedShape {
  shape: ShapeId;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The side an unnamed line should use. Corner ports sit on the outline, so the
 * nearest pair for two stacked blocks is the corners, and the stroke runs down
 * the box edge. A line that does not name ports leaves the facing side instead:
 * bottom to top when the next block is below, left to right when it is beside.
 */
export function closestPorts(from: PlacedShape, to: PlacedShape): { from: PortName; to: PortName } {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2);
  const dy = to.y + to.h / 2 - (from.y + from.h / 2);
  if (Math.abs(dy) >= Math.abs(dx)) return dy >= 0 ? { from: "s", to: "n" } : { from: "n", to: "s" };
  return dx >= 0 ? { from: "e", to: "w" } : { from: "w", to: "e" };
}

const SHAPE_ALIAS: Record<string, ShapeId> = {
  rectangle: "rectangle",
  rect: "rectangle",
  box: "rectangle",
  square: "rectangle",
  process: "rectangle",
  rounded: "rounded",
  round: "rounded",
  pill: "rounded",
  stadium: "rounded",
  diamond: "diamond",
  decision: "diamond",
  choice: "diamond",
  if: "diamond",
  rhombus: "diamond",
  circle: "circle",
  ellipse: "ellipse",
  oval: "ellipse",
  cylinder: "cylinder",
  database: "cylinder",
  db: "cylinder",
  datastore: "cylinder",
  storage: "cylinder",
  server: "server",
  rack: "server",
  triangle: "triangle",
  delta: "triangle",
  parallelogram: "parallelogram",
  io: "parallelogram",
  input: "parallelogram",
  output: "parallelogram",
  data: "parallelogram",
  document: "document",
  doc: "document",
  file: "document",
  cloud: "cloud",
  actor: "actor",
  person: "actor",
  user: "actor",
  stick: "actor",
  hexagon: "hexagon",
  hex: "hexagon",
  prepare: "hexagon",
  preparation: "hexagon",
  note: "note",
  sticky: "note",
  comment: "note",
  trapezoid: "trapezoid",
  trap: "trapezoid",
  manual: "trapezoid",
  queue: "queue",
  mq: "queue",
  "message-queue": "queue",
  messagequeue: "queue",
  topic: "queue",
  stream: "queue",
  kafka: "queue",
  subroutine: "subroutine",
  subprocess: "subroutine",
  "sub-process": "subroutine",
  predefined: "subroutine",
  function: "subroutine",
  browser: "browser",
  web: "browser",
  webapp: "browser",
  website: "browser",
  window: "browser",
  frontend: "browser",
  ui: "browser",
  delay: "delay",
  wait: "delay",
  dshape: "delay",
};

export const SHAPE_ALIASES: Readonly<Record<string, ShapeId>> = SHAPE_ALIAS;

export function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + cost);
      prev = current;
    }
  }
  return row[b.length]!;
}

export interface ResolvedShape {
  shape: ShapeId;
  warning: string | null;
  /** Shape name to offer when the word was a near miss. */
  suggestion: ShapeId | null;
}

/** Exact alias, then a one-or-two character typo, otherwise a rectangle. */
export function resolveShape(raw: string): ResolvedShape {
  const key = normalizeToken(raw);
  const exact = SHAPE_ALIAS[key];
  if (exact) return { shape: exact, warning: null, suggestion: null };
  if (key.length < 4) {
    return { shape: "rectangle", warning: `I don’t know the shape “${raw}”. I used a rectangle.`, suggestion: null };
  }
  let best: { shape: ShapeId; dist: number } | null = null;
  let tied = false;
  for (const [alias, shape] of Object.entries(SHAPE_ALIAS)) {
    const dist = levenshtein(key, alias);
    if (dist > 2) continue;
    if (!best || dist < best.dist) {
      best = { shape, dist };
      tied = false;
    } else if (dist === best.dist && shape !== best.shape) {
      tied = true;
    }
  }
  if (!best || tied) return { shape: "rectangle", warning: `I don’t know the shape “${raw}”. I used a rectangle.`, suggestion: null };
  return {
    shape: best.shape,
    warning: `Did you mean ${best.shape}? “${raw}” isn’t a shape, so I used ${best.shape}.`,
    suggestion: best.shape,
  };
}

const PORT_ALIAS: Record<string, PortName> = {
  n: "n",
  north: "n",
  top: "n",
  ne: "ne",
  northeast: "ne",
  topright: "ne",
  "top-right": "ne",
  e: "e",
  east: "e",
  right: "e",
  se: "se",
  southeast: "se",
  bottomright: "se",
  "bottom-right": "se",
  s: "s",
  south: "s",
  bottom: "s",
  sw: "sw",
  southwest: "sw",
  bottomleft: "sw",
  "bottom-left": "sw",
  w: "w",
  west: "w",
  left: "w",
  nw: "nw",
  northwest: "nw",
  topleft: "nw",
  "top-left": "nw",
};

export function resolvePort(raw: string): PortName | null {
  return PORT_ALIAS[normalizeToken(raw)] ?? null;
}

const COLOR_ALIAS: Record<string, string> = {
  slate: "slate",
  gray: "slate",
  grey: "slate",
  red: "red",
  orange: "orange",
  amber: "amber",
  yellow: "amber",
  green: "green",
  teal: "teal",
  blue: "blue",
  indigo: "indigo",
  purple: "purple",
  violet: "purple",
  pink: "pink",
};

export function resolveColor(raw: string): string | null {
  const key = normalizeToken(raw);
  if (COLOR_ALIAS[key]) return COLOR_ALIAS[key];
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw.trim())) return raw.trim();
  return null;
}

/** A palette name within two edits, when the word is not already a colour. */
export function suggestColor(raw: string): string | null {
  if (resolveColor(raw)) return null;
  const key = normalizeToken(raw);
  if (key.length < 3) return null;
  let best: { name: string; dist: number } | null = null;
  const seen = new Set<string>();
  for (const [alias, name] of Object.entries(COLOR_ALIAS)) {
    if (alias !== name || seen.has(name)) continue;
    seen.add(name);
    const dist = levenshtein(key, name);
    if (dist === 0 || dist > 2) continue;
    if (!best || dist < best.dist) best = { name, dist };
  }
  return best?.name ?? null;
}
