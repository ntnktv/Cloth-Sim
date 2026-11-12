// Stateless cloth stepping: the page stays the source of truth and sends positions and
// velocities with every request; the worker only caches the mesh topology per flag.
import { Cloth } from "./physics.mjs";
const cache = new Map();
self.onmessage = ({ data }) => {
  const out = [],
    transfer = [];
  for (const job of data.jobs) {
    let entry = cache.get(job.id);
    if (!entry || entry.key !== job.key) {
      entry = { key: job.key, cloth: new Cloth(...job.params) };
      cache.set(job.id, entry);
    }
    const c = entry.cloth;
    if (c.p.length !== job.p.length) continue;
    c.p.set(job.p);
    c.v.set(job.v);
    c.time = job.time;
    for (let i = 0; i < data.steps; i++) c.step(job.options, data.dt);
    job.p.set(c.p);
    job.v.set(c.v);
    const normals = c.normals.slice();
    out.push({ id: job.id, p: job.p, v: job.v, normals, time: c.time });
    transfer.push(job.p.buffer, job.v.buffer, normals.buffer);
  }
  for (const id of cache.keys()) if (!data.alive.includes(id)) cache.delete(id);
  self.postMessage({ seq: data.seq, out }, transfer);
};
