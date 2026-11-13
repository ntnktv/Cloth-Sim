import { beginRotate, rotateFromPointer } from "./rotate.mjs";
import {
  isVideo,
  videos,
  loadVideo,
  disposeVideo,
  seekVideo,
  seekVideos,
  syncVideos,
  cloneVideo,
} from "./video.mjs";
import { prepareFlatSVG } from "./flat-source.mjs";
import { prepareSVG, vectorDemo } from "./svg-source.mjs";
import {
  makeFlag,
  rebuildFlag,
  projectFlag,
  hitFlag,
  snapshotScene,
  clothDefaults,
  resetAllPhysics,
  stepFlags,
  windKeys,
} from "./scene.mjs";
import { flagBounds, restBounds, beginResize, resizeFromPointer } from "./resize.mjs";
import { Renderer } from "./render.mjs";
import { makeZip } from "./zip.mjs";
const $ = (id) => document.getElementById(id),
  canvas = $("canvas");
const MAX_FLAGS = 50,
  MAX_RATIO = 60,
  PALETTE = ["#FF3629", "#FB8DED", "#60C9F1", "#2487EF", "#FF6A00", "#00804D", "#FFC800"];
const scene = {
  width: 1920,
  height: 1080,
  background: "transparent",
  shade: false,
  wire: false,
  speed: 1,
  globalWind: true,
  groups: {},
  wind: { wind: "left", strength: clothDefaults.strength, turbulence: clothDefaults.turbulence, angle: clothDefaults.angle },
};
let recordingMedia = false;
// flags: back-to-front layer order. selection: ids; selectedId: primary (last clicked) flag.
let selection = new Set();
let flags = [],
  selectedId = null,
  nextId = 1,
  renderer = null,
  playing = true,
  busy = false,
  loading = false,
  cancel = false,
  worker = null,
  last = 0,
  accum = 0,
  elapsed = 0,
  frames = 0,
  fpsStart = 0,
  vectorURL = null,
  vectorText = "",
  rasterURL = null;
const selectedFlags = () => flags.filter((f) => selection.has(f.id)),
  selected = () => (selection.size === 1 ? flags.find((f) => f.id === selectedId) : undefined),
  primary = () => flags.find((f) => f.id === selectedId && selection.has(f.id)) || selectedFlags()[0],
  visible = () => flags.filter((f) => f.visible),
  status = (s) => {
    $("status").textContent = s;
    if (!$("busyOverlay").hidden) $("busyText").textContent = s;
  };
function showBusy(message) {
  $("busyOverlay").hidden = !message;
  $("busyText").textContent = message;
}
// One place for every per-flag property that is saved, undone and duplicated.
const FLAG_PROPS = ["name", "x", "y", "width", "roll", "edge", "pin", "resolution", "visible", "animationEnabled", "gust", "locked", "group", "rect"];
const flagProps = (f) => ({ ...Object.fromEntries(FLAG_PROPS.map((k) => [k, f[k]])), options: { ...f.options } });
function setSelection(ids, primaryId = ids[ids.length - 1] ?? null) {
  selection = new Set(ids);
  selectedId = selection.has(primaryId) ? primaryId : (ids[ids.length - 1] ?? null);
}
// Targets for a slider/option key: scene wind when shared, otherwise every selected flag.
const optionTargets = (key) =>
  windKeys.includes(key) && scene.globalWind ? [scene.wind] : selectedFlags().map((f) => f.options);
function sameValue(values, eps = 1e-8) {
  if (!values.length) return { value: undefined, mixed: false };
  const first = values[0];
  const mixed = values.some((v) =>
    typeof v === "number" && typeof first === "number" ? Math.abs(v - first) > eps : v !== first,
  );
  return { value: first, mixed };
}
const sliders = [
  ["windSliders", "strength", "сила", 0, 12, 0.1, 1],
  ["windSliders", "turbulence", "порывы", 0, 2, 0.01, 2],
  ["windSliders", "angle", "угол", -60, 60, 1, 0, "°"],
  ["clothSliders", "stiffness", "жёсткость", 0, 1, 0.01, 2],
  ["clothSliders", "mass", "масса", 0.25, 3, 0.05, 2],
  ["clothSliders", "damping", "затухание", 0.1, 3, 0.05, 2],
  ["clothSliders", "gravity", "гравитация", 0, 5, 0.05, 2],
];
for (const [parent, key, label, min, max, step, digits, suffix = ""] of sliders) {
  const wrap = document.createElement("div");
  wrap.className = "slider";
  wrap.innerHTML = `<label for="${key}">${label}</label><input type="range" id="${key}" min="${min}" max="${max}" step="${step}"><output id="${key}Out"></output>`;
  $(parent).append(wrap);
  $(key).oninput = () => {
    const targets = optionTargets(key);
    if (busy || !targets.length) return;
    for (const t of targets) t[key] = +$(key).value;
    $(key + "Out").textContent = (+$(key).value).toFixed(digits) + suffix;
  };
}
function updateButtons() {
  for (const el of document.querySelectorAll(".layer-pause")) el.disabled = busy || loading;
  $("resetAllPhysics").disabled = busy || loading || !flags.length;
  const f = selected(),
    v = visible();
  $("svg").disabled = busy || loading || !v.length || v.some((f) => !f.shapes);
  $("png").disabled = busy || loading || !renderer || !v.length;
  $("animate").disabled = loading || (!busy && (!renderer || !v.length));
  $("animate").textContent = busy ? "Отменить" : "Анимация";
  const count = selection.size;
  $("duplicate").disabled = busy || loading || !count || flags.length + count > MAX_FLAGS;
  $("deleteObject").disabled = busy || loading || !count;
  for (const id of ["makeText", "rectAdd"]) if ($(id)) $(id).disabled = busy || loading || flags.length >= MAX_FLAGS;
  $("objectCount").textContent = flags.length + " / " + MAX_FLAGS;
  $("meshInfo").textContent =
    flags.length +
    " флагов · " +
    flags.reduce((s, f) => s + f.cloth.count, 0).toLocaleString("ru") +
    " вершин";
  const incompatible = v.filter((f) => !f.shapes);
  $("vectorState").textContent = incompatible.length
    ? "SVG недоступен: " +
      incompatible.map((f) => f.name).join(", ") +
      ". Скройте видео и растровые флаги или выберите PNG / анимацию."
    : v.length
      ? "Все видимые флаги готовы к SVG-экспорту."
      : "Добавьте или покажите хотя бы один флаг.";
  $("exportInfo").textContent = `SVG: ${scene.width} × ${scene.height} · ${v.length} видимых флагов`;
  $("frameInfo").textContent = scene.width + " × " + scene.height;
}
// Reordering uses pointer events (works when the drag starts on the row's button).
// A group header drags its whole block; a flag dragged among another group's rows joins it,
// and dragged outside every group it leaves its own.
let layerDrag = null,
  enteredGroup = null;
function clearDropMarks() {
  for (const el of $("objectList").querySelectorAll(".drop-before,.drop-after,.dragging-layer"))
    el.classList.remove("drop-before", "drop-after", "dragging-layer");
}
const groupSpan = (list, g) => {
  const members = list.filter((f) => f.group === g);
  return members.length ? [list.indexOf(members[0]), list.indexOf(members[members.length - 1])] : null;
};
function applyLayerDrop(ids, target, after, movingGroup) {
  const moving = flags.filter((f) => ids.has(f.id)),
    rest = flags.filter((f) => !ids.has(f.id));
  if (!moving.length || !rest.length) return;
  let index, destGroup;
  if (target.group != null) {
    const span = groupSpan(rest, target.group);
    if (!span) return;
    index = span[1] + 1;
    destGroup = after && !movingGroup ? target.group : null;
  } else {
    const f = rest.find((x) => x.id === target.flagId);
    if (!f) return;
    index = rest.indexOf(f) + (after ? 0 : 1);
    destGroup = movingGroup ? null : f.group;
    // A whole group never lands inside another group: it goes above or below it.
    if (movingGroup && f.group) {
      const span = groupSpan(rest, f.group);
      index = after ? span[0] : span[1] + 1;
    }
  }
  if (!movingGroup) for (const f of moving) f.group = destGroup;
  rest.splice(index, 0, ...moving);
  flags = rest;
  sync();
  scheduleCommit(0);
}
$("objectList").addEventListener("pointerdown", (e) => {
  const entry = e.target.closest(".object-entry");
  if (!entry || busy || e.button !== 0 || e.target.closest(".layer-pause,.visibility,.lock,.badge,.twisty,input"))
    return;
  const group = entry.dataset.groupId ? +entry.dataset.groupId : null;
  layerDrag = { group, id: entry.dataset.flagId ? +entry.dataset.flagId : null, y: e.clientY, moved: false, target: null };
});
window.addEventListener("pointermove", (e) => {
  if (!layerDrag) return;
  if (!layerDrag.moved && Math.abs(e.clientY - layerDrag.y) < 5) return;
  if (!layerDrag.moved) {
    layerDrag.moved = true;
    if (layerDrag.group != null) layerDrag.ids = new Set(groupFlags(layerDrag.group).map((f) => f.id));
    else {
      if (!selection.has(layerDrag.id)) {
        setSelection([layerDrag.id]);
        sync();
      }
      layerDrag.ids = new Set(selection);
    }
    // Dragging a whole group — by its header or with all its rows selected — keeps it together.
    const moved = flags.filter((f) => layerDrag.ids.has(f.id)),
      one = new Set(moved.map((f) => f.group));
    if (one.size === 1 && moved[0].group && moved.length === groupFlags(moved[0].group).length)
      layerDrag.group = moved[0].group;
    document.body.classList.add("reordering");
  }
  clearDropMarks();
  for (const el of $("objectList").children)
    if (
      (el.dataset.flagId && layerDrag.ids.has(+el.dataset.flagId)) ||
      (el.dataset.groupId && groupFlags(+el.dataset.groupId).every((f) => layerDrag.ids.has(f.id)))
    )
      el.classList.add("dragging-layer");
  const over = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".object-entry");
  layerDrag.target = null;
  if (over && !over.classList.contains("dragging-layer")) {
    const r = over.getBoundingClientRect();
    layerDrag.after = e.clientY > r.top + r.height / 2;
    layerDrag.target = over.dataset.groupId
      ? { group: +over.dataset.groupId }
      : { flagId: +over.dataset.flagId };
    over.classList.add(layerDrag.after ? "drop-after" : "drop-before");
  }
});
window.addEventListener("pointercancel", () => {
  if (!layerDrag) return;
  layerDrag = null;
  document.body.classList.remove("reordering");
  clearDropMarks();
});
window.addEventListener("pointerup", () => {
  if (!layerDrag) return;
  const d = layerDrag;
  document.body.classList.remove("reordering");
  clearDropMarks();
  if (d.moved && d.target) applyLayerDrop(d.ids, d.target, d.after, d.group);
  // Keep "moved" visible to the click that follows this pointerup, then reset.
  setTimeout(() => {
    if (layerDrag === d) layerDrag = null;
  }, 0);
});
// A click in the list picks that very layer, as in Figma's layer panel; the canvas picks groups.
function chooseInList(f, e) {
  if (busy) return;
  if (!e.shiftKey && !e.metaKey && !e.ctrlKey && selection.size === 1 && selection.has(f.id)) return;
  enteredGroup = f.group || null;
  if (e.shiftKey && selectedId != null) {
    const shown = layerRows().filter((r) => r.flag).map((r) => r.flag),
      a = shown.findIndex((x) => x.id === selectedId),
      b = shown.findIndex((x) => x.id === f.id);
    if (a >= 0 && b >= 0) {
      const range = shown.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.id);
      setSelection([...new Set([...selection, ...range])], f.id);
      return sync();
    }
  }
  if (e.metaKey || e.ctrlKey) {
    const ids = new Set(selection);
    if (ids.has(f.id)) ids.delete(f.id);
    else ids.add(f.id);
    setSelection([...ids], ids.has(f.id) ? f.id : selectedId);
  } else setSelection([f.id]);
  sync();
}
// Moves the selection through the layer order: one step, or all the way to the front or back.
// A whole group moves as one block and never lands inside another group; flags selected inside a
// group move only within it.
function shiftLayers(direction, toEnd = false) {
  const list = selectedFlags(),
    ids = new Set(selection);
  if (busy || !list.length) return;
  const groups = new Set(list.map((f) => f.group).filter(Boolean));
  if (groups.size > 1 || (groups.size === 1 && list.some((f) => !f.group)))
    return status("Для перестановки выберите флаги из одной группы.");
  const g = [...groups][0];
  if (g && list.length < groupFlags(g).length) {
    // Inside a group: reorder among its own members.
    const members = groupFlags(g),
      lo = flags.indexOf(members[0]),
      hi = flags.indexOf(members[members.length - 1]);
    if (toEnd) {
      const moving = members.filter((f) => ids.has(f.id)),
        others = members.filter((f) => !ids.has(f.id));
      flags.splice(lo, members.length, ...(direction > 0 ? [...others, ...moving] : [...moving, ...others]));
    } else
      for (const f of direction > 0 ? [...members].reverse() : members) {
        if (!ids.has(f.id)) continue;
        const i = flags.indexOf(f),
          j = i + direction;
        if (j < lo || j > hi || ids.has(flags[j].id)) continue;
        [flags[i], flags[j]] = [flags[j], flags[i]];
      }
    return sync();
  }
  const moving = flags.filter((f) => ids.has(f.id)),
    rest = flags.filter((f) => !ids.has(f.id));
  if (!rest.length) return;
  let index;
  if (toEnd) index = direction > 0 ? rest.length : 0;
  else {
    const anchor = flags.indexOf(direction > 0 ? moving[moving.length - 1] : moving[0]),
      neighbour = flags[anchor + direction];
    if (!neighbour) return;
    if (neighbour.group) {
      const span = groupSpan(rest, neighbour.group);
      index = direction > 0 ? span[1] + 1 : span[0];
    } else index = rest.indexOf(neighbour) + (direction > 0 ? 1 : 0);
  }
  rest.splice(index, 0, ...moving);
  flags = rest;
  sync();
}
// Layer list shows the front layer on top (reverse of the back-to-front flags array).
// Group members are kept contiguous in that array, so a group is one block of rows.
function groupInfo(g) {
  scene.groups[g] ||= { name: "Группа " + g, open: true };
  return scene.groups[g];
}
const groupFlags = (g) => flags.filter((f) => f.group === g);
function layerRows() {
  const rows = [],
    seen = new Set();
  for (const f of [...flags].reverse()) {
    if (!f.group) {
      rows.push({ flag: f, depth: 0 });
      continue;
    }
    if (seen.has(f.group)) continue;
    seen.add(f.group);
    const members = groupFlags(f.group);
    rows.push({ group: f.group, members });
    if (groupInfo(f.group).open) for (const m of [...members].reverse()) rows.push({ flag: m, depth: 1 });
  }
  return rows;
}
const icon = (paths, size = 16) =>
  `<svg viewBox="0 0 ${size} ${size}" aria-hidden="true">${paths}</svg>`;
