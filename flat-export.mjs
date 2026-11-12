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
const unionAll = (items) => {
  if (!items.length) return [];
  while (items.length > 1) {
    const next = [];
    for (let i = 0; i < items.length; i += 16) next.push(polygon.union(...items.slice(i, i + 16)));
    items = next;
  }
  return items[0];
};
function ringsPath(poly, width, height) {
  const n = (x) => Number(x.toFixed(5));
  return poly
    .map((p) =>
      p
        .map(
          (r) =>
            "M" +
            r
              .slice(0, -1)
              .map(([x, y]) => n(((x + 1) * width) / 2) + " " + n(((1 - y) * height) / 2))
              .join("L") +
            "Z",
        )
        .join(""),
    )
    .join("");
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
    flags.map((f) => ({ cloth: f.cloth, points: projectFlag(f, o), shapes: f.shapes })),
    o,
    onProgress,
  );
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
        if (poly.length) regions.push({ fill: s.fill, poly, box: bbox(poly) });
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
    total = faces.length;
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
          box = bbox(tri);
        mapped = [];
        for (const region of regions) {
          if (!overlap(box, region.box)) continue;
          const cut = polygon.intersection(region.poly, tri);
          if (!cut.length) continue;
          const poly = cut.map((p) =>
            p.map((r) =>
              r.map(([x, y]) => [snap(m[0] * x + m[2] * y + m[4]), snap(m[1] * x + m[3] * y + m[5])]),
            ),
          );
          mapped.push({ fill: region.fill, poly });
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
  const merged = [...colors].map(([fill, polys]) => ({ fill, poly: unionAll(polys) }));
  const silhouette = unionAll(merged.map((x) => x.poly));
  let body = "";
  if (silhouette.length && merged.length)
    body += `<path fill="${merged[0].fill}" fill-rule="evenodd" d="${ringsPath(silhouette, o.width, o.height)}"/>`;
  for (const { fill, poly } of merged)
    body += `<path fill="${fill}" fill-rule="evenodd" d="${ringsPath(poly, o.width, o.height)}"/>`;
  const bg =
    o.background === "transparent" ? "" : `<rect width="100%" height="100%" fill="${o.background}"/>`;
  return {
    text: `<svg xmlns="http://www.w3.org/2000/svg" width="${o.width}" height="${o.height}" viewBox="0 0 ${o.width} ${o.height}"><title>Cloth — vector composition</title><desc>Flat vector contours from simulated cloth. Curves adaptively approximated before deformation. No raster, clipping masks or filters.</desc>${bg}${body}</svg>`,
    triangles: faces.length,
    fragments,
    paths: merged.length + 1,
  };
}
