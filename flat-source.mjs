import { polygon, svgpath } from "./vendor.mjs";
function ringsToFill(rings, rule) {
  return polygon.fill(
    rings.filter((r) => r.length > 3),
    rule === "evenodd",
  );
}
function shapeD(el) {
  const n = (k) => Number(el.getAttribute(k) || 0);
  switch (el.localName) {
    case "path":
      return el.getAttribute("d") || "";
    case "rect": {
      const x = n("x"),
        y = n("y"),
        w = n("width"),
        h = n("height"),
        rx = Math.min(w / 2, n("rx") || n("ry")),
        ry = Math.min(h / 2, n("ry") || n("rx"));
      if (!rx && !ry) return `M${x} ${y}h${w}v${h}h${-w}Z`;
      return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
    }
    case "circle":
    case "ellipse": {
      const x = n("cx"),
        y = n("cy"),
        rx = n("r") || n("rx"),
        ry = n("r") || n("ry");
      return `M${x - rx} ${y}A${rx} ${ry} 0 1 0 ${x + rx} ${y}A${rx} ${ry} 0 1 0 ${x - rx} ${y}Z`;
    }
    case "polygon":
    case "polyline":
      return "M" + (el.getAttribute("points") || "") + "Z";
    case "line":
      return "";
    default:
      return null;
  }
}
// Adaptive curve flattening: tolerance is relative to the longest artwork side.
function flatten(d, m, width, height, subpaths = null, tolerance = 1 / 100000) {
  const path = svgpath(d)
    .abs()
    .unshort()
    .unarc()
    .matrix([m.a / width, m.b / height, m.c / width, m.d / height, m.e / width, m.f / height]);
  if (path.err) throw new Error("Некорректный векторный контур.");
  const rings = [];
  let ring = [],
    p = [0, 0],
    start = [0, 0],
    count = 0;
  const emit = (q) => {
    if (++count > 80000) throw new Error("Слишком сложный контур.");
    ring.push(q);
    p = q;
  };
  const distance = (q, a, b) => {
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      l = dx * dx + dy * dy;
    if (!l) return Math.hypot(q[0] - a[0], q[1] - a[1]);
    const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l));
    return Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy);
  };
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  function cubic(a, b, c, d, depth = 0) {
    if (depth >= 18 || Math.max(distance(b, a, d), distance(c, a, d)) < tolerance) {
      emit(d);
      return;
    }
    const ab = mid(a, b),
      bc = mid(b, c),
      cd = mid(c, d),
      abc = mid(ab, bc),
      bcd = mid(bc, cd),
      q = mid(abc, bcd);
    cubic(a, ab, abc, q, depth + 1);
    cubic(q, bcd, cd, d, depth + 1);
  }
  function close(explicit = false) {
    if (subpaths && ring.length) subpaths.push({ pts: ring.slice(), closed: explicit });
    if (ring.length > 2) {
      if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) ring.push(ring[0]);
      rings.push(ring);
    }
    ring = [];
  }
  path.iterate((s) => {
    switch (s[0]) {
      case "M":
        close();
        start = [s[1], s[2]];
        emit(start);
        break;
      case "L":
        emit([s[1], s[2]]);
        break;
      case "H":
        emit([s[1], p[1]]);
        break;
      case "V":
        emit([p[0], s[1]]);
        break;
      case "C":
        cubic(p, [s[1], s[2]], [s[3], s[4]], [s[5], s[6]]);
        break;
      case "Q": {
        const q = [s[1], s[2]],
          e = [s[3], s[4]],
          a = p;
        cubic(
          a,
          [a[0] + ((q[0] - a[0]) * 2) / 3, a[1] + ((q[1] - a[1]) * 2) / 3],
          [e[0] + ((q[0] - e[0]) * 2) / 3, e[1] + ((q[1] - e[1]) * 2) / 3],
          e,
        );
        break;
      }
      case "Z":
        close(true);
        p = start;
        break;
      default:
        throw new Error("Неподдерживаемая команда контура: " + s[0]);
    }
  });
  close();
  return rings;
}
function strokeD(el) {
  const n = (k) => Number(el.getAttribute(k) || 0);
  if (el.localName === "line") return `M${n("x1")} ${n("y1")}L${n("x2")} ${n("y2")}`;
  if (el.localName === "polyline") return "M" + (el.getAttribute("points") || "");
  return shapeD(el);
}
// Converts stroked subpaths (in px) into a filled outline: one quad per segment plus joins and caps.
function strokeOutline(subpaths, width, join, cap, miterLimit) {
  const h = width / 2,
    rings = [];
  const add = (pts) => {
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i],
        b = pts[(i + 1) % pts.length];
      area += a[0] * b[1] - b[0] * a[1];
    }
    if (Math.abs(area) < 1e-12) return;
    if (area < 0) pts.reverse();
    rings.push([...pts, pts[0]]);
  };
  const steps = Math.max(12, Math.min(72, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - 0.02 / Math.max(h, 0.02))))));
  const circle = (c) =>
    add(
      Array.from({ length: steps }, (_, i) => [
        c[0] + h * Math.cos((i / steps) * 2 * Math.PI),
        c[1] + h * Math.sin((i / steps) * 2 * Math.PI),
      ]),
    );
  for (const { pts: raw, closed } of subpaths) {
    const pts = raw.filter((p, i) => !i || Math.hypot(p[0] - raw[i - 1][0], p[1] - raw[i - 1][1]) > 1e-9);
    if (closed && pts.length > 1 && Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]) < 1e-9)
      pts.pop();
    const n = pts.length;
    if (n < 2) {
      if (n && cap === "round") circle(pts[0]);
      continue;
    }
    const segs = closed ? n : n - 1,
      unit = (a, b) => {
        const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
        return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
      };
    for (let i = 0; i < segs; i++) {
      let a = pts[i],
        b = pts[(i + 1) % n];
      const d = unit(a, b),
        nx = -d[1] * h,
        ny = d[0] * h;
      if (!closed && cap === "square") {
        if (i === 0) a = [a[0] - d[0] * h, a[1] - d[1] * h];
        if (i === segs - 1) b = [b[0] + d[0] * h, b[1] + d[1] * h];
      }
      add([
        [a[0] + nx, a[1] + ny],
        [b[0] + nx, b[1] + ny],
        [b[0] - nx, b[1] - ny],
        [a[0] - nx, a[1] - ny],
      ]);
    }
    for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
      const v = pts[i],
        d1 = unit(pts[(i - 1 + n) % n], v),
        d2 = unit(v, pts[(i + 1) % n]),
        cross = d1[0] * d2[1] - d1[1] * d2[0];
      if (join === "round") {
        if (Math.abs(cross) > 1e-6 || d1[0] * d2[0] + d1[1] * d2[1] < 0) circle(v);
        continue;
      }
      if (Math.abs(cross) < 1e-9) continue;
      const side = cross > 0 ? -1 : 1,
        n1 = [-d1[1] * side, d1[0] * side],
        n2 = [-d2[1] * side, d2[0] * side],
        p1 = [v[0] + n1[0] * h, v[1] + n1[1] * h],
        p2 = [v[0] + n2[0] * h, v[1] + n2[1] * h],
        dot = n1[0] * n2[0] + n1[1] * n2[1];
      if (join === "miter" && 1 + dot > 1e-9 && Math.sqrt(2 / (1 + dot)) <= miterLimit)
        add([v, p1, [v[0] + ((n1[0] + n2[0]) * h) / (1 + dot), v[1] + ((n1[1] + n2[1]) * h) / (1 + dot)], p2]);
      else add([v, p1, p2]);
    }
    if (!closed && cap === "round") {
      circle(pts[0]);
      circle(pts[n - 1]);
    }
  }
  return polygon.fill(rings, false);
}
export function prepareFlatSVG(prepared) {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-100000px;top:0;opacity:0;pointer-events:none";
  host.innerHTML = prepared.imageText;
  document.body.append(host);
  try {
    const root = host.querySelector("svg"),
      width = prepared.width,
      height = prepared.height,
      shapes = [];
    const ids = new Map([...root.querySelectorAll("[id]")].map((e) => [e.id, e]));
    function geometry(el, m, rule) {
      const d = shapeD(el);
      return d ? ringsToFill(flatten(d, m, width, height), rule) : [];
    }
    function clipGeometry(clip, targetMatrix) {
      if (clip.getAttribute("clipPathUnits") === "objectBoundingBox")
        throw new Error("Обтравки objectBoundingBox пока не поддерживаются.");
      const t = clip.transform?.baseVal.consolidate()?.matrix;
      let out = [];
      function walk(el, m) {
        const tr = el.transform?.baseVal.consolidate()?.matrix;
        if (tr) m = m.multiply(tr);
        const d = shapeD(el);
        if (d !== null) out = polygon.union(out, geometry(el, m, getComputedStyle(el).clipRule));
        else for (const c of el.children) walk(c, m);
      }
      const m = t ? targetMatrix.multiply(t) : targetMatrix;
      for (const c of clip.children) walk(c, m);
      return out;
    }
    function visit(el, clips = [], opacity = 1, depth = 0) {
      if (depth > 80) throw new Error("Слишком сложная вложенность SVG.");
      const style = getComputedStyle(el);
      if (style.display === "none") return;
      opacity *= Number(style.opacity);
      if (opacity === 0) return;
      if (opacity < 0.999999)
        throw new Error(
          "Для бесшовного SVG нужна непрозрачная заливка. Прозрачный фон и отверстия поддерживаются.",
        );
      const clip = style.clipPath;
      if (clip && clip !== "none") {
        const id = clip.match(/#([^)'" ]+)/)?.[1],
          target = ids.get(id);
        if (!target || target.localName !== "clipPath") throw new Error("Неподдерживаемая обтравка.");
        clips = [...clips, clipGeometry(target, el.getCTM())];
      }
      if (el.localName === "use")
        throw new Error("Раскройте повторяющиеся элементы SVG (use) в обычные контуры.");
      if (["defs", "clipPath", "title", "desc"].includes(el.localName)) return;
      const d = shapeD(el);
      if (d !== null) {
        if (style.visibility !== "visible") return;
        const stroked =
          style.stroke !== "none" && Number(style.strokeOpacity) > 0 && parseFloat(style.strokeWidth) > 0;
        if (style.fill !== "none" && Number(style.fillOpacity) !== 0 && el.localName !== "line") {
          if (Number(style.fillOpacity) < 0.999999 || style.fill.startsWith("rgba"))
            throw new Error("Полупрозрачные заливки пока не поддерживаются.");
          let poly = geometry(el, el.getCTM(), style.fillRule);
          for (const c of clips) poly = polygon.intersection(poly, c);
          if (poly.length) shapes.push({ fill: style.fill, poly });
        }
        if (stroked) {
          // Strokes become filled outlines, painted above the fill like in the source.
          if (Number(style.strokeOpacity) < 0.999999 || style.stroke.startsWith("rgba"))
            throw new Error("Полупрозрачные обводки пока не поддерживаются.");
          if (style.strokeDasharray && style.strokeDasharray !== "none")
            throw new Error("Пунктирные обводки переведите в контуры.");
          if (!/^rgb/.test(style.stroke)) throw new Error("Обводка градиентом не поддерживается.");
          const m = el.getCTM(),
            subpaths = [];
          flatten(strokeD(el), m, 1, 1, subpaths, 0.02);
          const outline = strokeOutline(
            subpaths,
            parseFloat(style.strokeWidth) * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)),
            style.strokeLinejoin,
            style.strokeLinecap,
            parseFloat(style.strokeMiterlimit) || 4,
          );
          let poly = outline.map((p) => p.map((r) => r.map(([x, y]) => [x / width, y / height])));
          for (const c of clips) poly = polygon.intersection(poly, c);
          if (poly.length) shapes.push({ fill: style.stroke, poly });
        }
        if (shapes.length > 1000) throw new Error("Слишком много объектов. Объедините одноцветные фигуры.");
      } else for (const c of el.children) visit(c, clips, opacity, depth + 1);
    }
    visit(root, [
      [
        [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0],
          ],
        ],
      ],
    ]);
    if (!shapes.length) throw new Error("В SVG нет видимых заливок.");
    return shapes;
  } finally {
    host.remove();
  }
}