const EYE_OPEN = icon('<path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10Z"/><circle cx="10" cy="10" r="2.4"/>', 20),
  EYE_SHUT = icon('<path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10Z"/><path d="M3.5 16.5 16.5 3.5"/>', 20),
  LOCK_SHUT = icon('<rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>'),
  LOCK_OPEN = icon('<rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.6-1.3"/>');
// Inline rename, used by both flag rows and group headers.
function startRename(host, value, apply) {
  if (busy) return;
  const input = document.createElement("input");
  input.className = "rename";
  input.value = value;
  input.maxLength = 80;
  host.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save) apply(input.value.trim() || value);
    sync();
    scheduleCommit(0);
  };
  input.onblur = () => finish(true);
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  };
}
function toggleButton(className, on, html, title, onclick) {
  const b = document.createElement("button");
  b.className = className;
  b.innerHTML = html;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.setAttribute("aria-pressed", String(on));
  b.onclick = (e) => {
    e.stopPropagation();
    if (!busy) onclick();
  };
  return b;
}
function groupEntry(g, members) {
  const info = groupInfo(g),
    entry = document.createElement("div"),
    row = document.createElement("div"),
    ids = members.map((m) => m.id),
    selected = ids.every((id) => selection.has(id)),
    visible = members.some((m) => m.visible),
    locked = members.every((m) => m.locked);
  entry.className = "object-entry group-entry";
  entry.dataset.groupId = g;
  row.className =
    "object-row group-row" +
    (selected && enteredGroup !== g ? " selected" : "") +
    (!visible ? " is-hidden" : "") +
    (locked ? " is-locked" : "");
  const twisty = document.createElement("button");
  twisty.className = "twisty" + (info.open ? " open" : "");
  twisty.innerHTML = icon('<path d="M6 4l5 4-5 4Z"/>');
  twisty.title = info.open ? "Свернуть группу" : "Развернуть группу";
  twisty.setAttribute("aria-label", twisty.title);
  twisty.setAttribute("aria-expanded", String(info.open));
  twisty.onclick = (e) => {
    e.stopPropagation();
    info.open = !info.open;
    renderList();
  };
  const choose = document.createElement("button");
  choose.className = "choose-object group-choose";
  choose.setAttribute("aria-pressed", String(selected));
  choose.innerHTML =
    icon('<rect x="2.5" y="2.5" width="11" height="11" rx="1" stroke-dasharray="3 2"/>') +
    `<span class="object-label">${info.name.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])}</span>` +
    `<span class="group-count">${members.length}</span>`;
  choose.onclick = (e) => {
    if (layerDrag?.moved || busy) return;
    // A repeated plain click changes nothing, so the row survives for a double click (rename).
    if (!e.shiftKey && !e.metaKey && !e.ctrlKey && selected && selection.size === ids.length && !enteredGroup)
      return;
    enteredGroup = null;
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      const next = new Set(selection);
      const add = !selected;
      for (const id of ids) (add ? next.add(id) : next.delete(id)).valueOf?.();
      setSelection([...next], add ? ids[ids.length - 1] : selectedId);
    } else setSelection(ids);
    sync();
  };
  choose.ondblclick = () =>
    startRename(choose.querySelector(".object-label"), info.name, (name) => (info.name = name));
  row.append(
    twisty,
    choose,
    toggleButton("lock", locked, locked ? LOCK_SHUT : LOCK_OPEN, locked ? "Снять замок с группы" : "Закрепить группу", () => {
      for (const m of members) m.locked = locked ? undefined : true;
      sync();
    }),
    toggleButton("visibility", visible, visible ? EYE_OPEN : EYE_SHUT, visible ? "Скрыть группу" : "Показать группу", () => {
      for (const m of members) m.visible = !visible;
      sync();
      updateMedia();
    }),
  );
  entry.append(row);
  return entry;
}
function flagEntry(f, depth) {
  const entry = document.createElement("div");
  entry.className = "object-entry" + (depth ? " nested" : "");
  entry.dataset.flagId = f.id;
  const pause = document.createElement("button");
  pause.className = "layer-pause";
  pause.dataset.flagId = f.id;
  const paused = f.animationEnabled === false;
  pause.innerHTML = paused
    ? icon('<path d="M5 3L13 8L5 13Z"/>')
    : icon('<path d="M4 3H7V13H4ZM10 3H13V13H10Z"/>');
  pause.classList.toggle("is-paused", paused);
  pause.title = (paused ? "Продолжить анимацию: " : "Пауза анимации: ") + f.name;
  pause.setAttribute("aria-label", pause.title);
  pause.setAttribute("aria-pressed", String(paused));
  pause.disabled = busy || loading;
  pause.onclick = () => {
    if (busy || loading || pointer) return;
    f.animationEnabled = paused;
    if (isVideo(f.image)) f.image.playFailed = false;
    updateMedia();
    renderList();
    draw();
  };
  const row = document.createElement("div");
  row.className =
    "object-row" +
    (selection.has(f.id) ? " selected" : "") +
    (!f.visible ? " is-hidden" : "") +
    (f.locked ? " is-locked" : "");
  const choose = document.createElement("button");
  choose.className = "choose-object";
  choose.setAttribute("aria-pressed", String(selection.has(f.id)));
  choose.setAttribute("aria-label", "Выбрать " + f.name);
  const img = document.createElement("img");
  img.src = f.thumbnail;
  img.alt = "";
  img.draggable = false;
  const label = document.createElement("span");
  label.className = "object-label";
  label.textContent = f.name;
  choose.append(img, label);
  choose.onclick = (e) => {
    if (layerDrag?.moved) return;
    chooseInList(f, e);
  };
  choose.ondblclick = () => startRename(label, f.name, (name) => (f.name = name));
  row.append(choose);
  if (!f.shapes) {
    const badge = document.createElement("button");
    badge.className = "badge" + (f.reason ? " warn" : "");
    badge.textContent = f.reason ? "!" : "растр";
    badge.title = f.reason
      ? "Не попадёт в SVG: " + f.reason
      : "Растровый слой: есть в PNG и анимации, для SVG его нужно скрыть";
    badge.onclick = () => status(badge.title);
    row.append(badge);
  }
  row.append(
    toggleButton("lock", !!f.locked, f.locked ? LOCK_SHUT : LOCK_OPEN, f.locked ? "Снять замок" : "Закрепить: нельзя выбрать и сдвинуть на холсте", () => {
      f.locked = f.locked ? undefined : true;
      sync();
    }),
    toggleButton("visibility", f.visible, f.visible ? EYE_OPEN : EYE_SHUT, (f.visible ? "Скрыть " : "Показать ") + f.name, () => {
      f.visible = !f.visible;
      renderList();
      updateButtons();
      draw();
    }),
  );
  entry.append(pause, row);
  return entry;
}
function renderList() {
  const list = $("objectList");
  list.replaceChildren();
  for (const row of layerRows())
    list.append(row.group != null ? groupEntry(row.group, row.members) : flagEntry(row.flag, row.depth));
  updateButtons();
}

