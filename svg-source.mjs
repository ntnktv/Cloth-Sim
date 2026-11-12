const NS = "http://www.w3.org/2000/svg";
// A deliberately bounded, portable SVG subset. Unsupported inputs still work as raster previews.
export function prepareSVG(text) {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml"),
    root = doc.documentElement;
  if (doc.querySelector("parsererror") || root.localName !== "svg") throw new Error("Некорректный SVG.");
  const allowed = new Set([
    "svg",
    "g",
    "defs",
    "path",
    "rect",
    "circle",
    "ellipse",
    "polygon",
    "polyline",
    "line",
    "clipPath",
    "use",
    "title",
    "desc",
  ]);
  const elements = [root, ...root.querySelectorAll("*")];
  const unsupported = [...new Set(elements.filter((e) => !allowed.has(e.localName)).map((e) => e.localName))];
  if (unsupported.length)
    throw new Error(
      "Для SVG-экспорта не поддерживаются: " +
        unsupported.join(", ") +
        ". Переведите текст и обводки в контуры; уберите эффекты и растровые изображения.",
    );
  const idMap = new Map();
  for (const el of elements)
    if (el.id) {
      if (idMap.has(el.id)) throw new Error("В SVG повторяются идентификаторы.");
      idMap.set(el.id, "cv-src-" + idMap.size);
    }
  for (const el of elements) {
    for (const a of [...el.attributes]) {
      const n = a.name,
        v = a.value;
      if (/^on/i.test(n)) throw new Error("SVG содержит обработчики событий.");
      if (n === "id") {
        el.setAttribute("id", idMap.get(v));
        continue;
      }
      if (n === "href" || n === "xlink:href") {
        if (!v.startsWith("#") || !idMap.has(v.slice(1)))
          throw new Error("Внешние ссылки в SVG не поддерживаются.");
        el.setAttributeNS(a.namespaceURI, n, "#" + idMap.get(v.slice(1)));
        continue;
      }
      if (/(?:filter|mask|mix-blend-mode|isolation|vector-effect|animation|@import|var\()/i.test(n + " " + v))
        throw new Error("SVG содержит неподдерживаемый эффект или стиль.");
      if (/url\s*\(/i.test(v)) {
        const updated = v.replace(/url\(\s*['"]?#([^\s)'" ]+)['"]?\s*\)/g, (_, id) => {
          if (!idMap.has(id)) throw new Error("Не найдена ссылка внутри SVG.");
          return "url(#" + idMap.get(id) + ")";
        });
        if (/url\(\s*['"]?[^#]/i.test(updated)) throw new Error("Внешние ресурсы не поддерживаются.");
        el.setAttribute(n, updated);
      }
      if (n === "class") el.removeAttribute(n);
    }
  }
  // Reject recursive <use> chains before rendering.
  const defs = new Map(elements.filter((e) => e.id).map((e) => [e.id, e]));
  function walk(el, stack = new Set(), depth = 0) {
    if (depth > 80) throw new Error("Слишком сложная вложенность SVG.");
    if (el.localName === "use") {
      const id = (
        el.getAttribute("href") ||
        el.getAttributeNS("http://www.w3.org/1999/xlink", "href") ||
        ""
      ).slice(1);
      if (stack.has(id)) throw new Error("Циклическая ссылка в SVG.");
      const target = defs.get(id);
      if (target) walk(target, new Set([...stack, id]), depth + 1);
    }
    for (const c of el.children) walk(c, stack, depth + 1);
  }
  walk(root);
  const vb = (root.getAttribute("viewBox") || "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  let width = parseFloat(root.getAttribute("width")),
    height = parseFloat(root.getAttribute("height"));
  if (!Number.isFinite(width) || width <= 0) width = vb[2];
  if (!Number.isFinite(height) || height <= 0) height = vb[3];
  if (!(width > 0 && height > 0)) throw new Error("Укажите размеры или viewBox в SVG.");
  if (!root.hasAttribute("viewBox")) root.setAttribute("viewBox", `0 0 ${width} ${height}`);
  if (vb.length === 4 && (!vb.every(Number.isFinite) || vb[2] <= 0 || vb[3] <= 0))
    throw new Error("Некорректный viewBox.");
  root.setAttribute("xmlns", NS);
  root.setAttribute("width", width);
  root.setAttribute("height", height);
  const imageText = new XMLSerializer().serializeToString(root);
  const wrapper = doc.createElementNS(NS, "svg");
  wrapper.setAttribute("width", "1");
  wrapper.setAttribute("height", "1");
  wrapper.setAttribute("viewBox", `0 0 ${width} ${height}`);
  wrapper.setAttribute("preserveAspectRatio", "none");
  wrapper.append(root);
  return { imageText, source: new XMLSerializer().serializeToString(wrapper), width, height };
}
export const vectorDemo = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000"><path fill="#d7ff58" d="M0 0H1600V1000H0Z"/><g fill="#1b2110"><path d="M90 100H170V390H340V460H90ZM380 100H640V170H460V240H610V310H460V390H640V460H380ZM680 100H980V175H870V460H790V175H680ZM1080 100H1160V460H1080ZM1200 100H1510V175H1395V460H1315V175H1200ZM90 530H350V605H170V675H320V750H170V900H90ZM390 530H470V825H640V900H390ZM1030 530H1110L1150 770L1210 600H1270L1330 770L1370 530H1450L1380 900H1300L1240 730L1180 900H1100Z"/><path fill-rule="evenodd" d="M680 530H990V900H680ZM760 610V820H910V610Z"/><circle cx="1500" cy="860" r="40"/></g></svg>`;
