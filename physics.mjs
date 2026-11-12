// Fixed-step XPBD cloth. Wind is a force field, not a geometric deformation.
export class Cloth {
  constructor(aspect = 1.6, resolution = 56, edge = "left") {
    this.edge = edge;
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
        this.inv[i] =
          (edge === "left" && x === 0) ||
          (edge === "right" && x === this.nx) ||
          (edge === "top" && y === 0) ||
          (edge === "bottom" && y === this.ny)
            ? 0
            : 1;
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
      for (const i of [a, b, c]) {
        n[i] += nx;
        n[i + 1] += ny;
        n[i + 2] += nz;
      }
    }
    for (let i = 0; i < n.length; i += 3) {
      const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
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
      const len = Math.hypot(nx, ny, nz);
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
        gust = 1 + o.turbulence * 0.22 * Math.sin(t * 1.7 + along * 1.1),
        eddy =
          o.turbulence *
          (Math.sin(phase + Math.sin(across * 2.1 + t * 0.6)) * 0.6 +
            Math.sin(phase * 1.71 + across * 3.4 - t * 0.8) * 0.3 +
            Math.sin(x * 7 + y * 5 + z * 2 - t * 4.3) * 0.1);
      const ux = speed * (wx * gust + dir[1] * eddy * 0.16) - (v[a] + v[b] + v[c]) / 3,
        uy = speed * (wy * gust - dir[0] * eddy * 0.16) - (v[a + 1] + v[b + 1] + v[c + 1]) / 3,
        uz = speed * (wz * gust + eddy * 0.55) - (v[a + 2] + v[b + 2] + v[c + 2]) / 3,
        dot = ux * nx + uy * ny + uz * nz,
        pressure = Math.max(-90, Math.min(90, dot * Math.abs(dot) * 0.75)),
        scale = len / (6 * area) / Math.max(0.25, o.mass);
      for (const i of [a, b, c]) {
        f[i] += (nx * pressure + ux * 0.24) * scale;
        f[i + 1] += (ny * pressure + uy * 0.24) * scale;
        f[i + 2] += (nz * pressure + uz * 0.24) * scale;
      }
    }
    this.old.set(p);
    const damp = Math.exp(-o.damping * h);
    for (let i = 0; i < this.count; i++) {
      const j = i * 3;
      if (!inv[i]) continue;
      v[j] = (v[j] + f[j] * h) * damp;
      v[j + 1] = (v[j + 1] + (f[j + 1] - o.gravity) * h) * damp;
      v[j + 2] = (v[j + 2] + f[j + 2] * h) * damp;
      for (let k = 0; k < 3; k++) p[j + k] += v[j + k] * h;
    }
    this.lambda.fill(0);
    const bend = (0.0000005 + Math.pow(1 - o.stiffness, 3) * 0.00012) / (h * h),
      stretch = 0.000000005 / (h * h);
    for (let iter = 0; iter < 8; iter++)
      for (let q = 0; q < this.links.length; q++) {
        const k = iter % 2 ? this.links.length - 1 - q : q,
          [a, b, l, isBend] = this.links[k],
          w = inv[a] + inv[b];
        if (!w) continue;
        const A = a * 3,
          B = b * 3,
          x = p[B] - p[A],
          y = p[B + 1] - p[A + 1],
          z = p[B + 2] - p[A + 2],
          d = Math.sqrt(x * x + y * y + z * z);
        if (d < 1e-9) continue;
        const alpha = isBend ? bend : stretch,
          dl = (-(d - l) - alpha * this.lambda[k]) / (w + alpha);
        this.lambda[k] += dl;
        const sx = (x / d) * dl,
          sy = (y / d) * dl,
          sz = (z / d) * dl;
        p[A] -= inv[a] * sx;
        p[A + 1] -= inv[a] * sy;
        p[A + 2] -= inv[a] * sz;
        p[B] += inv[b] * sx;
        p[B + 1] += inv[b] * sy;
        p[B + 2] += inv[b] * sz;
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
      for (let k = 0; k < 3; k++) v[j + k] = (p[j + k] - this.old[j + k]) / h;
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