function setField(id, values, round = 100) {
  const { value, mixed } = sameValue(values);
  $(id).value = mixed || value === undefined ? "" : Math.round(value * round) / round;
  $(id).placeholder = mixed ? "—" : "";
}
function sync() {
  for (const id of [...selection]) if (!flags.some((x) => x.id === id)) selection.delete(id);
  for (const g of Object.keys(scene.groups)) if (!groupFlags(+g).length) delete scene.groups[g];
  if (enteredGroup && !selectedFlags().some((f) => f.group === enteredGroup)) enteredGroup = null;
  const list = selectedFlags(),
    f = primary(),
    none = !list.length,
    multi = list.length > 1;
  renderList();
  for (const el of document.querySelectorAll(".props input,.props select,.props button"))
    el.disabled = none || busy;
  // Shared wind stays editable without a selection.
  $("globalWind").disabled = busy;
  for (const el of $("userPresets").querySelectorAll("button:last-child")) el.disabled = busy;
  $("globalWind").checked = scene.globalWind;
  if (scene.globalWind)
    for (const el of $("windGroup").querySelectorAll("input,select,button")) el.disabled = busy;
  $("propsPanel").classList.toggle("is-multi", multi);
  const rects = list.length > 0 && list.every((x) => x.rect);
  $("colorGroup").hidden = !rects;
  if (rects)
    for (const sw of $("recolor").querySelectorAll("[data-color]"))
      sw.classList.toggle("active", list.every((x) => x.rect.color === sw.dataset.color));
  $("lockBtn").classList.toggle("active", list.length > 0 && list.every((x) => x.locked));
  $("lockBtn").textContent = list.length > 0 && list.every((x) => x.locked) ? "снять замок" : "замок";
  $("alignGroup").classList.toggle("can-distribute", list.length > 2);
  $("objectName").disabled = busy || none || multi;
  $("objectName").value = multi ? "" : f ? f.name : "";
  $("objectName").placeholder = multi ? `Выбрано: ${list.length}` : "Выберите флаг";
  for (const [, key, , , , , digits, suffix = ""] of sliders) {
    const targets = optionTargets(key),
      { value, mixed } = sameValue(targets.map((t) => t[key]));
    if (value === undefined) {
      $(key + "Out").textContent = "";
      continue;
    }
    $(key).value = value;
    $(key + "Out").textContent = mixed ? "—" : value.toFixed(digits) + suffix;
  }
  const windSource = optionTargets("wind");
  for (const b of $("wind").querySelectorAll("button")) {
    const on = windSource.length > 0 && windSource.every((t) => t.wind === b.dataset.value);
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  }
  const windDir = sameValue(windSource.map((t) => t.wind));
  $("windDescription").textContent = windDir.mixed
    ? "разный"
    : ({ left: "слева → направо", right: "справа → налево", top: "сверху → вниз", bottom: "снизу → вверх" }[
        windDir.value
      ] ?? "");
  if (none) {
    for (const id of ["posX", "posY", "objectWidth", "roll"]) setField(id, []);
    draw();
    return;
  }
  setField("posX", list.map((x) => x.x));
  setField("posY", list.map((x) => x.y));
  setField("objectWidth", list.map((x) => x.width));
  for (const key of ["roll"])
    setField(key, list.map((x) => (x[key] * 180) / Math.PI), 10);
  $("resolution").value = sameValue(list.map((x) => x.resolution)).value;
  const collision = sameValue(list.map((x) => !!x.options.collision));
  $("collision").checked = !!collision.value && !collision.mixed;
  $("collision").indeterminate = collision.mixed;
  for (const b of $("presets").querySelectorAll("button"))
    b.classList.toggle(
      "active",
      list.every((x) =>
        Object.entries(presets[b.dataset.preset]).every(([k, v]) => Math.abs(x.options[k] - v) < 1e-8),
      ),
    );
  for (const b of $("pin").querySelectorAll("button")) {
    const on = list.every((x) => x.edge === b.dataset.value);
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  }
  for (const b of $("pinMode").querySelectorAll("button"))
    b.classList.toggle("active", list.every((x) => (x.pin || "edge") === b.dataset.value));
  setField("gust", list.map((x) => x.gust || 0), 1);
  draw();
}
function makeAlpha(img) {
  const c = document.createElement("canvas"),
    s = Math.min(1, 256 / Math.max(img.width, img.height));
  c.width = Math.max(1, Math.round(img.width * s));
  c.height = Math.max(1, Math.round(img.height * s));
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0, c.width, c.height);
  return {
    alpha: { width: c.width, height: c.height, data: g.getImageData(0, 0, c.width, c.height).data },
    thumbnail: c.toDataURL("image/png"),
  };
}
function addImage(image, name, shapes, reason = "", { above = null, select = true } = {}) {
  if (flags.length >= MAX_FLAGS) throw new Error(`В композиции может быть до ${MAX_FLAGS} флагов.`);
  const id = nextId++,
    f = makeFlag({ id, name, image, shapes, reason, scene, phase: id * 7.131 });
  const offset = (flags.length % 5) * Math.min(scene.width, scene.height) * 0.045;
  f.x += offset;
  f.y += offset;
  Object.assign(f, makeAlpha(image));
  if (isVideo(image)) {
    f.alpha = null;
    knownVideos.add(image);
  }
  const index = above ? flags.indexOf(above) + 1 : flags.length;
  flags.splice(index > 0 ? index : flags.length, 0, f);
  if (select) setSelection([id]);
  sync();
  return f;
}
// SVG artwork is rasterized for the GPU at high resolution instead of its nominal pixel size,
// so a small Figma export stays sharp when the flag is large. Vector export is unaffected.
function rasterizeSVG(image, wanted = 2048) {
  const maxTexture = renderer?.gl?.getParameter(renderer.gl.MAX_TEXTURE_SIZE) || 4096,
    long = Math.min(wanted, maxTexture),
    w = image.width,
    h = image.height,
    s = Math.min(long / Math.max(w, h), Math.sqrt(4.2e6 / (w * h)));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  c.getContext("2d").drawImage(image, 0, 0, c.width, c.height);
  return c;
}
// Gives a viewBox-only SVG explicit width/height so the browser can measure it.
function sizeSVGText(text) {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml"),
    root = doc.documentElement;
  if (doc.querySelector("parsererror") || root.localName !== "svg") return text;
  const vb = (root.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  if (!(parseFloat(root.getAttribute("width")) > 0) && vb[2] > 0) root.setAttribute("width", vb[2]);
  if (!(parseFloat(root.getAttribute("height")) > 0) && vb[3] > 0) root.setAttribute("height", vb[3]);
  return new XMLSerializer().serializeToString(root);
}
async function decodeFile(file) {
  if (/\.mp4$/i.test(file.name)) return { image: await loadVideo(file), shapes: null, reason: "" };
  if (!/\.(png|jpe?g|webp|svg)$/i.test(file.name)) throw new Error("Выберите PNG, JPG, WebP, SVG или MP4.");
  if (file.size > 40 * 1024 * 1024) throw new Error("Файл больше 40 МБ.");
  const svg = /\.svg$/i.test(file.name);
  let shapes = null,
    reason = "",
    input = file;
  if (svg) {
    const text = await file.text();
    try {
      const prepared = prepareSVG(text);
      shapes = prepareFlatSVG(prepared);
      input = new Blob([prepared.imageText], { type: "image/svg+xml" });
    } catch (e) {
      reason = e.message;
      input = new Blob([sizeSVGText(text)], { type: "image/svg+xml" });
    }
  }
  const url = URL.createObjectURL(input);
  try {
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
    } catch {
      throw new Error("Браузер не смог открыть файл.");
    }
    if (!image.width || !image.height) throw new Error("Не удалось определить размеры изображения.");
    const ratio = Math.max(image.width / image.height, image.height / image.width);
    if (ratio > MAX_RATIO)
      throw new Error(`Пропорции ${Math.round(ratio)}:1 — максимум ${MAX_RATIO}:1.`);
    return { image: svg ? rasterizeSVG(image, 1024) : image, svgImage: svg ? image : null, shapes, reason };
  } finally {
    URL.revokeObjectURL(url);
  }
}
async function loadFiles(files) {
  if (busy || loading) return [];
  loading = true;
  updateButtons();
  const errors = [],
    addedIds = [];
  let added = 0;
  for (const file of files) {
    if (flags.length >= MAX_FLAGS) {
      errors.push(`Достигнут предел: ${MAX_FLAGS} флагов.`);
      break;
    }
    try {
      const { image, svgImage, shapes, reason } = await decodeFile(file);
      const name = file.name.startsWith("Прямоугольник") ? file.name.replace(/\.svg$/i, "") : file.name;
      const flag = addImage(image, name, shapes, reason, { select: false });
      flag.source = { name: file.name, blob: file };
      flag.svgImage = svgImage;
      addedIds.push(flag.id);
      added++;
      if (reason) errors.push(file.name + ": " + reason);
    } catch (e) {
      errors.push(file.name + ": " + e.message);
    }
  }
  loading = false;
  if (addedIds.length) setSelection(addedIds);
  sync();
  status(`Добавлено флагов: ${added}. ` + errors.join(" "));
  $("file").value = "";
  scheduleCommit(0);
  return addedIds;
}
$("file").onchange = (e) => loadFiles([...e.target.files]);
$("demo").onclick = () => loadFiles([new File([vectorDemo], "Демо-флаг.svg", { type: "image/svg+xml" })]);
$("duplicate").onclick = async () => {
  const sources = selectedFlags();
  if (!sources.length || busy || loading || flags.length + sources.length > MAX_FLAGS) return;
  loading = true;
  updateButtons();
  const created = [],
    regroup = new Map();
  let freeGroup = nextGroup();
  try {
    for (const f of sources) {
      let image = f.image;
      try {
        if (isVideo(image)) image = await cloneVideo(image);
        const copy = addImage(image, f.name + " — копия", f.shapes, f.reason, { above: f, select: false });
        Object.assign(copy, {
          ...flagProps(f),
          name: copy.name,
          source: f.source,
          svgImage: f.svgImage,
          gust: 0,
          locked: undefined,
          group: f.group ? (regroup.get(f.group) ?? regroup.set(f.group, freeGroup++).get(f.group)) : undefined,
          x: f.x + scene.width * 0.04,
          y: f.y + scene.height * 0.04,
          options: { ...f.options, phase: copy.options.phase },
        });
        rebuildFlag(copy);
        copy.cloth.p.set(f.cloth.p);
        copy.cloth.v.set(f.cloth.v);
        copy.cloth.time = f.cloth.time;
        copy.cloth.computeNormals();
        created.push(copy.id);
      } catch (e) {
        if (image !== f.image && !flags.some((x) => x.image === image)) disposeVideo(image);
        status(e.message);
      }
    }
    for (const [old, fresh] of regroup)
      scene.groups[fresh] = { name: (scene.groups[old]?.name || "Группа") + " копия", open: true };
    for (const g of new Set(flags.filter((f) => created.includes(f.id) && f.group).map((f) => f.group)))
      packGroup(g);
    if (created.length) {
      setSelection(created);
      status(created.length > 1 ? `Создано копий: ${created.length}.` : "Создан независимый флаг со своим порывом ветра.");
    }
  } finally {
    loading = false;
    sync();
    updateMedia();
    scheduleCommit(0);
  }
};
function deleteSelection() {
  if (busy || loading || !selection.size) return;
  const shown = [...flags].reverse(),
    first = shown.findIndex((f) => selection.has(f.id)),
    removed = flags.filter((f) => selection.has(f.id));
  flags = flags.filter((f) => !selection.has(f.id));
  const rest = [...flags].reverse(),
    next = rest[Math.min(first, rest.length - 1)];
  setSelection(next ? [next.id] : []);
  sync();
}
$("deleteObject").onclick = deleteSelection;
$("objectName").oninput = () => {
  const f = selected();
  if (f && !busy) {
    f.name = $("objectName").value.trim() || "Флаг";
    renderList();
  }
};
for (const [id, key] of [
  ["posX", "x"],
  ["posY", "y"],
  ["objectWidth", "width"],
  ["roll", "roll"],
])
  $(id).oninput = () => {
    const list = selectedFlags(),
      v = Number($(id).value);
    if (!list.length || busy) return;
    if (!Number.isFinite(v) || $(id).value === "") return;
    for (const f of list)
      f[key] = ["yaw", "pitch", "roll"].includes(key)
        ? (Math.max(-360, Math.min(360, v)) * Math.PI) / 180
        : key === "width"
          ? Math.max(1, Math.min(100000, v))
          : Math.max(-100000, Math.min(100000, v));
    $(id).placeholder = "";
    draw();
  };
$("layerUp").onclick = () => shiftLayers(1);
$("layerDown").onclick = () => shiftLayers(-1);
$("pin").onclick = (e) => {
  const b = e.target.closest("button");
  if (!b || busy) return;
  for (const f of selectedFlags()) {
    f.edge = b.dataset.value;
    rebuildFlag(f);
  }
  sync();
};
$("wind").onclick = (e) => {
  const b = e.target.closest("button");
  if (!b || busy) return;
  for (const t of optionTargets("wind")) t.wind = b.dataset.value;
  sync();
};
$("globalWind").onchange = () => {
  if (busy) return;
  scene.globalWind = $("globalWind").checked;
  // Switching to shared wind starts from the primary flag's settings, and back again.
  const f = primary();
  if (f)
    for (const key of windKeys)
      if (scene.globalWind) scene.wind[key] = f.options[key];
      else for (const x of flags) x.options[key] = scene.wind[key];
  status(scene.globalWind ? "Ветер общий для всех флагов." : "У каждого флага свой ветер.");
  sync();
};
const presets = {
  silk: { stiffness: 0.38, mass: 1, damping: 0.65, gravity: 0.15 },
  flag: { stiffness: 0.66, mass: 1.5, damping: 0.8, gravity: 0.35 },
  paper: { stiffness: 0.97, mass: 1.7, damping: 1.2, gravity: 0.2 },
};
$("presets").onclick = (e) => {
  const b = e.target.closest("button");
  if (!b || busy) return;
  for (const f of selectedFlags()) Object.assign(f.options, presets[b.dataset.preset]);
  sync();
};
$("resetParams").onclick = () => {
  if (busy) return;
  for (const f of selectedFlags()) {
    const keep = Object.fromEntries(windKeys.map((k) => [k, f.options[k]]));
    f.options = { ...clothDefaults, ...(scene.globalWind ? keep : {}), phase: f.options.phase };
    f.cloth.reset();
  }
  touchSim();
  sync();
};
$("resetAllPhysics").onclick = () => {
  if (busy || loading || pointer || !flags.length) return;
  resetAllPhysics(flags);
  clearTimeline();
  for (const key of windKeys) scene.wind[key] = clothDefaults[key];
  elapsed = 0;
  last = 0;
  accum = 0;
  sync();
  status("Физика всех слоёв сброшена к исходным настройкам.");
  rewindMedia();
};
const gustPhase = (f) => f.id * 7.131 + (f.gust || 0) * 11.317;
function setGust(list, value) {
  for (const f of list) {
    f.gust = value(f);
    f.options.phase = gustPhase(f);
    f.cloth.reset();
  }
  touchSim();
  sync();
}
$("newGust").onclick = () => {
  const list = selectedFlags();
  if (!list.length || busy) return;
  setGust(list, (f) => (f.gust || 0) + 1);
  status(list.length > 1 ? "У выбранных флагов новые порывы." : "Порыв № " + list[0].gust + ".");
};
$("gust").onchange = () => {
  const list = selectedFlags(),
    v = Math.round(+$("gust").value);
  if (!list.length || busy || !Number.isFinite(v)) return;
  setGust(list, () => Math.max(0, Math.min(9999, v)));
};
$("pinMode").onclick = (e) => {
  const b = e.target.closest("button");
  if (!b || busy) return;
  for (const f of selectedFlags()) {
    f.pin = b.dataset.value;
    rebuildFlag(f);
  }
  sync();
};
$("resolution").onchange = () => {
  if (busy) return;
  for (const f of selectedFlags()) {
    f.resolution = +$("resolution").value;
    rebuildFlag(f);
  }
  sync();
};
$("collision").onchange = () => {
  if (busy) return;
  for (const f of selectedFlags()) f.options.collision = $("collision").checked;
};
// Palette swatches: one shared colour for text and rectangles.
let paletteColor = PALETTE[0];
for (const group of document.querySelectorAll(".palette")) {
  for (const color of PALETTE) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.style.background = color;
    b.dataset.color = color;
    b.setAttribute("aria-label", "Цвет " + color);
    group.append(b);
  }
  group.onclick = (e) => {
    const b = e.target.closest("[data-color]");
    if (!b) return;
    paletteColor = b.dataset.color;
    for (const s of document.querySelectorAll(".palette:not(#recolor) [data-color]"))
      s.classList.toggle("active", s.dataset.color === paletteColor);
  };
}
for (const s of document.querySelectorAll(".palette:not(#recolor) [data-color]"))
  s.classList.toggle("active", s.dataset.color === paletteColor);
