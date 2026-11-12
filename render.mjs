import { projectFlagInto } from "./scene.mjs";
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = (this.gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
    }));
    if (!gl)
      throw new Error(
        "WebGL недоступен: живое превью и PNG отключены. SVG-композицию можно собрать по координатам и экспортировать.",
      );
    const shader = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = (this.program = gl.createProgram());
    gl.attachShader(
      p,
      shader(
        gl.VERTEX_SHADER,
        `attribute vec3 position;attribute vec3 normal;attribute vec2 uv;uniform float depthSpan;uniform float depthCenter;varying vec2 texcoord;varying vec3 n;void main(){gl_Position=vec4(position.xy,-(position.z-depthCenter)/depthSpan,1.);texcoord=uv;n=normal;}`,
      ),
    );
    gl.attachShader(
      p,
      shader(
        gl.FRAGMENT_SHADER,
        `precision mediump float;uniform sampler2D artwork;uniform float shade;uniform float wire;varying vec2 texcoord;varying vec3 n;void main(){vec4 c=texture2D(artwork,texcoord);if(c.a<.015)discard;float light=mix(1.,.65+.35*abs(dot(normalize(n),normalize(vec3(-.3,.5,1.)))),shade);gl_FragColor=wire>.5?vec4(.72,.85,.5,.55):vec4(c.rgb*light*c.a,c.a);}`,
      ),
    );
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.attrib = {};
    for (const n of ["position", "normal", "uv"]) this.attrib[n] = gl.getAttribLocation(p, n);
    this.uniform = {};
    for (const n of ["depthSpan", "depthCenter", "shade", "wire", "artwork"]) this.uniform[n] = gl.getUniformLocation(p, n);
    this.textures = new Map();
    this.meshes = new Map();
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);
  }
  texture(img) {
    const video = img.tagName === "VIDEO",
      gl = this.gl;
    let entry = this.textures.get(img);
    if (entry && !video) return entry.texture;
    if (!entry) {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER])
        gl.texParameteri(gl.TEXTURE_2D, p, gl.LINEAR);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T])
        gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
      entry = { texture, scaled: null };
      const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      if (img.width > max || img.height > max) {
        entry.scaled = document.createElement("canvas");
        const scale = max / Math.max(img.width, img.height);
        entry.scaled.width = Math.max(1, Math.round(img.width * scale));
        entry.scaled.height = Math.max(1, Math.round(img.height * scale));
      }
      this.textures.set(img, entry);
    }
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    if (video && img.readyState < 2) return entry.texture;
    let source = img;
    if (entry.scaled) {
      source = entry.scaled;
      source.getContext("2d").drawImage(img, 0, 0, source.width, source.height);
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    return entry.texture;
  }
  mesh(c) {
    if (this.meshes.has(c)) return this.meshes.get(c);
    const gl = this.gl,
      b = {};
    for (const n of ["position", "normal", "uv", "tri", "lines"]) b[n] = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b.uv);
    gl.bufferData(gl.ARRAY_BUFFER, c.uv, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.tri);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, c.tri, gl.STATIC_DRAW);
    const lines = [];
    for (const [a, d, , bend] of c.links)
      if (
        !bend &&
        (a % (c.nx + 1) === d % (c.nx + 1) || Math.floor(a / (c.nx + 1)) === Math.floor(d / (c.nx + 1)))
      )
        lines.push(a, d);
    b.lineCount = lines.length;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.lines);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(lines), gl.STATIC_DRAW);
    this.meshes.set(c, b);
    return b;
  }
  prune(flags) {
    const meshes = new Set(flags.map((f) => f.cloth)),
      images = new Set(flags.map((f) => f.image)),
      gl = this.gl;
    for (const [c, b] of this.meshes)
      if (!meshes.has(c)) {
        for (const n of ["position", "normal", "uv", "tri", "lines"]) gl.deleteBuffer(b[n]);
        this.meshes.delete(c);
      }
    for (const [img, t] of this.textures)
      if (!images.has(img)) {
        gl.deleteTexture(t.texture);
        this.textures.delete(img);
      }
  }
  checkSize(w, h) {
    const gl = this.gl,
      max = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    if (w > max || h > max || w > vp[0] || h > vp[1] || w * h > 32e6)
      throw new Error(
        "Этот размер слишком велик для растрового экспорта на устройстве. Уменьшите размер PNG или экспортируйте SVG.",
      );
  }
  draw(flags, o, width, height, exporting = false) {
    const gl = this.gl,
      c = this.canvas;
    this.prune(flags);
    if (exporting) this.checkSize(width, height);
    if (c.width !== width || c.height !== height) {
      c.width = width;
      c.height = height;
    }
    if (exporting && (gl.drawingBufferWidth !== width || gl.drawingBufferHeight !== height))
      throw new Error("Браузер не смог создать буфер нужного размера. Используйте SVG или уменьшите PNG.");
    gl.viewport(0, 0, width, height);
    if (o.background === "transparent") gl.clearColor(0, 0, 0, 0);
    else gl.clearColor(...[1, 3, 5].map((i) => parseInt(o.background.slice(i, i + 2), 16) / 255), 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.program);
    // Layers are painted strictly in array order (back to front). Depth is tested only inside
    // one flag, so its own folds overlap correctly while different flags never intersect.
    const visible = flags
      .filter((f) => f.visible)
      .map((f) => {
        const b = this.mesh(f.cloth);
        if (!b.points) b.points = new Float32Array(f.cloth.p.length);
        return { f, points: b.points, range: projectFlagInto(f, o, b.points) };
      });
    const depthRange = ([lo, hi]) => {
      gl.uniform1f(this.uniform.depthCenter, (lo + hi) / 2);
      gl.uniform1f(this.uniform.depthSpan, Math.max(1e-6, ((hi - lo) / 2) * 1.02));
      gl.clear(gl.DEPTH_BUFFER_BIT);
    };
    gl.uniform1f(this.uniform.shade, o.shade ? 1 : 0);
    gl.uniform1i(this.uniform.artwork, 0);
    for (const { f, points, range } of visible) {
      const b = this.mesh(f.cloth);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture(f.image));
      for (const [n, data, size] of [
        ["position", points, 3],
        ["normal", f.cloth.normals, 3],
        ["uv", null, 2],
      ]) {
        gl.bindBuffer(gl.ARRAY_BUFFER, b[n]);
        if (data) gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(this.attrib[n]);
        gl.vertexAttribPointer(this.attrib[n], size, gl.FLOAT, false, 0, 0);
      }
      gl.uniform1f(this.uniform.wire, 0);
      depthRange(range);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.tri);
      gl.drawElements(gl.TRIANGLES, f.cloth.tri.length, gl.UNSIGNED_SHORT, 0);
    }
    if (o.wire && !exporting) {
      gl.uniform1f(this.uniform.wire, 1);
      for (const { f, points, range } of visible) {
        const b = this.mesh(f.cloth);
        gl.bindTexture(gl.TEXTURE_2D, this.texture(f.image));
        for (const [n, data, size] of [
          ["position", points, 3],
          ["normal", f.cloth.normals, 3],
          ["uv", null, 2],
        ]) {
          gl.bindBuffer(gl.ARRAY_BUFFER, b[n]);
          if (data) gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
          gl.vertexAttribPointer(this.attrib[n], size, gl.FLOAT, false, 0, 0);
        }
        depthRange(range);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.lines);
        gl.drawElements(gl.LINES, b.lineCount, gl.UNSIGNED_SHORT, 0);
      }
    }
  }
}
