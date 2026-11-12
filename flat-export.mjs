import { projectFlag } from "./scene.mjs";
import { polygon } from "./vendor.mjs";
import { projectCloth, affine, orderPolygons } from "./vector.mjs";
const snap = (x) => Math.round(x * 1e9) / 1e9;
const bbox = (poly) => {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of poly)
    for (const r of p)
      for (const [x, y] of r) {
        b[0] = Math.min(b[0], x);
        b[1] = Math.min(b[1], y);
        b[2] = Math.max(b[2], x);
        b[3] = Math.max(b[3], y);
      }
  return b;
};
const overlap = (a, b) =>
  a[0] < b[2] - 1e-10 && a[2] > b[0] + 1e-10 && a[1] < b[3] - 1e-10 && a[3] > b[1] + 1e-10;
// Interleaves the bits of two 16-bit coordinates (Morton order).
const morton = (x, y) => {
  let m = 0;
  for (let i = 0; i < 16; i++) m += ((x >> i) & 1) * 2 ** (2 * i) + ((y >> i) & 1) * 2 ** (2 * i + 1);
  return m;
};
// Balanced union. Pieces are visited in Morton order first, so each batch covers one small area:
// the clipper then has far fewer edges in play than with pieces scattered over the whole canvas.
const unionAll = (items) => {
  if (items.length < 2) return items[0] || [];
  const code = (poly) => {
    const b = bbox(poly);
    return morton(
      Math.max(0, Math.min(65535, Math.round(((b[0] + b[2]) / 2 + 1) * 16384))),
      Math.max(0, Math.min(65535, Math.round(((b[1] + b[3]) / 2 + 1) * 16384))),
    );
  };
  items = items
    .map((poly) => ({ poly, code: code(poly) }))
    .sort((a, b) => a.code - b.code)
    .map((x) => x.poly);
  while (items.length > 1) {
    const next = [];
    for (let i = 0; i < items.length; i += 16) next.push(polygon.union(...items.slice(i, i + 16)));
    items = next;
  }
  return items[0];
};
// Douglas–Peucker on a closed ring (px). Keeps at least a triangle.
function simplifyRing(pts, tolerance) {
  if (pts.length < 5) return pts;
  const keep = new Uint8Array(pts.length);
  let far = 0,
    best = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
    if (d > best) {
      best = d;
      far = i;
    }
  }
  keep[0] = keep[far] = keep[pts.length - 1] = 1;
  const stack = [
    [0, far],
    [far, pts.length - 1],
  ];
  while (stack.length) {
    const [a, b] = stack.pop(),
      ax = pts[a][0],
      ay = pts[a][1],
      dx = pts[b][0] - ax,
      dy = pts[b][1] - ay,
      len = Math.hypot(dx, dy);
    let index = -1,
      max = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = len
        ? Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len
        : Math.hypot(pts[i][0] - ax, pts[i][1] - ay);
      if (d > max) {
        max = d;
        index = i;
      }
    }
    if (index > 0) {
      keep[index] = 1;
      stack.push([a, index], [index, b]);
    }
  }
  const out = pts.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : pts;
}
function ringsPath(poly, width, height, tolerance = 0) {
  const n = (x) => Number(x.toFixed(tolerance ? 2 : 5));
  let d = "";
  for (const p of poly)
    for (const r of p) {
      let pts = r.map(([x, y]) => [((x + 1) * width) / 2, ((1 - y) * height) / 2]);
      if (tolerance) pts = simplifyRing(pts, tolerance);
      d +=
        "M" +
        pts
          .slice(0, -1)
          .map(([x, y]) => n(x) + " " + n(y))
          .join("L") +
        "Z";
    }
  return d;
}
export function exportFlatSVG(cloth, o, shapes, onProgress = () => {}) {
  return exportProjectedSVG([{ cloth, points: projectCloth(cloth, o), shapes }], o, onProgress);
}
export function exportSceneSVG(flags, o, onProgress = () => {}) {
  if (!flags.length) throw new Error("Добавьте хотя бы один видимый флаг.");
  if (flags.some((f) => !f.shapes))
    throw new Error(
      "Для SVG все видимые флаги должны быть векторными. Скройте растровые объекты или выберите PNG.",
    );
  return exportProjectedSVG(
    flags.map((f) => ({ cloth: f.cloth, points: projectFlag(f, o), shapes: f.shapes, name: f.name })),
    o,
    onProgress,
  );
}
// Marks the cells of a uniform grid over UV space that any contour edge passes through, so a
// triangle landing in clear cells is known to be wholly inside or wholly outside the region —
// no clipping needed. G x G cells over [0,1]^2.
const G = 96;
function edgeGrid(poly) {
  const hit = new Uint8Array(G * G),
    cell = (v) => Math.max(0, Math.min(G - 1, Math.floor(v * G)));
  for (const p of poly)
    for (const r of p)
      for (let i = 0; i < r.length - 1; i++) {
        const x0 = cell(Math.min(r[i][0], r[i + 1][0])),
          x1 = cell(Math.max(r[i][0], r[i + 1][0])),
          y0 = cell(Math.min(r[i][1], r[i + 1][1])),
          y1 = cell(Math.max(r[i][1], r[i + 1][1]));
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) hit[x * G + y] = 1;
      }
  return hit;
}
function gridClear(hit, box) {
  const cell = (v) => Math.max(0, Math.min(G - 1, Math.floor(v * G))),
    x1 = cell(box[2]),
    y1 = cell(box[3]);
  for (let x = cell(box[0]); x <= x1; x++) for (let y = cell(box[1]); y <= y1; y++) if (hit[x * G + y]) return false;
  return true;
}
function pointInPoly(poly, x, y) {
  let inside = false;
  for (const p of poly)
    for (const r of p)
      for (let i = 0; i < r.length - 1; i++) {
        const a = r[i],
          b = r[i + 1];
        if (a[1] > y !== b[1] > y && x < a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0])) inside = !inside;
      }
  return inside;
}
function exportProjectedSVG(items, o, onProgress) {
  const faces = [],
    maps = [],
    regionCache = new Map(),
    layers = [];
  for (const { cloth, points: pts, shapes } of items) {
    const layer = [];
    layers.push(layer);
    let regions = regionCache.get(shapes);
    if (!regions) {
      regions = [];
      let sourceCover = [];
      for (const s of [...shapes].reverse()) {
        const poly = polygon.difference(s.poly, sourceCover);
        if (poly.length) regions.push({ fill: s.fill, poly, box: bbox(poly), edges: edgeGrid(poly) });
        sourceCover = polygon.union(sourceCover, s.poly);
      }
      regionCache.set(shapes, regions);
    }
    for (let i = 0; i < cloth.tri.length; i += 3) {
      const ids = Array.from(cloth.tri.slice(i, i + 3)),
        v = ids.map((id) => pts[id]);
      const area = (v[1][0] - v[0][0]) * (v[2][1] - v[0][1]) - (v[1][1] - v[0][1]) * (v[2][0] - v[0][0]);
      if (Math.abs(area) < 1e-12) continue;
      const uv = ids.map((id) => [cloth.uv[id * 2], cloth.uv[id * 2 + 1]]),
        id = maps.length;
      maps.push({ uv, m: affine(uv, v), regions });
      faces.push({ id, v });
      layer.push(faces[faces.length - 1]);
    }
  }
  if (faces.length > 250000) throw new Error("Слишком подробная сцена. Уменьшите детализацию флагов.");
  onProgress("Рассчитываю перекрытия складок…");
  // layered: items are strict back-to-front layers, processed front to back. Inside a layer,
  // folds are depth-sorted (BSP) and cut triangle by triangle; between layers a whole layer is
  // cut once per colour by the merged silhouette of the layers in front of it.
  const groups = o.layered ? layers.slice().reverse() : [faces],
    cache = new Map(),
    colors = new Map(),
    total = faces.length,
    separate = !!(o.layered && o.separate),
    perLayer = [];
  let operations = 0,
    done = 0,
    fragments = 0,
    cover = [];
  // Convex rings overlap with positive area? (separating-axis test; touching edges do not count)
  function convexOverlap(a, b) {
    for (const [p, q] of [
      [a, b],
      [b, a],
    ])
      for (let i = 0; i < p.length - 1; i++) {
        const nx = p[i + 1][1] - p[i][1],
          ny = p[i][0] - p[i + 1][0],
          len = Math.hypot(nx, ny);
        if (len < 1e-14) continue;
        let p0 = Infinity,
          p1 = -Infinity,
          q0 = Infinity,
          q1 = -Infinity;
        for (let k = 0; k < p.length - 1; k++) {
          const d = (p[k][0] * nx + p[k][1] * ny) / len;
          p0 = Math.min(p0, d);
          p1 = Math.max(p1, d);
        }
        for (let k = 0; k < q.length - 1; k++) {
          const d = (q[k][0] * nx + q[k][1] * ny) / len;
          q0 = Math.min(q0, d);
          q1 = Math.max(q1, d);
        }
        if (p1 <= q0 + 1e-9 || q1 <= p0 + 1e-9) return false;
      }
    return true;
  }
  function cells(b) {
    const keys = [];
    const x0 = Math.max(0, Math.min(63, Math.floor((b[0] + 1) * 32))),
      x1 = Math.max(0, Math.min(63, Math.floor((b[2] + 1) * 32))),
      y0 = Math.max(0, Math.min(63, Math.floor((b[1] + 1) * 32))),
      y1 = Math.max(0, Math.min(63, Math.floor((b[3] + 1) * 32)));
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) keys.push(x * 64 + y);
    return keys;
  }
  for (let g = 0; g < groups.length; g++) {
    const ordered = orderPolygons(groups[g]).reverse(),
      grid = new Map(),
      pieces = [],
      layerColors = new Map();
    fragments += ordered.length;
    for (const face of ordered) {
      if (done++ % 300 === 0)
        onProgress(`Собираю видимые контуры: ${Math.min(99, Math.round((done / total) * 100))}%`);
      let ring = face.v.map((v) => [snap(v[0]), snap(v[1])]);
      ring.push(ring[0]);
      const clip = [[ring]],
        clipBox = bbox(clip);
      if (clipBox[0] >= 1 || clipBox[2] <= -1 || clipBox[1] >= 1 || clipBox[3] <= -1) continue;
      let mapped = cache.get(face.id);
      if (!mapped) {
        const { uv, m, regions } = maps[face.id],
          tri = [[[...uv, uv[0]]]],
          box = bbox(tri),
          project = (cut) =>
            cut.map((p) =>
              p.map((r) =>
                r.map(([x, y]) => [snap(m[0] * x + m[2] * y + m[4]), snap(m[1] * x + m[3] * y + m[5])]),
              ),
            );
        mapped = [];
        for (const region of regions) {
          if (!overlap(box, region.box)) continue;
          // Triangle in clear grid cells: wholly inside this colour, or wholly outside it.
          if (gridClear(region.edges, box)) {
            if (pointInPoly(region.poly, (uv[0][0] + uv[1][0] + uv[2][0]) / 3, (uv[0][1] + uv[1][1] + uv[2][1]) / 3)) {
              mapped.push({ fill: region.fill, poly: project(tri) });
              break;
            }
            continue;
          }
          const cut = polygon.intersection(region.poly, tri);
          if (!cut.length) continue;
          mapped.push({ fill: region.fill, poly: project(cut) });
        }
        cache.set(face.id, mapped);
      }
      // Earlier (nearer) pieces of this layer that really overlap this face.
      const keys = cells(clipBox),
        candidates = new Set();
      for (const key of keys) for (const id of grid.get(key) || []) candidates.add(id);
      const blockers = [];
      for (const id of candidates) {
        const item = pieces[id];
        if (item.face !== face.id && overlap(clipBox, item.box) && convexOverlap(ring, item.ring))
          blockers.push(item.poly);
      }
      const inside = clipBox[0] >= -1 && clipBox[2] <= 1 && clipBox[1] >= -1 && clipBox[3] <= 1;
      for (const region of mapped) {
        let visible = inside
          ? polygon.intersection(region.poly, clip)
          : polygon.intersection(region.poly, clip, [
              [
                [
                  [-1, -1],
                  [1, -1],
                  [1, 1],
                  [-1, 1],
                  [-1, -1],
                ],
              ],
            ]);
        if (!visible.length) continue;
        if (blockers.length) {
          if ((operations += blockers.length) > 4000000)
            throw new Error("Слишком сложные перекрытия. Выберите меньшую детализацию или другой кадр.");
          visible = polygon.difference(visible, ...blockers);
          if (!visible.length) continue;
        }
        const id = pieces.length;
        pieces.push({ face: face.id, box: bbox(visible), poly: visible, ring });
        for (const key of keys) {
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(id);
        }
        if (!layerColors.has(region.fill)) layerColors.set(region.fill, []);
        layerColors.get(region.fill).push(visible);
      }
    }
    const merged = [...layerColors].map(([fill, polys]) => [fill, unionAll(polys)]);
    // separate: every flag is exported whole in its own group, so it can be moved in Figma.
    if (separate) {
      perLayer.unshift({ name: items[items.length - 1 - g].name, merged });
      continue;
    }
    for (const [fill, poly] of merged) {
      const visible = cover.length ? polygon.difference(poly, cover) : poly;
      if (!visible.length) continue;
      if (!colors.has(fill)) colors.set(fill, []);
      colors.get(fill).push(visible);
    }
    if (g < groups.length - 1 && merged.length)
      cover = polygon.union(cover, ...merged.map(([, poly]) => poly));
  }
  onProgress("Объединяю одноцветные участки…");
  const tolerance = +o.simplify || 0,
    esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  let body = "",
    paths = 0,
    points = 0;
  const emit = (fill, poly) => {
    const d = ringsPath(poly, o.width, o.height, tolerance);
    paths++;
    points += d.split("L").length;
    return `<path fill="${fill}" fill-rule="evenodd" d="${d}"/>`;
  };
  // A silhouette in the first colour sits under each set of paths and hides hairline seams.
  const paint = (merged) => {
    const silhouette = unionAll(merged.map((x) => x.poly));
    let out = silhouette.length && merged.length > 1 ? emit(merged[0].fill, silhouette) : "";
    for (const { fill, poly } of merged) out += emit(fill, poly);
    return out;
  };
  if (separate)
    for (const layer of perLayer) {
      const merged = layer.merged.map(([fill, poly]) => ({ fill, poly })).filter((x) => x.poly.length);
      if (merged.length) body += `<g id="${esc(layer.name)}">${paint(merged)}</g>`;
    }
  else body = paint([...colors].map(([fill, polys]) => ({ fill, poly: unionAll(polys) })));
  const bg =
    o.background === "transparent" ? "" : `<rect width="100%" height="100%" fill="${o.background}"/>`;
  return {
    text: `<svg xmlns="http://www.w3.org/2000/svg" width="${o.width}" height="${o.height}" viewBox="0 0 ${o.width} ${o.height}"><title>Cloth — vector composition</title><desc>Flat vector contours from simulated cloth. Curves adaptively approximated before deformation. No raster, clipping masks or filters.</desc>${bg}${body}</svg>`,
    triangles: faces.length,
    fragments,
    paths,
    points,
  };
}