$("makeText").onclick = () => {
  if (busy || loading || flags.length >= MAX_FLAGS) return;
  const lines = $("text").value.trim().split("\n").slice(0, 8);
  if (!lines[0]) return;
  const c = document.createElement("canvas"),
    g = c.getContext("2d");
  g.font = "900 240px Arial";
  const w = Math.max(...lines.map((t) => g.measureText(t).width), 300),
    s = Math.min(1, 4000 / (w + 100));
  c.width = Math.ceil((w + 100) * s);
  c.height = Math.ceil((lines.length * 260 + 80) * s);
  g.scale(s, s);
  g.font = "900 240px Arial";
  g.fillStyle = paletteColor;
  g.textBaseline = "top";
  lines.forEach((line, i) => g.fillText(line, 50, 40 + i * 260));
  addImage(c, "Растровый текст", null);
  status("Для SVG используйте текст в кривых из Figma.");
};
// Align: one flag aligns to the artboard, several align to their common bounds (rest pose).
function unionBounds(list) {
  const b = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (const f of list) {
    const r = restBounds(f);
    b.left = Math.min(b.left, r.left);
    b.top = Math.min(b.top, r.top);
    b.right = Math.max(b.right, r.right);
    b.bottom = Math.max(b.bottom, r.bottom);
  }
  return b;
}
$("alignGroup").onclick = (e) => {
  const b = e.target.closest("[data-align]"),
    list = selectedFlags();
  if (!b || busy || !list.length) return;
  const mode = b.dataset.align;
  if (mode.startsWith("dist")) {
    if (list.length < 3) return;
    const horizontal = mode === "dist-x",
      [lo, hi] = horizontal ? ["left", "right"] : ["top", "bottom"],
      items = list.map((f) => ({ f, r: restBounds(f) })).sort((a, c) => a.r[lo] - c.r[lo]),
      total = items.reduce((s, it) => s + it.r[hi] - it.r[lo], 0),
      span = items[items.length - 1].r[hi] - items[0].r[lo],
      gap = (span - total) / (items.length - 1);
    let pos = items[0].r[lo];
    for (const { f, r } of items) {
      const delta = pos - r[lo];
      if (horizontal) f.x += delta;
      else f.y += delta;
      pos += r[hi] - r[lo] + gap;
    }
  } else {
    const t =
      list.length === 1 ? { left: 0, top: 0, right: scene.width, bottom: scene.height } : unionBounds(list);
    for (const f of list) {
      const r = restBounds(f);
      if (mode === "left") f.x += t.left - r.left;
      if (mode === "right") f.x += t.right - r.right;
      if (mode === "hcenter") f.x += (t.left + t.right) / 2 - (r.left + r.right) / 2;
      if (mode === "top") f.y += t.top - r.top;
      if (mode === "bottom") f.y += t.bottom - r.bottom;
      if (mode === "vcenter") f.y += (t.top + t.bottom) / 2 - (r.top + r.bottom) / 2;
    }
  }
  sync();
};
function setBackground(bg) {
  scene.background = bg;
  $("frame").style.backgroundImage = bg === "transparent" ? "" : "none";
  $("frame").style.backgroundColor = bg === "transparent" ? "" : bg;
  for (const b of document.querySelectorAll("[data-bg]")) b.classList.toggle("active", b.dataset.bg === bg);
  draw();
}
$("background").onclick = (e) => {
  const b = e.target.closest("[data-bg]");
  if (b && !busy) setBackground(b.dataset.bg);
};
for (const key of ["shade", "wire"])
  $(key).onchange = () => {
    if (!busy) {
      scene[key] = $(key).checked;
      draw();
    }
  };
$("speed").onchange = () => {
  if (!busy) {
    scene.speed = +$("speed").value;
    updateMedia();
  }
};
function layout() {
  const stage = $("stage"),
    fit = Math.min(
      Math.max(1, stage.clientWidth - 40) / scene.width,
      Math.max(1, stage.clientHeight - 40) / scene.height,
    ),
    scale = fit * zoom;
  $("frame").style.width = scene.width * scale + "px";
  $("frame").style.height = scene.height * scale + "px";
  $("selectionOverlay").setAttribute("viewBox", `0 0 ${scene.width} ${scene.height}`);
  draw();
}
$("sceneForm").onsubmit = (e) => {
  e.preventDefault();
  if (busy) return;
  const w = +$("sceneWidth").value,
    h = +$("sceneHeight").value;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 64 || h < 64 || w > 50000 || h > 50000)
    return status("Размеры холста: целые числа от 64 до 50 000.");
  if ($("scaleScene").checked) {
    const scale = Math.min(w / scene.width, h / scene.height);
    for (const f of flags) {
      f.x = (f.x - scene.width / 2) * scale + w / 2;
      f.y = (f.y - scene.height / 2) * scale + h / 2;
      f.width *= scale;
    }
  }
  scene.width = w;
  scene.height = h;
  sync();
  layout();
  status(`Формат композиции: ${w} × ${h}. SVG сохранится точно в этом размере.`);
};
$("swapSize").onclick = () => {
  if (busy) return;
  const w = $("sceneWidth").value;
  $("sceneWidth").value = $("sceneHeight").value;
  $("sceneHeight").value = w;
  $("sceneForm").requestSubmit();
};
$("previewHeight").oninput = () => {
  $("stage").style.height = $("previewHeight").value + "px";
  layout();
};
new ResizeObserver(layout).observe($("stage"));
// Preview resolution follows what the machine can actually draw: full device pixels while frames
// are quick, dropping towards 1 device pixel per CSS pixel when they are not. Export is unaffected.
let renderScale = 1,
  drawCost = 0;
