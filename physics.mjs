// Table sine with linear interpolation (error < 1e-6): the wind field calls it for every triangle.
const SIN_N = 8192,
  SIN_TABLE = Float64Array.from({ length: SIN_N + 1 }, (_, i) => Math.sin((i / SIN_N) * 2 * Math.PI)),
  SIN_K = SIN_N / (2 * Math.PI);
function sin(x) {
  let u = x * SIN_K;
  u -= Math.floor(u / SIN_N) * SIN_N;
  const i = u | 0;
  return SIN_TABLE[i] + (SIN_TABLE[i + 1] - SIN_TABLE[i]) * (u - i);
}
// Fixed-step XPBD cloth. Wind is a force field, not a geometric deformation.
export class Cloth {
  constructor(aspect = 1.6, resolution = 56, edge = "left", pin = "edge") {
    this.edge = edge;
    this.pin = pin;
    this.aspect = aspect;
    // Very long flags get extra cells along the long side so folds stay smooth (unchanged up to 4:1).
    const ratio = Math.max(aspect, 1 / aspect),
      along = resolution * Math.min(3, Math.max(1, Math.sqrt(ratio / 4)));
    this.nx = Math.max(8, Math.round(aspect >= 1 ? along : along * aspect));
    this.ny = Math.max(8, Math.round(aspect >= 1 ? along / aspect : along));
    this.width = 3 * Math.min(1, aspect);
    this.height = 3 * Math.min(1, 1 / aspect);
    const n = (this.nx + 1) * (this.ny + 1);
    this.count = n;
    for (const k of ["p", "old", "rest", "v", "f", "normals"]) this[k] = new Float32Array(n * 3);
    this.uv = new Float32Array(n * 2);
    this.inv = new Float32Array(n);
    const tris = [],
      links = [],
      id = (x, y) => y * (this.nx + 1) + x;
    const link = (a, b, bend) => {
      let d = 0;
      for (let k = 0; k < 3; k++) d += (this.rest[a * 3 + k] - this.rest[b * 3 + k]) ** 2;
      links.push([a, b, Math.sqrt(d), bend]);
    };
    for (let y = 0; y <= this.ny; y++)
      for (let x = 0; x <= this.nx; x++) {
        let i = id(x, y);
        this.rest[i * 3] = (x / this.nx - 0.5) * this.width;
        this.rest[i * 3 + 1] = (0.5 - y / this.ny) * this.height;
        this.uv[i * 2] = x / this.nx;
        this.uv[i * 2 + 1] = y / this.ny;
        // pin: whole edge, its two corners, or its middle point.
        const onEdge =
            (edge === "left" && x === 0) ||
            (edge === "right" && x === this.nx) ||
            (edge === "top" && y === 0) ||
            (edge === "bottom" && y === this.ny),
          vertical = edge === "left" || edge === "right",
          t = vertical ? y : x,
          n = vertical ? this.ny : this.nx,
          picked = pin === "corners" ? t === 0 || t === n : pin === "point" ? t === Math.round(n / 2) : true;
        this.inv[i] = onEdge && picked ? 0 : 1;
      }
    for (let y = 0; y <= this.ny; y++)
      for (let x = 0; x <= this.nx; x++) {
        const a = id(x, y);
        if (x < this.nx) link(a, id(x + 1, y), 0);
        if (y < this.ny) link(a, id(x, y + 1), 0);
        if (x < this.nx && y < this.ny) {
          const b = id(x + 1, y),
            c = id(x, y + 1),
            d = id(x + 1, y + 1);
          link(a, d, 0);
          link(b, c, 0);
          tris.push(a, c, b, b, c, d);
        }
        if (x + 2 <= this.nx) link(a, id(x + 2, y), 1);
        if (y + 2 <= this.ny) link(a, id(x, y + 2), 1);
      }
    this.tri = new Uint16Array(tris);
    this.links = links;
    // Flat typed copies of the constraints for the solver's hot loop.
    this.linkA = Uint32Array.from(links, (l) => l[0] * 3);
    this.linkB = Uint32Array.from(links, (l) => l[1] * 3);
    this.linkLength = Float64Array.from(links, (l) => l[2]);
    this.linkBend = Uint8Array.from(links, (l) => l[3]);
    this.linkW = Float32Array.from(links, (l) => this.inv[l[0]] + this.inv[l[1]]);
    this.inv3A = Float32Array.from(links, (l) => this.inv[l[0]]);
    this.inv3B = Float32Array.from(links, (l) => this.inv[l[1]]);
    this.lambda = new Float32Array(links.length);
    this.reset();
  }
  reset() {
    this.p.set(this.rest);
    this.v.fill(0);
    this.time = 0;
    for (let i = 0; i < this.count; i++) if (this.inv[i]) this.p[i * 3 + 2] = 0.003 * Math.sin(i * 12.9898);
    this.computeNormals();
  }
  computeNormals() {
    const n = this.normals,
      p = this.p;
    n.fill(0);
    for (let k = 0; k < this.tri.length; k += 3) {
      const a = this.tri[k] * 3,
        b = this.tri[k + 1] * 3,
        c = this.tri[k + 2] * 3,
        x = p[b] - p[a],
        y = p[b + 1] - p[a + 1],
        z = p[b + 2] - p[a + 2],
        X = p[c] - p[a],
        Y = p[c + 1] - p[a + 1],
        Z = p[c + 2] - p[a + 2];
      const nx = y * Z - z * Y,
        ny = z * X - x * Z,
        nz = x * Y - y * X;
      n[a] += nx;
      n[a + 1] += ny;
      n[a + 2] += nz;
      n[b] += nx;
      n[b + 1] += ny;
      n[b + 2] += nz;
      n[c] += nx;
      n[c + 1] += ny;
      n[c + 2] += nz;
    }
    for (let i = 0; i < n.length; i += 3) {
      const l = Math.sqrt(n[i] * n[i] + n[i + 1] * n[i + 1] + n[i + 2] * n[i + 2]) || 1;
      n[i] /= l;
      n[i + 1] /= l;
      n[i + 2] /= l;
    }
  }
  step(o, dt = 1 / 60) {
    for (let s = 0; s < 3; s++) this.substep(o, dt / 3);
    this.computeNormals();
  }
  substep(o, h) {
    this.time += h;
    const p = this.p,
      v = this.v,
      f = this.f,
      inv = this.inv;
    f.fill(0);
    const dir = { left: [1, 0], right: [-1, 0], top: [0, -1], bottom: [0, 1] }[o.wind] || [1, 0],
      speed = o.strength,
      t = this.time + (o.phase || 0),
      angle = ((o.angle || 0) * Math.PI) / 180,
      wx = dir[0] * Math.cos(angle),
      wy = dir[1] * Math.cos(angle),
      wz = Math.sin(angle),
      area = (this.width * this.height) / (this.nx * this.ny);
    for (let k = 0; k < this.tri.length; k += 3) {
      const a = this.tri[k] * 3,
        b = this.tri[k + 1] * 3,
        c = this.tri[k + 2] * 3,
        ex = p[b] - p[a],
        ey = p[b + 1] - p[a + 1],
        ez = p[b + 2] - p[a + 2],
        fx = p[c] - p[a],
        fy = p[c + 1] - p[a + 1],
        fz = p[c + 2] - p[a + 2];
      let nx = ey * fz - ez * fy,
        ny = ez * fx - ex * fz,
        nz = ex * fy - ey * fx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len < 1e-9) continue;
      nx /= len;
      ny /= len;
      nz /= len;
      const x = (p[a] + p[b] + p[c]) / 3,
        y = (p[a + 1] + p[b + 1] + p[c + 1]) / 3,
        z = (p[a + 2] + p[b + 2] + p[c + 2]) / 3,
        along = x * dir[0] + y * dir[1],
        across = x * dir[1] - y * dir[0],
        phase = along * 2.8 - t * (1.4 + speed * 0.35),
        gust = 1 + o.turbulence * 0.22 * sin(t * 1.7 + along * 1.1),
        eddy =
          o.turbulence *
          (sin(phase + sin(across * 2.1 + t * 0.6)) * 0.6 +
            sin(phase * 1.71 + across * 3.4 - t * 0.8) * 0.3 +
            sin(x * 7 + y * 5 + z * 2 - t * 4.3) * 0.1);
      const ux = speed * (wx * gust + dir[1] * eddy * 0.16) - (v[a] + v[b] + v[c]) / 3,
        uy = speed * (wy * gust - dir[0] * eddy * 0.16) - (v[a + 1] + v[b + 1] + v[c + 1]) / 3,
        uz = speed * (wz * gust + eddy * 0.55) - (v[a + 2] + v[b + 2] + v[c + 2]) / 3,
        dot = ux * nx + uy * ny + uz * nz,
        pressure = Math.max(-90, Math.min(90, dot * Math.abs(dot) * 0.75)),
        scale = len / (6 * area) / Math.max(0.25, o.mass);
      const gx = (nx * pressure + ux * 0.24) * scale,
        gy = (ny * pressure + uy * 0.24) * scale,
        gz = (nz * pressure + uz * 0.24) * scale;
      f[a] += gx;
      f[a + 1] += gy;
      f[a + 2] += gz;
      f[b] += gx;
      f[b + 1] += gy;
      f[b + 2] += gz;
      f[c] += gx;
      f[c + 1] += gy;
      f[c + 2] += gz;
    }
    const old = this.old;
    old.set(p);
    const damp = Math.exp(-o.damping * h);
    for (let i = 0; i < this.count; i++) {
      const j = i * 3;
      if (!inv[i]) continue;
      v[j] = (v[j] + f[j] * h) * damp;
      v[j + 1] = (v[j + 1] + (f[j + 1] - o.gravity) * h) * damp;
      v[j + 2] = (v[j + 2] + f[j + 2] * h) * damp;
      p[j] += v[j] * h;
      p[j + 1] += v[j + 1] * h;
      p[j + 2] += v[j + 2] * h;
    }
    this.lambda.fill(0);
    const bend = (0.0000005 + Math.pow(1 - o.stiffness, 3) * 0.00012) / (h * h),
      stretch = 0.000000005 / (h * h);
    const LA = this.linkA,
      LB = this.linkB,
      LL = this.linkLength,
      LBend = this.linkBend,
      LW = this.linkW,
      IA = this.inv3A,
      IB = this.inv3B,
      lambda = this.lambda,
      count = LA.length;
    for (let iter = 0; iter < 8; iter++)
      for (let q = 0; q < count; q++) {
        const k = iter % 2 ? count - 1 - q : q,
          w = LW[k];
        if (!w) continue;
        const A = LA[k],
          B = LB[k],
          x = p[B] - p[A],
          y = p[B + 1] - p[A + 1],
          z = p[B + 2] - p[A + 2],
          d = Math.sqrt(x * x + y * y + z * z);
        if (d < 1e-9) continue;
        const alpha = LBend[k] ? bend : stretch,
          dl = (-(d - LL[k]) - alpha * lambda[k]) / (w + alpha);
        lambda[k] += dl;
        const sx = (x / d) * dl,
          sy = (y / d) * dl,
          sz = (z / d) * dl,
          ia = IA[k],
          ib = IB[k];
        p[A] -= ia * sx;
        p[A + 1] -= ia * sy;
        p[A + 2] -= ia * sz;
        p[B] += ib * sx;
        p[B + 1] += ib * sy;
        p[B + 2] += ib * sz;
      }
    if (o.collision) this.collide();
    for (let i = 0; i < this.count; i++) {
      const j = i * 3;
      if (!inv[i]) {
        p[j] = this.rest[j];
        p[j + 1] = this.rest[j + 1];
        p[j + 2] = 0;
        v[j] = v[j + 1] = v[j + 2] = 0;
        continue;
      }
      v[j] = (p[j] - old[j]) / h;
      v[j + 1] = (p[j + 1] - old[j + 1]) / h;
      v[j + 2] = (p[j + 2] - old[j + 2]) / h;
    }
  }
  collide() {
    const d = Math.min(this.width / this.nx, this.height / this.ny) * 0.65,
      d2 = d * d,
      p = this.p,
      hash = new Map();
    for (let i = 0; i < this.count; i++) {
      const j = i * 3,
        x = Math.floor(p[j] / d),
        y = Math.floor(p[j + 1] / d),
        z = Math.floor(p[j + 2] / d);
      for (let X = x - 1; X <= x + 1; X++)
        for (let Y = y - 1; Y <= y + 1; Y++)
          for (let Z = z - 1; Z <= z + 1; Z++) {
            const bucket = hash.get(X + "," + Y + "," + Z);
            if (!bucket) continue;
            for (const b of bucket) {
              if (
                Math.abs((i % (this.nx + 1)) - (b % (this.nx + 1))) <= 2 &&
                Math.abs(Math.floor(i / (this.nx + 1)) - Math.floor(b / (this.nx + 1))) <= 2
              )
                continue;
              const B = b * 3,
                dx = p[j] - p[B],
                dy = p[j + 1] - p[B + 1],
                dz = p[j + 2] - p[B + 2],
                r2 = dx * dx + dy * dy + dz * dz,
                w = this.inv[i] + this.inv[b];
              if (r2 >= d2 || r2 < 1e-12 || !w) continue;
              const r = Math.sqrt(r2),
                s = (d - r) / r / w;
              for (let k = 0; k < 3; k++) {
                const c = [dx, dy, dz][k] * s;
                p[j + k] += c * this.inv[i];
                p[B + k] -= c * this.inv[b];
              }
            }
          }
      const key = x + "," + y + "," + z;
      if (!hash.has(key)) hash.set(key, []);
      hash.get(key).push(i);
    }
  }
}