function previewSize() {
  const r = canvas.getBoundingClientRect(),
    ratio = Math.min(devicePixelRatio || 1, 2) * renderScale,
    scale = Math.min(ratio, 2400 / Math.max(r.width, r.height));
  return [Math.max(2, Math.round(r.width * scale)), Math.max(2, Math.round(r.height * scale))];
}
const corners = ["nw", "ne", "se", "sw"];
const handles = corners.map((corner) => {
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.dataset.corner = corner;
  g.classList.add("resize-handle");
  for (const cls of ["handle-hit", "handle-node"]) {
    const r = document.createElementNS(g.namespaceURI, "rect");
    r.classList.add(cls);
    g.append(r);
  }
  $("selectionOverlay").append(g);
  return g;
});
const rotationHandles = corners.map((corner) => {
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.dataset.rotate = corner;
  g.classList.add("rotation-handle");
  g.innerHTML =
    '<title>Повернуть · Shift: шаг 15°</title><circle class="rotation-hit" r="18"/><path class="rotation-hint" d="M-7 4A8 8 0 0 1 6 -5M1 -6L6 -5L5 0"/>';
  $("selectionOverlay").insertBefore(g, handles[0]);
  return g;
});
const rotationReadout = document.createElement("div");
rotationReadout.className = "rotation-readout";
rotationReadout.hidden = true;
$("frame").append(rotationReadout);
const SVGNS = "http://www.w3.org/2000/svg";
function setRect(el, b) {
  for (const [k, v] of Object.entries({
    x: b.left,
    y: b.top,
    width: Math.max(0, b.right - b.left),
    height: Math.max(0, b.bottom - b.top),
  }))
    el.setAttribute(k, v);
}
function selectionOutline() {
  const list = selectedFlags().filter((f) => f.visible),
    single = selection.size === 1 && list.length === 1 && !list[0].locked ? list[0] : null,
    box = $("selectionBox"),
    cross = $("selectionCenter"),
    unit = scene.width / Math.max(1, canvas.clientWidth),
    multi = $("multiBoxes");
  for (const g of [...handles, ...rotationHandles]) g.style.display = single ? "" : "none";
  cross.style.display = single ? "" : "none";
  box.style.display = list.length ? "" : "none";
  multi.replaceChildren();
  // Marquee and snap guides are drawn independently of the selection.
  const m = pointer?.marquee;
  $("marquee").style.display = m?.rect ? "" : "none";
  if (m?.rect) setRect($("marquee"), m.rect);
  $("snapGuides").setAttribute("d", pointer?.guides || "");
  if (!list.length) return;
  if (!single) {
    const all = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    for (const f of list) {
      const b = flagBounds(f),
        r = document.createElementNS(SVGNS, "rect");
      setRect(r, b);
      r.setAttribute("class", "multi-box");
      multi.append(r);
      all.left = Math.min(all.left, b.left);
      all.top = Math.min(all.top, b.top);
      all.right = Math.max(all.right, b.right);
      all.bottom = Math.max(all.bottom, b.bottom);
    }
    setRect(box, all);
    return;
  }
  const f = single,
    b = flagBounds(f);
  setRect(box, b);
  const d = 7 * unit;
  cross.setAttribute("d", `M${f.x - d} ${f.y}H${f.x + d}M${f.x} ${f.y - d}V${f.y + d}`);
  rotationHandles.forEach((g, i) => {
    const sx = corners[i].includes("e") ? 1 : -1,
      sy = corners[i].includes("s") ? 1 : -1;
    g.setAttribute(
      "transform",
      `translate(${(sx > 0 ? b.right : b.left) + sx * 24 * unit} ${(sy > 0 ? b.bottom : b.top) + sy * 24 * unit}) scale(${unit})`,
    );
  });
  handles.forEach((g, i) => {
    g.setAttribute(
      "transform",
      `translate(${corners[i].includes("e") ? b.right : b.left} ${corners[i].includes("s") ? b.bottom : b.top})`,
    );
    [...g.children].forEach((r, j) => {
      const size = (j ? 9 : 28) * unit;
      for (const [k, v] of Object.entries({ x: -size / 2, y: -size / 2, width: size, height: size }))
        r.setAttribute(k, v);
    });
  });
}
// draw() marks the canvas as needing a repaint; the loop repaints at most once per frame and
// skips it entirely while nothing moves, which keeps the interface responsive on slow machines.
let dirty = true;
function draw() {
  dirty = true;
}
function renderNow() {
  if (busy) return;
  dirty = false;
  const t = performance.now();
  try {
    renderer?.draw(flags, scene, ...previewSize());
    selectionOutline();
  } catch (e) {
    status(e.message);
  }
  drawCost = drawCost ? drawCost * 0.9 + (performance.now() - t) * 0.1 : performance.now() - t;
  if (drawCost > 24 && renderScale > 0.5) renderScale = Math.max(0.5, renderScale - 0.1);
  else if (drawCost < 9 && renderScale < 1) renderScale = Math.min(1, renderScale + 0.05);
}
let pointer = null;
const frame = $("frame");
function pointerPoint(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) * scene.width) / r.width,
    y: ((e.clientY - r.top) * scene.height) / r.height,
  };
}
// Topmost layer under the point: layer order wins over 3D depth.
function hitTop(x, y) {
  for (let i = flags.length - 1; i >= 0; i--)
    if (flags[i].visible && !flags[i].locked && hitFlag([flags[i]], scene, x, y)) return flags[i];
  return null;
}
// Snap targets: artboard edges and centre, plus edges and centres of other visible flags.
function snapTargets(exclude) {
  const xs = [0, scene.width / 2, scene.width],
    ys = [0, scene.height / 2, scene.height];
  for (const f of flags) {
    if (!f.visible || exclude.has(f.id)) continue;
    const r = restBounds(f);
    xs.push(r.left, (r.left + r.right) / 2, r.right);
    ys.push(r.top, (r.top + r.bottom) / 2, r.bottom);
  }
  return { xs, ys };
}
function snapAxis(edges, targets, threshold) {
  let best = null;
  for (const e of edges)
    for (const t of targets) {
      const d = t - e;
      if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, t };
    }
  return best;
}
frame.ondblclick = (e) => {
  if (busy || loading) return;
  const point = pointerPoint(e),
    f = hitTop(point.x, point.y);
  if (f?.group) {
    e.preventDefault();
    enterGroup(f);
    status("Вы внутри группы «" + groupInfo(f.group).name + "». Escape — выйти.");
  }
};
frame.onpointerdown = (e) => {
  if (busy || loading || pointer || e.button !== 0) return;
  const point = pointerPoint(e),
    handle = e.target.closest?.("[data-corner]"),
    rotate = e.target.closest?.("[data-rotate]"),
    additive = e.shiftKey || e.metaKey || e.ctrlKey;
  e.preventDefault();
  const common = { pointerId: e.pointerId, point, wasPlaying: playing };
  if (handle || rotate) {
    const f = selected();
    if (!f?.visible || f.locked) return;
    pointer = {
      ...common,
      id: f.id,
      targets: snapTargets(new Set([f.id])),
      starts: new Map([[f.id, { x: f.x, y: f.y, width: f.width, roll: f.roll }]]),
      rotate: rotate ? beginRotate(f, point) : null,
      resize: handle ? beginResize(f, handle.dataset.corner, point) : null,
    };
    frame.dataset.gesture = rotate ? "rotate" : handle.dataset.corner;
    rotationReadout.hidden = !rotate;
    if (rotate) rotationReadout.textContent = ((f.roll * 180) / Math.PI).toFixed(1) + "°";
  } else {
    const f = hitTop(point.x, point.y);
    if (!f) {
      // Empty space: marquee selection.
      pointer = {
        ...common,
        marquee: {
          base: additive ? new Set(selection) : new Set(),
          boxes: flags.filter((x) => x.visible && !x.locked).map((x) => ({ id: x.id, b: flagBounds(x) })),
          rect: null,
        },
      };
      if (!additive) setSelection([]);
      frame.dataset.gesture = "marquee";
    } else {
      if (additive) {
        const ids = new Set(selection);
        if (ids.has(f.id)) {
          ids.delete(f.id);
          setSelection([...ids], selectedId === f.id ? undefined : selectedId);
          sync();
          return;
        }
        ids.add(f.id);
        setSelection(groupMembers([...ids]), f.id);
      } else if (!selection.has(f.id)) setSelection(groupMembers([f.id]), f.id);
      else selectedId = f.id;
      const moving = selectedFlags();
      pointer = {
        ...common,
        id: f.id,
        starts: new Map(moving.map((x) => [x.id, { x: x.x, y: x.y, width: x.width, roll: x.roll }])),
        bounds: unionBounds(moving),
        targets: snapTargets(selection),
      };
      frame.dataset.gesture = "move";
    }
  }
  play(false);
  frame.setPointerCapture(e.pointerId);
  sync();
};
frame.onpointermove = (e) => {
  if (!pointer || e.pointerId !== pointer.pointerId || busy) return;
  const point = pointerPoint(e),
    unit = scene.width / Math.max(1, canvas.clientWidth);
  if (pointer.marquee) {
    const m = pointer.marquee,
      rect = {
        left: Math.min(point.x, pointer.point.x),
        right: Math.max(point.x, pointer.point.x),
        top: Math.min(point.y, pointer.point.y),
        bottom: Math.max(point.y, pointer.point.y),
      };
    m.rect = rect;
    const hit = m.boxes
      .filter(({ b }) => b.left < rect.right && b.right > rect.left && b.top < rect.bottom && b.bottom > rect.top)
      .map(({ id }) => id);
    setSelection(groupMembers([...new Set([...m.base, ...hit])]));
    sync();
    return;
  }
  const f = flags.find((x) => x.id === pointer.id);
  if (!f) return;
  if (pointer.rotate) {
    f.roll = rotateFromPointer(pointer.rotate, point, e.shiftKey);
    $("roll").value = Math.round(((f.roll * 180) / Math.PI) * 10) / 10;
    rotationReadout.textContent = $("roll").value + "°" + (e.shiftKey ? " · шаг 15°" : "");
  } else if (pointer.resize) {
    // Proportional resize; the dragged corner snaps to the artboard and to other flags (Alt: off).
    const r = pointer.resize;
    let next = resizeFromPointer(r, point);
    pointer.guides = "";
    if (!e.altKey) {
      const k = next.width / r.width,
        threshold = 6 * unit,
        sx = Math.abs(r.dx) > 1e-6 ? snapAxis([r.anchor.x + r.dx * k], pointer.targets.xs, threshold) : null,
        sy = Math.abs(r.dy) > 1e-6 ? snapAxis([r.anchor.y + r.dy * k], pointer.targets.ys, threshold) : null,
        useX = sx && (!sy || Math.abs(sx.d) <= Math.abs(sy.d)),
        scale = useX ? (sx.t - r.anchor.x) / r.dx : sy ? (sy.t - r.anchor.y) / r.dy : 0;
      if (scale > 0) {
        next = { width: r.width * scale, x: r.anchor.x + (r.x - r.anchor.x) * scale, y: r.anchor.y + (r.y - r.anchor.y) * scale };
        pointer.guides = useX ? `M${sx.t} 0V${scene.height}` : `M0 ${sy.t}H${scene.width}`;
      }
    }
    Object.assign(f, next);
  }
  else {
    let dx = point.x - pointer.point.x,
      dy = point.y - pointer.point.y;
    const b = pointer.bounds,
      threshold = 6 * unit,
      guides = [];
    // Hold Alt to move without snapping.
    if (!e.altKey) {
      const sx = snapAxis([b.left + dx, (b.left + b.right) / 2 + dx, b.right + dx], pointer.targets.xs, threshold),
        sy = snapAxis([b.top + dy, (b.top + b.bottom) / 2 + dy, b.bottom + dy], pointer.targets.ys, threshold);
      if (sx) {
        dx += sx.d;
        guides.push(`M${sx.t} 0V${scene.height}`);
      }
      if (sy) {
        dy += sy.d;
        guides.push(`M0 ${sy.t}H${scene.width}`);
      }
    }
    pointer.guides = guides.join("");
    for (const [id, s] of pointer.starts) {
      const x = flags.find((q) => q.id === id);
      if (x) {
        x.x = s.x + dx;
        x.y = s.y + dy;
      }
    }
  }
  if (selection.size === 1)
    for (const [id, key] of [
      ["posX", "x"],
      ["posY", "y"],
      ["objectWidth", "width"],
    ])
      $(id).value = Math.round(f[key] * 100) / 100;
  draw();
};
function finishPointer(cancelled = false) {
  if (!pointer) return;
  const old = pointer;
  pointer = null;
  if (old.marquee) {
    if (cancelled) setSelection([...old.marquee.base]);
  } else if (cancelled)
    for (const [id, s] of old.starts) {
      const f = flags.find((x) => x.id === id);
      if (f) Object.assign(f, s);
    }
  if (frame.hasPointerCapture(old.pointerId)) frame.releasePointerCapture(old.pointerId);
  rotationReadout.hidden = true;
  delete frame.dataset.gesture;
  play(old.wasPlaying);
  sync();
}
frame.onpointerup = (e) => {
  if (e.pointerId === pointer?.pointerId) finishPointer();
};
frame.onpointercancel = (e) => {
  if (e.pointerId === pointer?.pointerId) finishPointer(true);
};
frame.onlostpointercapture = () => finishPointer();
window.addEventListener("blur", () => finishPointer());
window.addEventListener("keydown", (e) => {
  if (pointer && e.key === "Escape") {
    e.preventDefault();
    finishPointer(true);
  }
});
function updateMedia() {
  syncVideos(flags, (recordingMedia || (playing && !busy)) && !document.hidden, scene.speed, status);
}
function play(value) {
  playing = value;
  for (const v of videos(flags)) v.playFailed = false;
  updateMedia();
  $("play").innerHTML = playing
    ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3H7V13H4ZM9 3H12V13H9Z"/></svg>'
    : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3L13 8L5 13Z"/></svg>';
  $("play").setAttribute("aria-label", playing ? "Пауза" : "Продолжить");
  $("liveLabel").textContent = playing ? "Симуляция идёт" : "На паузе";
  last = 0;
  accum = 0;
}
$("play").onclick = () => {
  if (!busy) play(!playing);
};
async function rewindMedia() {
  lock(true);
  try {
    await seekVideos(flags, 0);
  } catch (e) {
    status(e.message);
  } finally {
    lock(false);
    draw();
  }
}
$("restart").onclick = () => {
  if (!busy) {
    for (const f of flags) f.cloth.reset();
    touchSim();
    elapsed = 0;
    clearTimeline();
    rewindMedia();
  }
};
$("step").onclick = async () => {
  if (busy) return;
  play(false);
  lock(true);
  try {
    await stepAsync(1);
    await Promise.all(
      videos(flags.filter((f) => f.animationEnabled !== false)).map((v) =>
        seekVideo(v, v.currentTime + 1 / 60),
      ),
    );
  } catch (e) {
    status(e.message);
  } finally {
    lock(false);
    draw();
  }
};
window.addEventListener("keydown", (e) => {
  if (
    busy ||
    pointer ||
    /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) ||
    $("helpDialog").open ||
    $("vectorDialog").open
  )
    return;
  if (e.code === "Space") {
    e.preventDefault();
    if (!e.repeat) {
      spaceHeld = true;
      spacePanned = false;
      $("stage").classList.add("pan-ready");
    }
    return;
  }
  const list = selectedFlags(),
    mod = e.metaKey || e.ctrlKey;
  if (list.length && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.code)) {
    e.preventDefault();
    const d = e.shiftKey ? 10 : 1;
    for (const f of list) {
      if (e.code === "ArrowLeft") f.x -= d;
      if (e.code === "ArrowRight") f.x += d;
      if (e.code === "ArrowUp") f.y -= d;
      if (e.code === "ArrowDown") f.y += d;
    }
    sync();
  } else if ((e.key === "Delete" || e.key === "Backspace") && list.length) {
    e.preventDefault();
    deleteSelection();
  } else if (mod && e.code === "KeyZ") {
    e.preventDefault();
    undo(e.shiftKey ? 1 : -1);
  } else if (mod && e.code === "KeyY") {
    e.preventDefault();
    undo(1);
  } else if (mod && e.code === "KeyG") {
    e.preventDefault();
    if (e.shiftKey) ungroupSelection();
    else groupSelection();
  } else if (mod && e.code === "KeyA") {
    e.preventDefault();
    setSelection(flags.filter((f) => !f.locked).map((f) => f.id));
    sync();
  } else if (mod && e.code === "KeyD" && list.length) {
    e.preventDefault();
    $("duplicate").click();
  } else if (e.code === "BracketRight") {
    e.preventDefault();
    shiftLayers(1, !mod);
  } else if (e.code === "BracketLeft") {
    e.preventDefault();
    shiftLayers(-1, !mod);
  } else if (mod && e.shiftKey && e.code === "KeyH" && list.length) {
    e.preventDefault();
    const hide = list.every((f) => f.visible);
    for (const f of list) f.visible = !hide;
    sync();
    updateMedia();
  } else if (mod && e.shiftKey && e.code === "KeyL" && list.length) {
    e.preventDefault();
    const lock = !list.every((f) => f.locked);
    for (const f of list) f.locked = lock || undefined;
    sync();
  } else if (mod && e.code === "Digit0") {
    e.preventDefault();
    setZoom(1);
  } else if (e.shiftKey && e.code === "Digit1") {
    e.preventDefault();
    fitZoom();
  } else if (e.shiftKey && e.code === "Digit2" && list.length) {
    e.preventDefault();
    zoomToSelection(list);
  } else if (e.code === "Enter" && list.length) {
    e.preventDefault();
    if (!enterGroup()) status("Выбранный флаг не в группе.");
  } else if (e.key === "Escape") {
    if (!exitGroup() && list.length) {
      setSelection([]);
      sync();
    }
  }
});
let dragCount = 0;
document.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer.types.includes("Files")) return;
  e.preventDefault();
  if (!busy && !loading) {
    dragCount++;
    $("stage").classList.add("dragging");
  }
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("dragleave", () => {
  if (--dragCount <= 0) $("stage").classList.remove("dragging");
});
document.addEventListener("drop", (e) => {
  e.preventDefault();
  if (!e.dataTransfer.types.includes("Files")) return;
  dragCount = 0;
  $("stage").classList.remove("dragging");
  loadFiles([...e.dataTransfer.files]);
});
let pasteCount = 0;
document.addEventListener("paste", (e) => {
  if (/INPUT|TEXTAREA/.test(e.target.tagName) || busy || loading) return;
  const files = [...(e.clipboardData?.files || [])],
    text = e.clipboardData?.getData("text/plain") || "";
  if (files.length) {
    e.preventDefault();
    loadFiles(files.map((f) => (f.name ? f : new File([f], `Вставка ${++pasteCount}.png`, { type: f.type }))));
  } else if (/<svg[\s>]/i.test(text)) {
    e.preventDefault();
    loadFiles([new File([text], `Вставка ${++pasteCount}.svg`, { type: "image/svg+xml" })]);
  }
});
$("help").onclick = () => $("helpDialog").showModal();
$("closeHelp").onclick = () => $("helpDialog").close();
$("closeVector").onclick = () => $("vectorDialog").close();
function loop(t) {
  requestAnimationFrame(loop);
  updateMedia();
  if (busy || document.hidden) {
    last = 0;
    return;
  }
  const dt = last ? Math.min((t - last) / 1000, 0.06) : 1 / 60;
  last = t;
  if (playing && !pointer) {
    accum = Math.min(accum + dt * scene.speed, 2 / 60);
    const n = Math.floor(accum * 60 + 1e-9);
    if (n && !stepping) {
      accum = n >= 2 ? 0 : accum - n / 60;
      stepping = true;
      stepAsync(n).finally(() => (stepping = false));
    }
  }
  if (dirty || playing || recordingMedia || videos(flags).some((v) => !v.paused)) renderNow();
  updateTimeline();
  $("time").textContent =
    String(Math.floor(elapsed / 60)).padStart(2, "0") + ":" + (elapsed % 60).toFixed(2).padStart(5, "0");
  frames++;
  if (t - fpsStart >= 1000) {
    $("fps").textContent = Math.round((frames * 1000) / (t - fpsStart)) + " fps";
    fpsStart = t;
    frames = 0;
  }
}
document.addEventListener("visibilitychange", () => {
  last = 0;
  updateMedia();
});
function lock(v, message = "") {
  busy = v;
  touchSim();
  showBusy(v ? message : "");
  updateMedia();
  document.body.classList.toggle("exporting", v);
  for (const el of document.querySelectorAll(
    "#sceneForm input,#sceneForm button,.export-options select,.export-options input,#speed",
  ))
    el.disabled = v;
  last = 0;
  accum = 0;
  updateButtons();
  updateHistoryButtons();
}
function download(blob, name) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function pngBlob() {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Не удалось сохранить кадр."))), "image/png"),
  );
}
function exportSeconds() {
  const v = Math.round(+$("duration").value);
  const s = Number.isFinite(v) ? Math.max(1, Math.min(60, v)) : 5;
  $("duration").value = s;
  return s;
}
function rasterDimensions() {
  const value = $("exportSize").value,
    s = value === "native" ? 1 : Math.min(1, +value / Math.max(scene.width, scene.height));
  return [Math.max(2, Math.round(scene.width * s)), Math.max(2, Math.round(scene.height * s))];
}
$("png").onclick = async () => {
  if (busy || !renderer) return;
  lock(true);
  try {
    const [w, h] = rasterDimensions();
    renderer.draw(flags, scene, w, h, true);
    download(await pngBlob(), "cloth-composition.png");
    status(`PNG-композиция: ${w} × ${h}.`);
  } catch (e) {
    status(e.message);
  } finally {
    lock(false);
    draw();
  }
};
$("svg").onclick = async () => {
  if (busy || loading || !visible().length || visible().some((f) => !f.shapes)) return;
  cancel = false;
  lock(true, "Фиксирую все флаги и рассчитываю SVG-композицию…");
  status("Фиксирую все флаги и рассчитываю SVG-композицию…");
  try {
    const snapshot = snapshotScene(flags);
    if (rasterURL) {
      URL.revokeObjectURL(rasterURL);
      rasterURL = null;
    }
    if (renderer) {
      const scale = Math.min(1, 1600 / Math.max(scene.width, scene.height));
      renderer.draw(
        flags,
        { ...scene, shade: false },
        Math.max(2, Math.round(scene.width * scale)),
        Math.max(2, Math.round(scene.height * scale)),
        true,
      );
      rasterURL = URL.createObjectURL(await pngBlob());
    }
    if (cancel) {
      lock(false);
      draw();
      return;
    }
    const w = (worker = new Worker("./vector-worker.mjs", { type: "module" }));
    w.onmessage = ({ data }) => {
      if (data.progress) {
        status(data.progress);
        return;
      }
      w.terminate();
      worker = null;
      lock(false);
      draw();
      if (data.error) {
        status(data.error);
        return;
      }
      const result = data.result;
      vectorText = result.text;
      if (vectorURL) URL.revokeObjectURL(vectorURL);
      const file = new Blob([result.text], { type: "image/svg+xml" });
      vectorURL = URL.createObjectURL(file);
      $("downloadVector").href = vectorURL;
      $("vectorImage").src = vectorURL;
      const rasterFigure = $("rasterImage").closest("figure");
      rasterFigure.hidden = !rasterURL;
      $("vectorDialog").classList.toggle("single-preview", !rasterURL);
      if (rasterURL) $("rasterImage").src = rasterURL;
      else $("rasterImage").removeAttribute("src");
      $("vectorStats").textContent =
        `${scene.width} × ${scene.height} · ${snapshot.length} флагов · ${result.paths} контуров · ${result.points.toLocaleString("ru")} точек · ${(file.size / 1048576).toFixed(1)} МБ`;
      $("vectorDialog").showModal();
      status("SVG-композиция готова. Скачайте файл в окне проверки.");
    };
    w.onerror = () => {
      w.terminate();
      worker = null;
      lock(false);
      draw();
      status("Не удалось рассчитать SVG. Уменьшите детализацию сцены.");
    };
    w.postMessage({
      flags: snapshot,
      options: { ...scene, layered: true, separate: $("svgMode").value === "separate", simplify: +$("svgSimplify").value },
    });
  } catch (e) {
    worker?.terminate();
    worker = null;
    lock(false);
    draw();
    status(e.message);
  }
};
// Simulates count + blend frames and returns a function that applies loop frame i: the first
// frames are cross-faded with the frames after the end, so frame count-1 flows into frame 0.
async function simulateLoop(count, dt) {
  const blend = Math.min(count, 45),
    active = flags.filter((f) => f.visible && f.animationEnabled !== false),
    bytes = active.reduce((s, f) => s + f.cloth.p.byteLength, 0) * (count + blend);
  if (bytes > 500e6) throw new Error("Слишком длинный цикл для такой сцены. Уменьшите длительность.");
  const record = [];
  for (let i = 0; i < count + blend; i++) {
    if (cancel) throw new Error("Экспорт отменён.");
    if (i) await stepAsync(2, dt);
    record.push(active.map((f) => f.cloth.p.slice()));
    if (i % 10 === 0) status(`Считаю цикл: ${Math.round((i / (count + blend)) * 100)}%`);
  }
  return (i) => {
    const t = i < blend ? i / blend : 1,
      w = t * t * (3 - 2 * t);
    active.forEach((f, k) => {
      const a = record[i][k],
        p = f.cloth.p;
      if (w >= 1) p.set(a);
      else {
        const b = record[i + count][k];
        for (let j = 0; j < p.length; j++) p[j] = b[j] + (a[j] - b[j]) * w;
      }
      f.cloth.computeNormals();
    });
  };
}
async function exportSequence() {
  const starts = new Map(
    videos(flags.filter((f) => f.animationEnabled !== false)).map((v) => [v, v.currentTime]),
  );
  const count = exportSeconds() * 30,
    files = [],
    [w, h] = rasterDimensions();
  let bytes = 0;
  const loop = $("loop").checked ? await simulateLoop(count, (1 / 60) * scene.speed) : null;
  for (let frame = 0; frame < count; frame++) {
    if (cancel) throw new Error("Экспорт отменён.");
    if (loop) loop(frame);
    else if (frame) await stepAsync(2, (1 / 60) * scene.speed);
    dirty = true;
    await Promise.all([...starts].map(([v, time]) => seekVideo(v, time + (frame / 30) * scene.speed)));
    if (cancel) throw new Error("Экспорт отменён.");
    renderer.draw(flags, scene, w, h, true);
    const data = new Uint8Array(await (await pngBlob()).arrayBuffer());
    files.push({ name: "cloth_" + String(frame).padStart(5, "0") + ".png", data });
    bytes += data.length;
    if (bytes > 350 * 1024 * 1024)
      throw new Error("Архив превысил 350 МБ. Уменьшите размер или длительность.");
    status(`PNG-последовательность: ${frame + 1} / ${count}`);
    await new Promise((r) => setTimeout(r, 0));
  }
  files.push({
    name: "README.txt",
    data: new TextEncoder().encode(`${count} frames at 30 fps. ${w} x ${h}. ${loop ? "Seamless loop." : "Not a seamless loop."}`),
  });
  download(makeZip(files), "cloth-composition-30fps.zip");
  status("PNG-последовательность композиции сохранена.");
}
async function exportVideo() {
  if (!window.MediaRecorder || !canvas.captureStream)
    throw new Error("Выберите PNG-последовательность: видеозапись недоступна.");
  const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"].find((m) =>
    MediaRecorder.isTypeSupported(m),
  );
  if (!mime) throw new Error("Видеокодек недоступен.");
  let [w, h] = rasterDimensions();
  w = Math.max(2, Math.round(w / 2) * 2);
  h = Math.max(2, Math.round(h / 2) * 2);
  const opts = { ...scene, background: scene.background === "transparent" ? "#171817" : scene.background };
  renderer.draw(flags, opts, w, h, true);
  const stream = canvas.captureStream(30),
    chunks = [];
  let recorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12000000 });
    const done = new Promise((resolve, reject) => {
      recorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      recorder.onstop = resolve;
      recorder.onerror = () => reject(new Error("Ошибка записи видео."));
    });
    const duration = exportSeconds(),
      loop = $("loop").checked ? await simulateLoop(duration * 30, (1 / 60) * scene.speed) : null;
    recordingMedia = true;
    syncVideos(flags, true, scene.speed, status);
    recorder.start();
    const start = performance.now();
    let previous = start,
      acc = 0;
    try {
      while ((performance.now() - start) / 1000 < duration && !cancel) {
        await new Promise(requestAnimationFrame);
        const now = performance.now();
        acc += Math.min((now - previous) / 1000, 0.1) * scene.speed;
        previous = now;
        const n = Math.min(6, Math.floor(acc * 60));
        if (loop) loop(Math.min(duration * 30 - 1, Math.floor(((now - start) / 1000) * 30)));
        else if (n) {
          acc -= n / 60;
          await stepAsync(n);
        }
        renderer.draw(flags, opts, w, h, true);
        status(`Запись композиции: ${Math.min(duration, (now - start) / 1000).toFixed(1)} / ${duration} сек`);
      }
    } finally {
      if (recorder.state !== "inactive") recorder.stop();
      await done;
    }
    if (cancel) throw new Error("Экспорт отменён.");
    download(
      new Blob(chunks, { type: mime }),
      "cloth-composition." + (mime.includes("mp4") ? "mp4" : "webm"),
    );
    status("Видео композиции сохранено.");
  } finally {
    recordingMedia = false;
    syncVideos(flags, false, scene.speed);
    stream.getTracks().forEach((t) => t.stop());
  }
}
function cancelBusy() {
  if (worker) {
    worker.terminate();
    worker = null;
    lock(false);
    draw();
    status("SVG-экспорт отменён.");
  } else if (busy) cancel = true;
}
$("busyCancel").onclick = cancelBusy;
$("animate").onclick = async () => {
  if (worker) {
    worker.terminate();
    worker = null;
    lock(false);
    draw();
    status("SVG-экспорт отменён.");
    return;
  }
  if (busy) {
    cancel = true;
    return;
  }
  if (!renderer || loading || !visible().length) return;
  cancel = false;
  const saved = flags.map((f) => ({ f, p: f.cloth.p.slice(), v: f.cloth.v.slice(), time: f.cloth.time })),
    savedElapsed = elapsed,
    savedMedia = videos(flags).map((v) => [v, v.currentTime]);
  lock(true, "Готовлю анимацию…");
  try {
    if ($("format").value === "zip") await exportSequence();
    else await exportVideo();
  } catch (e) {
    status(e.message);
  } finally {
    for (const { f, p, v, time } of saved) {
      f.cloth.p.set(p);
      f.cloth.v.set(v);
      f.cloth.time = time;
      f.cloth.computeNormals();
    }
    touchSim();
    elapsed = savedElapsed;
    try {
      await Promise.all(savedMedia.map(([v, time]) => seekVideo(v, time)));
    } catch (e) {
      status(e.message);
    } finally {
      lock(false);
      draw();
    }
  }
};
// ---------- Zoom and pan ----------
let zoom = 1,
  spaceHeld = false,
  spacePanned = false,
  pan = null;
function setZoom(z, anchor) {
  const stage = $("stage"),
    frameEl = $("frame"),
    before = frameEl.getBoundingClientRect(),
    box = stage.getBoundingClientRect(),
    a = anchor || { x: box.left + box.width / 2, y: box.top + box.height / 2 },
    rx = (a.x - before.left) / before.width,
    ry = (a.y - before.top) / before.height;
  zoom = Math.max(0.25, Math.min(8, z));
  layout();
  const after = frameEl.getBoundingClientRect();
  stage.scrollLeft += after.left + rx * after.width - a.x;
  stage.scrollTop += after.top + ry * after.height - a.y;
  const select = $("previewZoom"),
    preset = [...select.options].find((o) => o.value !== "custom" && Math.abs(+o.value - zoom) < 0.005);
  $("zoomCustom").hidden = !!preset;
  $("zoomCustom").textContent = Math.round(zoom * 100) + "%";
  select.value = preset ? preset.value : "custom";
}
// Shift+1 fits the artboard in the stage; Shift+2 fits the selection, as in Figma.
function fitZoom() {
  setZoom(1);
  $("stage").scrollTo({ left: 0, top: 0 });
}
function zoomToSelection(list) {
  const b = unionBounds(list),
    stage = $("stage").getBoundingClientRect(),
    width = Math.max(1, b.right - b.left),
    height = Math.max(1, b.bottom - b.top),
    fit = Math.min(scene.width / width, scene.height / height) * 0.9;
  setZoom(fit);
  const frameBox = $("frame").getBoundingClientRect(),
    cx = frameBox.left + ((b.left + b.right) / 2 / scene.width) * frameBox.width,
    cy = frameBox.top + ((b.top + b.bottom) / 2 / scene.height) * frameBox.height;
  $("stage").scrollLeft += cx - (stage.left + stage.width / 2);
  $("stage").scrollTop += cy - (stage.top + stage.height / 2);
}
$("previewZoom").onchange = () => {
  if ($("previewZoom").value !== "custom") setZoom(+$("previewZoom").value);
};
$("stage").addEventListener(
  "wheel",
  (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    setZoom(zoom * Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0025)), { x: e.clientX, y: e.clientY });
  },
  { passive: false },
);
$("stage").addEventListener(
  "pointerdown",
  (e) => {
    if (!(spaceHeld && e.button === 0) && e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    const stage = $("stage");
    pan = { id: e.pointerId, x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add("panning");
  },
  true,
);
$("stage").addEventListener("pointermove", (e) => {
  if (!pan || e.pointerId !== pan.id) return;
  spacePanned = true;
  $("stage").scrollLeft = pan.left - (e.clientX - pan.x);
  $("stage").scrollTop = pan.top - (e.clientY - pan.y);
});
for (const type of ["pointerup", "pointercancel"])
  $("stage").addEventListener(type, (e) => {
    if (!pan || e.pointerId !== pan.id) return;
    pan = null;
    $("stage").classList.remove("panning");
  });
window.addEventListener("keyup", (e) => {
  if (e.code !== "Space" || !spaceHeld) return;
  spaceHeld = false;
  $("stage").classList.remove("pan-ready");
  if (!spacePanned && !busy && !pointer) play(!playing);
});
window.addEventListener("blur", () => {
  spaceHeld = false;
  $("stage").classList.remove("pan-ready");
});

// ---------- Groups and locks ----------
// A click on the canvas picks the whole group; a double click steps into it and picks one flag.
function groupMembers(ids) {
  const out = new Set(ids);
  for (const id of ids) {
    const f = flags.find((x) => x.id === id);
    if (f?.group && f.group !== enteredGroup)
      for (const m of groupFlags(f.group)) if (!m.locked) out.add(m.id);
  }
  return [...out];
}
const nextGroup = () => Math.max(0, ...flags.map((f) => f.group || 0)) + 1;
// Group members are stored as one contiguous block, so the layer list and the z-order agree.
function packGroup(g) {
  const members = flags.filter((f) => f.group === g);
  if (!members.length) return [];
  const top = Math.max(...members.map((m) => flags.indexOf(m))),
    above = flags.slice(top + 1).filter((f) => f.group !== g).length,
    rest = flags.filter((f) => f.group !== g);
  flags = [...rest.slice(0, rest.length - above), ...members, ...rest.slice(rest.length - above)];
  return members;
}
function groupSelection() {
  const list = selectedFlags();
  if (busy || list.length < 2) return;
  const g = nextGroup(),
    nested = new Set(list.map((f) => f.group).filter(Boolean));
  for (const f of list) f.group = g;
  for (const old of nested) delete scene.groups[old];
  groupInfo(g);
  enteredGroup = null;
  const members = packGroup(g);
  setSelection(members.map((m) => m.id));
  status(nested.size ? "Группы объединены в одну: вложенных групп пока нет." : "Группа создана.");
  sync();
}
function ungroupSelection() {
  const list = selectedFlags();
  if (busy || !list.some((f) => f.group)) return;
  for (const g of new Set(list.map((f) => f.group).filter(Boolean))) delete scene.groups[g];
  for (const f of list) f.group = undefined;
  enteredGroup = null;
  sync();
}
// Steps into the group of the selected flags and picks one member, as Enter does in Figma.
function enterGroup(flag) {
  const f = flag || primary();
  if (!f?.group) return false;
  enteredGroup = f.group;
  setSelection([f.id]);
  sync();
  return true;
}
// Steps back out: the whole group becomes the selection again.
function exitGroup() {
  const f = primary();
  if (!enteredGroup || !f) return false;
  const g = enteredGroup;
  enteredGroup = null;
  setSelection(groupFlags(g).filter((m) => !m.locked).map((m) => m.id), f.id);
  sync();
  return true;
}
$("groupBtn").onclick = groupSelection;
$("ungroupBtn").onclick = ungroupSelection;
$("lockBtn").onclick = () => {
  const list = selectedFlags();
  if (busy || !list.length) return;
  const lock = !list.every((f) => f.locked);
  for (const f of list) f.locked = lock || undefined;
  sync();
};

// ---------- Rectangles: custom proportions and recolouring ----------
const colorNames = { "#FF3629": "красный", "#FB8DED": "розовый", "#60C9F1": "голубой", "#2487EF": "синий", "#FF6A00": "оранжевый", "#00804D": "зелёный", "#FFC800": "жёлтый" };
function rectFile(rw, rh, color) {
  const k = 1000 / Math.max(rw, rh),
    w = Math.max(1, Math.round(rw * k)),
    h = Math.max(1, Math.round(rh * k)),
    text = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${color}"/></svg>`;
  return new File([text], `Прямоугольник ${rw}:${rh} · ${colorNames[color] || color}.svg`, { type: "image/svg+xml" });
}
function markRatio() {
  const value = $("rectW").value + ":" + $("rectH").value;
  for (const x of $("rectRatio").querySelectorAll("button")) x.classList.toggle("active", x.dataset.ratio === value);
}
$("rectRatio").onclick = (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  [$("rectW").value, $("rectH").value] = b.dataset.ratio.split(":");
  markRatio();
};
$("rectW").oninput = $("rectH").oninput = markRatio;
$("rectAdd").onclick = async () => {
  if (busy || loading || flags.length >= MAX_FLAGS) return;
  const rw = +$("rectW").value,
    rh = +$("rectH").value;
  if (!(rw > 0 && rh > 0) || Math.max(rw / rh, rh / rw) > MAX_RATIO)
    return status(`Пропорции прямоугольника: положительные числа, не шире ${MAX_RATIO}:1.`);
  const color = paletteColor,
    ids = await loadFiles([rectFile(rw, rh, color)]);
  for (const f of flags) if (ids.includes(f.id)) f.rect = { color, w: rw, h: rh };
  fitTextures();
  scheduleCommit(0);
};
$("recolor").onclick = async (e) => {
  const b = e.target.closest("[data-color]"),
    list = selectedFlags().filter((f) => f.rect);
  if (!b || busy || loading || !list.length) return;
  loading = true;
  try {
    for (const f of list) {
      const file = rectFile(f.rect.w, f.rect.h, b.dataset.color),
        d = await decodeFile(file);
      Object.assign(f, { image: d.image, svgImage: d.svgImage, shapes: d.shapes, reason: d.reason, source: { name: file.name, blob: file } }, makeAlpha(d.image));
      if (f.name.startsWith("Прямоугольник")) f.name = file.name.replace(/\.svg$/i, "");
      f.rect = { ...f.rect, color: b.dataset.color };
    }
  } catch (err) {
    status(err.message);
  } finally {
    loading = false;
    fitTextures();
    sync();
    scheduleCommit(0);
  }
};

// ---------- Own presets (cloth + wind), kept in this browser ----------
const presetKeys = ["stiffness", "mass", "damping", "gravity", "strength", "turbulence", "angle", "wind"];
function loadPresets() {
  try {
    return JSON.parse(localStorage.getItem("cloth-presets") || "[]");
  } catch {
    return [];
  }
}
function storePresets(list) {
  try {
    localStorage.setItem("cloth-presets", JSON.stringify(list));
  } catch {}
  renderPresets();
}
function renderPresets() {
  const host = $("userPresets");
  host.replaceChildren();
  loadPresets().forEach((preset, i) => {
    const chip = document.createElement("span"),
      apply = document.createElement("button"),
      remove = document.createElement("button");
    chip.className = "user-preset";
    apply.textContent = preset.name;
    apply.title = "Применить пресет к выбранным флагам";
    apply.onclick = () => {
      if (busy) return;
      for (const key of presetKeys) for (const t of optionTargets(key)) if (preset.values[key] !== undefined) t[key] = preset.values[key];
      sync();
    };
    remove.textContent = "×";
    remove.setAttribute("aria-label", "Удалить пресет " + preset.name);
    remove.onclick = () => storePresets(loadPresets().filter((_, j) => j !== i));
    chip.append(apply, remove);
    host.append(chip);
  });
}
$("presetSave").onclick = () => {
  const f = primary(),
    name = $("presetName").value.trim();
  if (!f) return status("Выберите флаг, чьи настройки сохранить.");
  if (!name) return status("Введите название пресета.");
  const source = { ...f.options, ...(scene.globalWind ? scene.wind : {}) };
  storePresets([...loadPresets().filter((p) => p.name !== name), { name, values: Object.fromEntries(presetKeys.map((k) => [k, source[k]])) }]);
  $("presetName").value = "";
  status("Пресет «" + name + "» сохранён.");
};
renderPresets();

// ---------- Panels ----------
for (const [id, cls] of [
  ["toggleLeft", "hide-left"],
  ["toggleRight", "hide-right"],
]) {
  const app = document.querySelector(".app");
  try {
    if (localStorage.getItem("cloth-" + cls) === "1") app.classList.add(cls);
  } catch {}
  $(id).onclick = () => {
    const on = app.classList.toggle(cls);
    try {
      localStorage.setItem("cloth-" + cls, on ? "1" : "0");
    } catch {}
  };
}
// ---------- Simulation: cloth steps run in a pool of background workers ----------
const pool = { workers: [], ok: true, seq: 0, pending: new Map() };
let simEpoch = 0,
  stepping = false;
const touchSim = () => simEpoch++;
try {
  const n = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  for (let i = 0; i < n; i++) {
    const w = new Worker("./physics-worker.mjs", { type: "module" });
    w.onmessage = ({ data }) => {
      pool.pending.get(data.seq)?.(data.out);
      pool.pending.delete(data.seq);
    };
    w.onerror = () => {
      pool.ok = false;
      for (const resolve of pool.pending.values()) resolve(null);
      pool.pending.clear();
    };
    pool.workers.push(w);
  }
} catch {
  pool.ok = false;
}
function stepSync(steps, dt) {
  const wind = scene.globalWind ? scene.wind : null;
  for (let i = 0; i < steps; i++)
    stepFlags(
      flags.filter((f) => f.visible),
      dt,
      wind,
    );
}
// Advances every visible, unpaused flag by `steps` fixed steps. Results that arrive after the
// scene was changed on the page (reset, scrub, undo…) are dropped.
async function stepAsync(steps = 1, dt = 1 / 60) {
  resumeTimeline();
  const epoch = simEpoch,
    active = flags.filter((f) => f.visible && f.animationEnabled !== false);
  if (!pool.ok || !pool.workers.length) stepSync(steps, dt);
  else if (active.length) {
    const wind = scene.globalWind ? scene.wind : null,
      alive = flags.map((f) => f.id),
      batches = pool.workers.map(() => []),
      sent = new Map();
    for (const f of active) {
      const c = f.cloth,
        params = [c.aspect, f.resolution, f.edge, f.pin || "edge"];
      sent.set(f.id, c);
      batches[f.id % batches.length].push({
        id: f.id,
        key: params.join("|"),
        params,
        options: wind ? { ...f.options, ...wind } : { ...f.options },
        p: c.p.slice(),
        v: c.v.slice(),
        time: c.time,
      });
    }
    const results = await Promise.all(
      batches.map((jobs, i) =>
        jobs.length
          ? new Promise((resolve) => {
              const seq = ++pool.seq;
              pool.pending.set(seq, resolve);
              pool.workers[i].postMessage(
                { seq, jobs, steps, dt, alive },
                jobs.flatMap((j) => [j.p.buffer, j.v.buffer]),
              );
            })
          : [],
      ),
    );
    if (results.some((r) => r === null)) {
      if (epoch === simEpoch) stepSync(steps, dt);
    } else {
      if (epoch !== simEpoch) return false;
      for (const o of results.flat()) {
        const f = flags.find((x) => x.id === o.id);
        if (!f || f.cloth !== sent.get(o.id) || f.cloth.p.length !== o.p.length) continue;
        f.cloth.p.set(o.p);
        f.cloth.v.set(o.v);
        f.cloth.normals.set(o.normals);
        f.cloth.time = o.time;
      }
    }
  }
  if (epoch !== simEpoch) return false;
  elapsed += dt * steps;
  recordFrame(steps);
  return true;
}
// SVG flags keep their source image and are re-rasterized to match their size on the canvas:
// small flags and solid rectangles use small textures, large flags stay sharp.
const TEXTURE_STEPS = [64, 256, 512, 1024, 2048, 4096];
function fitTextures() {
  const used = new Map();
  for (const f of flags) {
    const src = f.svgImage;
    if (!src) continue;
    const aspect = src.width / src.height,
      longSide = f.width * Math.max(1, 1 / aspect),
      k = 1.5 * Math.max(1, 2160 / Math.max(scene.width, scene.height)),
      wanted = f.rect ? 64 : TEXTURE_STEPS.find((s) => s >= longSide * k) || 4096;
    src.textures ||= new Map();
    if (!src.textures.has(wanted)) src.textures.set(wanted, rasterizeSVG(src, wanted));
    f.image = src.textures.get(wanted);
    if (!used.has(src)) used.set(src, new Set());
    used.get(src).add(wanted);
  }
  for (const [src, sizes] of used) for (const size of [...src.textures.keys()]) if (!sizes.has(size)) src.textures.delete(size);
}
$("settle").onclick = async () => {
  if (busy || loading || !flags.length) return;
  cancel = false;
  lock(true, "Проматываю симуляцию…");
  try {
    for (let i = 0; i < 6 && !cancel; i++) {
      await stepAsync(30);
      status(`Проматываю симуляцию: ${Math.round(((i + 1) / 6) * 100)}%`);
    }
    status("Промотано 3 секунды.");
  } finally {
    clearTimeline();
    lock(false);
    draw();
  }
};
// ---------- Timeline: recent simulation frames for scrubbing ----------
const timeline = { frames: [], bytes: 0, index: null, tick: 0 };
function clearTimeline() {
  timeline.frames = [];
  timeline.bytes = 0;
  timeline.index = null;
}
function recordFrame(steps = 1) {
  if (busy || (timeline.tick += steps) < 2) return;
  timeline.tick = 0;
  const states = new Map();
  let bytes = 0;
  for (const f of flags) {
    if (f.animationEnabled === false || !f.visible) continue;
    states.set(f.cloth, { p: f.cloth.p.slice(), time: f.cloth.time });
    bytes += f.cloth.p.byteLength;
  }
  timeline.frames.push({ elapsed, states, bytes });
  timeline.bytes += bytes;
  while (timeline.frames.length > 900 || timeline.bytes > 96e6) timeline.bytes -= timeline.frames.shift().bytes;
}
function applyFrame(i) {
  const frame = timeline.frames[i];
  if (!frame) return;
  for (const f of flags) {
    const s = frame.states.get(f.cloth);
    if (!s) continue;
    f.cloth.p.set(s.p);
    f.cloth.time = s.time;
    f.cloth.computeNormals();
  }
  touchSim();
  elapsed = frame.elapsed;
  timeline.index = i;
  draw();
}
// Continue the simulation from the scrubbed frame: velocities come from the previous frame.
function resumeTimeline() {
  const i = timeline.index;
  if (i == null) return;
  timeline.index = null;
  const frame = timeline.frames[i],
    prev = timeline.frames[i - 1],
    dt = prev ? frame.elapsed - prev.elapsed : 0;
  for (const f of flags) {
    const s = frame?.states.get(f.cloth);
    if (!s) continue;
    const q = dt > 1e-6 ? prev.states.get(f.cloth) : null;
    if (q) for (let k = 0; k < s.p.length; k++) f.cloth.v[k] = (s.p[k] - q.p[k]) / dt;
    else f.cloth.v.fill(0);
  }
  for (const dropped of timeline.frames.splice(i + 1)) timeline.bytes -= dropped.bytes;
}
function updateTimeline() {
  const t = $("timeline"),
    max = Math.max(0, timeline.frames.length - 1);
  t.disabled = busy || max < 1;
  if (+t.max !== max) t.max = max;
  const value = timeline.index ?? max;
  if (+t.value !== value) t.value = value;
}
$("timeline").oninput = () => {
  if (busy) return;
  if (playing) play(false);
  applyFrame(+$("timeline").value);
};

// ---------- Undo / redo ----------
const history = { list: [], index: -1, timer: 0 },
  knownVideos = new Set();
function stateKey() {
  return JSON.stringify([
    scene.width,
    scene.height,
    scene.background,
    scene.globalWind,
    scene.wind,
    scene.groups,
    flags.map((f) => [f.id, flagProps(f)]),
  ]);
}
function takeSnapshot() {
  return {
    key: stateKey(),
    scene: {
      width: scene.width,
      height: scene.height,
      background: scene.background,
      globalWind: scene.globalWind,
      wind: { ...scene.wind },
      groups: structuredClone(scene.groups),
    },
    enteredGroup,
    flags: flags.map((flag) => ({
      flag,
      props: flagProps(flag),
      assets: {
        image: flag.image,
        svgImage: flag.svgImage,
        shapes: flag.shapes,
        reason: flag.reason,
        source: flag.source,
        thumbnail: flag.thumbnail,
        alpha: flag.alpha,
      },
    })),
    selection: [...selection],
    selectedId,
  };
}
function gcVideos() {
  const used = new Set(flags.map((f) => f.image));
  for (const s of history.list) for (const { flag } of s.flags) used.add(flag.image);
  for (const v of knownVideos)
    if (!used.has(v)) {
      disposeVideo(v);
      knownVideos.delete(v);
    }
}
function updateHistoryButtons() {
  $("undo").disabled = busy || history.index <= 0;
  $("redo").disabled = busy || history.index >= history.list.length - 1;
}
function scheduleCommit(delay = 350) {
  clearTimeout(history.timer);
  history.timer = setTimeout(commit, delay);
}
function commit() {
  clearTimeout(history.timer);
  if (busy || loading || pointer) return scheduleCommit();
  const current = history.list[history.index];
  if (current?.key === stateKey()) {
    current.selection = [...selection];
    current.selectedId = selectedId;
    return;
  }
  fitTextures();
  history.list.length = history.index + 1;
  history.list.push(takeSnapshot());
  if (history.list.length > 100) history.list.shift();
  history.index = history.list.length - 1;
  gcVideos();
  updateHistoryButtons();
  scheduleAutosave();
}
function resetHistory() {
  history.list = [];
  history.index = -1;
  commit();
}
function applySnapshot(s) {
  Object.assign(scene, s.scene, { wind: { ...s.scene.wind }, groups: structuredClone(s.scene.groups || {}) });
  enteredGroup = s.enteredGroup ?? null;
  $("sceneWidth").value = scene.width;
  $("sceneHeight").value = scene.height;
  flags = s.flags.map(({ flag, props, assets }) => {
    Object.assign(flag, assets);
    const rebuild =
      flag.edge !== props.edge || flag.resolution !== props.resolution || (flag.pin || "edge") !== (props.pin || "edge");
    Object.assign(flag, props, { options: { ...props.options } });
    if (rebuild) rebuildFlag(flag);
    return flag;
  });
  setSelection(
    s.selection.filter((id) => flags.some((f) => f.id === id)),
    s.selectedId,
  );
  setBackground(scene.background);
  sync();
  layout();
  updateMedia();
  updateHistoryButtons();
  scheduleAutosave();
}
function undo(direction = -1) {
  if (busy || loading || pointer) return;
  commit();
  const target = history.list[history.index + direction];
  if (!target) return;
  history.index += direction;
  applySnapshot(target);
  status(direction < 0 ? "Отменено." : "Возвращено.");
}
$("undo").onclick = () => undo(-1);
$("redo").onclick = () => undo(1);
for (const type of ["pointerup", "keyup", "change", "input"])
  document.addEventListener(type, () => scheduleCommit(), true);

// ---------- Project: autosave in the browser and .cloth files ----------
const canvasBlob = (c) => new Promise((resolve) => c.toBlob(resolve, "image/png"));
async function serializeProject() {
  const sources = [],
    index = new Map(),
    items = [];
  for (const f of flags) {
    if (!f.source && f.image instanceof HTMLCanvasElement)
      f.source = { name: "Растровый текст.png", blob: await canvasBlob(f.image) };
    if (!f.source?.blob) continue;
    if (!index.has(f.source.blob)) {
      index.set(f.source.blob, sources.length);
      sources.push({ name: f.source.name, type: f.source.blob.type, blob: f.source.blob });
    }
    items.push({
      source: index.get(f.source.blob),
      ...flagProps(f),
      cloth: { p: f.cloth.p.slice(), v: f.cloth.v.slice(), time: f.cloth.time },
    });
  }
  return {
    app: "cloth-vector-lab",
    version: 1,
    scene: {
      width: scene.width,
      height: scene.height,
      background: scene.background,
      shade: scene.shade,
      speed: scene.speed,
      globalWind: scene.globalWind,
      wind: { ...scene.wind },
      groups: structuredClone(scene.groups),
    },
    sources,
    flags: items,
  };
}
async function restoreProject(data) {
  if (data?.app !== "cloth-vector-lab" || !Array.isArray(data.flags)) throw new Error("Это не файл проекта Cloth.");
  loading = true;
  updateButtons();
  const errors = [];
  try {
    flags = [];
    setSelection([]);
    clearTimeline();
    Object.assign(scene, data.scene, {
      wind: { ...scene.wind, ...data.scene.wind },
      groups: structuredClone(data.scene.groups || {}),
      wire: scene.wire,
    });
    enteredGroup = null;
    $("sceneWidth").value = scene.width;
    $("sceneHeight").value = scene.height;
    $("shade").checked = !!scene.shade;
    $("speed").value = String(scene.speed);
    if (!$("speed").value) $("speed").value = String((scene.speed = 1));
    const decoded = [];
    for (const src of data.sources) {
      try {
        const file = new File([src.blob], src.name, { type: src.type || src.blob.type });
        decoded.push({ ...(await decodeFile(file)), source: { name: src.name, blob: src.blob }, used: false });
      } catch (e) {
        decoded.push(null);
        errors.push(src.name + ": " + e.message);
      }
    }
    for (const item of data.flags.slice(0, MAX_FLAGS)) {
      const d = decoded[item.source];
      if (!d) continue;
      let image = d.image;
      try {
        if (isVideo(image) && d.used) image = await cloneVideo(image);
      } catch (e) {
        errors.push(item.name + ": " + e.message);
        continue;
      }
      d.used = true;
      const f = addImage(image, item.name, d.shapes, d.reason, { select: false });
      Object.assign(f, {
        source: d.source,
        svgImage: d.svgImage,
        ...Object.fromEntries(FLAG_PROPS.filter((k) => item[k] !== undefined).map((k) => [k, item[k]])),
        roll: item.roll || 0,
        visible: item.visible !== false,
        animationEnabled: item.animationEnabled !== false,
        options: { ...clothDefaults, ...item.options },
      });
      rebuildFlag(f);
      if (item.cloth?.p?.length === f.cloth.p.length) {
        f.cloth.p.set(item.cloth.p);
        f.cloth.v.set(item.cloth.v);
        f.cloth.time = item.cloth.time || 0;
        f.cloth.computeNormals();
      }
    }
  } finally {
    loading = false;
    setBackground(scene.background);
    sync();
    layout();
    updateMedia();
  }
  return errors;
}
const idb = (mode, run) =>
  new Promise((resolve, reject) => {
    const open = indexedDB.open("cloth-vector-lab", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("kv", mode),
        request = run(tx.objectStore("kv"));
      tx.oncomplete = () => {
        open.result.close();
        resolve(request.result);
      };
      tx.onerror = tx.onabort = () => {
        open.result.close();
        reject(tx.error);
      };
    };
  });
let autosaveTimer = 0,
  autosaveReady = false;
function scheduleAutosave() {
  if (!autosaveReady) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(async () => {
    if (busy || loading) return scheduleAutosave();
    try {
      const data = await serializeProject();
      await idb("readwrite", (store) => store.put(data, "autosave"));
    } catch (e) {
      console.warn("Autosave failed", e);
    }
  }, 1200);
}
const toBase64 = (bytes) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
$("saveProject").onclick = async () => {
  if (busy || loading) return;
  try {
    const data = await serializeProject(),
      skipped = [];
    const sources = [];
    for (const s of data.sources) {
      const big = s.blob.size > 60 * 1024 * 1024;
      if (big) skipped.push(s.name);
      sources.push({
        name: s.name,
        type: s.type,
        data: big ? null : toBase64(new Uint8Array(await s.blob.arrayBuffer())),
      });
    }
    const file = {
      ...data,
      sources,
      flags: data.flags.map((f) => ({
        ...f,
        cloth: {
          time: f.cloth.time,
          p: toBase64(new Uint8Array(f.cloth.p.buffer)),
          v: toBase64(new Uint8Array(f.cloth.v.buffer)),
        },
      })),
    };
    download(new Blob([JSON.stringify(file)], { type: "application/json" }), "cloth-project.cloth");
    status(
      "Проект сохранён в файл." +
        (skipped.length ? " Не вошли файлы больше 60 МБ: " + skipped.join(", ") + "." : ""),
    );
  } catch (e) {
    status("Не удалось сохранить проект: " + e.message);
  }
};
$("openProject").onclick = () => $("projectFile").click();
$("projectFile").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || busy || loading) return;
  try {
    const data = JSON.parse(await file.text());
    if (data?.app !== "cloth-vector-lab") throw new Error("Это не файл проекта Cloth.");
    data.sources = data.sources.map((s) => ({
      name: s.name,
      type: s.type,
      blob: new Blob([s.data ? fromBase64(s.data) : new Uint8Array()], { type: s.type }),
    }));
    for (const f of data.flags)
      if (f.cloth) {
        f.cloth.p = new Float32Array(fromBase64(f.cloth.p).buffer);
        f.cloth.v = new Float32Array(fromBase64(f.cloth.v).buffer);
      }
    const errors = await restoreProject(data);
    resetHistory();
    status("Проект открыт: флагов — " + flags.length + ". " + errors.join(" "));
  } catch (e) {
    status("Не удалось открыть проект: " + (e instanceof SyntaxError ? "файл повреждён." : e.message));
  }
};
$("newProject").onclick = () => {
  if (busy || loading || !flags.length) return;
  setSelection(flags.map((f) => f.id));
  deleteSelection();
  clearTimeline();
  status("Сцена очищена. Cmd/Ctrl+Z вернёт флаги.");
  scheduleCommit(0);
};
$("copyVector").onclick = async () => {
  const b = $("copyVector");
  try {
    await navigator.clipboard.writeText(vectorText);
    b.textContent = "Скопировано ✓";
  } catch {
    b.textContent = "Не удалось скопировать";
  }
  setTimeout(() => (b.textContent = "Копировать SVG"), 2200);
};
// ---------- Named scenes stored in this browser ----------
async function refreshScenes() {
  const host = $("sceneList");
  let keys = [];
  try {
    keys = (await idb("readonly", (store) => store.getAllKeys())).filter((k) => String(k).startsWith("scene:"));
  } catch {}
  host.replaceChildren();
  for (const key of keys) {
    const row = document.createElement("div"),
      open = document.createElement("button"),
      remove = document.createElement("button"),
      name = key.slice(6);
    row.className = "scene-row";
    open.textContent = name;
    open.title = "Открыть сцену";
    open.onclick = async () => {
      if (busy || loading) return;
      try {
        const errors = await restoreProject(await idb("readonly", (store) => store.get(key)));
        resetHistory();
        $("projectMenu").open = false;
        status("Открыта сцена «" + name + "». " + errors.join(" "));
      } catch (e) {
        status("Не удалось открыть сцену: " + e.message);
      }
    };
    remove.textContent = "×";
    remove.setAttribute("aria-label", "Удалить сцену " + name);
    remove.onclick = async () => {
      await idb("readwrite", (store) => store.delete(key));
      refreshScenes();
    };
    row.append(open, remove);
    host.append(row);
  }
}
$("sceneSave").onclick = async () => {
  const name = $("sceneName").value.trim();
  if (busy || loading) return;
  if (!name) return status("Введите название сцены.");
  try {
    const data = await serializeProject();
    await idb("readwrite", (store) => store.put(data, "scene:" + name));
    $("sceneName").value = "";
    status("Сцена «" + name + "» сохранена в этом браузере.");
    refreshScenes();
  } catch (e) {
    status("Не удалось сохранить сцену: " + e.message);
  }
};
refreshScenes();
async function startup() {
  let restored = false;
  try {
    const saved = await idb("readonly", (store) => store.get("autosave"));
    if (saved?.flags?.length) {
      const errors = await restoreProject(saved);
      restored = flags.length > 0;
      if (restored) status("Восстановлена сохранённая сцена. " + errors.join(" "));
    }
  } catch (e) {
    console.warn("Autosave restore failed", e);
  }
  if (!restored && !flags.length)
    await loadFiles([new File([vectorDemo], "Демо-флаг.svg", { type: "image/svg+xml" })]);
  autosaveReady = true;
  resetHistory();
}
canvas.addEventListener("webglcontextlost", (e) => {
  e.preventDefault();
  play(false);
  renderer = null;
  $("rendererNotice").hidden = false;
  $("rendererNotice").textContent =
    "Графический контекст потерян. Сохраните SVG и перезагрузите страницу для живого превью.";
  updateButtons();
});
try {
  renderer = new Renderer(canvas);
} catch (e) {
  $("rendererNotice").hidden = false;
  $("rendererNotice").textContent = e.message;
}
sync();
layout();
startup();
requestAnimationFrame(loop);
