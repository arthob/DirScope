const TOKEN = new URLSearchParams(location.search).get("t") || "";
const $ = id => document.getElementById(id);
const PALETTE = ["#3b82f6", "#ef5a4c", "#22b07d", "#f2a93b", "#9b6ff0", "#2fb5cc",
  "#e86fae", "#86b83a", "#f07f3c", "#5c6ff0", "#cfc43e", "#4aa595"];
const OTHER = [150, 158, 168], FOLDER = [118, 128, 140], SMALL = [96, 104, 114];

const st = {
  status: null, zoom: 0, zoomChain: [], zoomPath: "", selected: null,
  folders: new Map(), open: new Set([0]), rows: [],
  exts: [], extColor: new Map(), highlight: null, map: null, hit: null, hover: -1,
  tree: null, view3d: false,
};

async function api(path, body) {
  const res = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-Token": TOKEN, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];
function bytes(n) {
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n < 10 ? 2 : n < 100 ? 1 : 0)) + " " + UNITS[i];
}
const count = n => n.toLocaleString();
const pct = (a, b) => b ? (100 * a / b) : 0;
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));

function show(view) {
  for (const v of ["start", "scan", "result"]) $("view-" + v).hidden = v !== view;
  $("actions").hidden = view !== "result";
  if (view !== "result") $("crumbs").replaceChildren();
}

// --- start ---------------------------------------------------------------

async function showStart() {
  show("start");
  $("status-left").textContent = "";
  $("status-right").textContent = "";
  const drives = await api("drives");
  $("drives").replaceChildren(...drives.map(d => {
    const used = d.total - d.free, b = document.createElement("button");
    b.className = "drive";
    b.innerHTML = `<div class="drive-name">${d.path.slice(0, 2)} <span></span></div>
      <div class="drive-meter${used / d.total > 0.9 ? " full" : ""}"><i style="width:${pct(used, d.total)}%"></i></div>
      <div class="drive-free">${bytes(d.free)} free of ${bytes(d.total)}</div>`;
    b.querySelector(".drive-name span").textContent = d.label || "Local disk";
    b.onclick = () => startScan(d.path);
    return b;
  }));
}

async function startScan(path) {
  $("start-error").textContent = "";
  try {
    await api("scan", { path });
  } catch (e) {
    $("start-error").textContent = e.message;
    return showStart();
  }
  st.folders.clear(); st.open = new Set([0]); st.selected = null; st.zoom = 0; st.highlight = null;
  pollScan();
}

async function pollScan() {
  show("scan");
  const s = await api("status");
  st.status = s;
  $("scan-root").textContent = s.root;
  $("scan-bytes").textContent = bytes(s.bytes);
  $("scan-stats").textContent = `${count(s.files)} files · ${count(s.dirs)} folders · ` +
    `${count(Math.round(s.files / Math.max(s.elapsed, 0.1)))} files/s`;
  $("scan-current").textContent = s.current;
  if (s.state === "scanning") return setTimeout(pollScan, 250);
  if (s.state === "done") return showResult();
  showStart();
}

// --- result --------------------------------------------------------------

async function showResult() {
  show("result");
  st.exts = await api("extensions");
  st.extColor = new Map(st.exts.map((e, i) => [e.id, i < PALETTE.length ? rgb(PALETTE[i]) : OTHER]));
  await refreshTree();
  renderLegend();
  await zoomTo(st.zoom);
  renderStatus();
}

function colorOf(ext) {
  if (ext === -1) return FOLDER;
  if (ext === -2) return SMALL;
  return st.extColor.get(ext) || OTHER;
}

function renderStatus() {
  const s = st.status;
  $("status-left").textContent = `${s.root}  ·  ${bytes(s.bytes)} in ${count(s.files)} files, ` +
    `${count(s.dirs)} folders  ·  scanned in ${s.elapsed.toFixed(1)} s` +
    (s.errors ? `  ·  ${count(s.errors)} items could not be read` : "");
  const sel = st.selected;
  $("status-right").textContent = sel ? `${sel.name}  ·  ${bytes(sel.size)}` : "";
  $("btn-reveal").disabled = !sel;
  $("btn-delete").disabled = !sel || sel.id === 0;
}

// Tree panel: folders are fetched on first expand and refetched after a delete.
async function folder(id) {
  if (!st.folders.has(id)) st.folders.set(id, await api("folder?id=" + id));
  return st.folders.get(id);
}

async function refreshTree() {
  st.folders.clear();
  for (const id of st.open) { try { await folder(id); } catch { st.open.delete(id); } }
  renderTree();
}

function renderTree() {
  const rows = [], out = [];
  (function walk(f, depth) {
    for (const c of f.children) {
      rows.push({ ...c, depth, parentSize: f.size });
      if (c.dir && st.open.has(c.id) && st.folders.has(c.id)) walk(st.folders.get(c.id), depth + 1);
    }
    if (f.more) rows.push({ more: f.more, depth });
  })({ children: [st.folders.get(0)], size: st.folders.get(0).size }, 0);
  st.rows = rows.filter(r => !r.more);
  for (const r of rows) {
    const el = document.createElement("div");
    if (r.more) {
      el.className = "more";
      el.style.paddingLeft = 12 + (r.depth * 16 + 24) + "px";
      el.textContent = `and ${count(r.more)} smaller items`;
      out.push(el);
      continue;
    }
    el.className = "row" + (st.selected && st.selected.id === r.id ? " selected" : "");
    el.dataset.id = r.id;
    el.setAttribute("role", "treeitem");
    if (r.dir) el.setAttribute("aria-expanded", st.open.has(r.id));
    el.style.setProperty("--depth", r.depth);
    const sw = r.dir ? "" : `background:rgb(${colorOf(r.ext).join(",")})`;
    el.innerHTML = `<span class="name"><button class="chev${r.dir ? (st.open.has(r.id) ? " open" : "") : " none"}"
      tabindex="-1" aria-label="Expand">&#9654;</button><i class="swatch${r.dir ? " folder" : ""}" style="${sw}"></i>
      <span></span></span><span class="size"><span class="meter"><i style="width:${pct(r.size, r.parentSize)}%"></i></span>${bytes(r.size)}</span>
      <span class="files">${r.dir ? count(r.files) : ""}</span>`;
    el.querySelector(".name span").textContent = r.name;
    el.title = `${pct(r.size, r.parentSize).toFixed(1)}% of parent`;
    out.push(el);
  }
  $("tree").replaceChildren(...out);
}

async function toggle(id, force) {
  const open = force ?? !st.open.has(id);
  if (open) { await folder(id); st.open.add(id); } else st.open.delete(id);
  renderTree();
}

// Toggles a class rather than re-rendering, so a double-click lands on the same row twice.
function select(row) {
  st.selected = row;
  for (const el of document.querySelectorAll(".row.selected")) el.classList.remove("selected");
  const el = document.querySelector(`.row[data-id="${row && row.id}"]`);
  if (el) { el.classList.add("selected"); el.scrollIntoView({ block: "nearest" }); }
  renderStatus();
  drawOverlay();
  if (st.view3d && Scape3D.ready) Scape3D.select(row && row.id);
}

// Expands every ancestor so a node picked on the treemap is visible in the tree.
async function reveal(id) {
  const chain = await api("ancestry?id=" + id);
  for (const a of chain.slice(0, -1)) { await folder(a.id); st.open.add(a.id); }
  renderTree();
  const parent = chain.length > 1 ? st.folders.get(chain[chain.length - 2].id) : null;
  const row = parent ? parent.children.find(c => c.id === id) : st.folders.get(0);
  select(row || { id, name: chain[chain.length - 1].name, size: 0 });
}

function renderLegend() {
  const total = st.exts.reduce((a, e) => a + e.bytes, 0);
  $("legend").replaceChildren(...st.exts.slice(0, 40).map(e => {
    const b = document.createElement("button");
    b.className = "ext" + (st.highlight === e.id ? " active" : "");
    b.innerHTML = `<i class="swatch" style="background:rgb(${colorOf(e.id).join(",")})"></i><span></span>
      <span>${bytes(e.bytes)}</span><span class="muted">${pct(e.bytes, total).toFixed(1)}%</span>
      <span class="muted">${count(e.count)}</span>`;
    b.children[1].textContent = e.ext;
    b.title = st.highlight === e.id ? "Click to clear the highlight" : "Highlight these files on the map";
    b.onclick = () => { st.highlight = st.highlight === e.id ? null : e.id; renderLegend(); drawMap(); };
    return b;
  }));
}

// --- treemap -------------------------------------------------------------

async function zoomTo(id) {
  st.zoom = id;
  st.zoomChain = await api("ancestry?id=" + id);
  $("crumbs").replaceChildren(...st.zoomChain.flatMap((a, i) => {
    const b = document.createElement("button");
    b.textContent = i === 0 ? a.name.replace(/\\$/, "") || a.name : a.name;
    b.onclick = () => zoomTo(a.id);
    if (i === 0) return [b];
    const sep = document.createElement("span");
    sep.className = "sep";
    sep.textContent = "›";
    return [sep, b];
  }));
  await loadMap();
}

let mapSize = [0, 0];
async function loadMap() {
  const wrap = $("map-wrap"), dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(wrap.clientWidth * dpr)), h = Math.max(1, Math.round(wrap.clientHeight * dpr));
  mapSize = [w, h];
  const data = await api(`treemap?id=${st.zoom}&px=${w * h}`);
  st.zoomPath = data.path;
  st.tree = data.tree;
  $("map-empty").hidden = data.tree[2] > 0;
  st.map = data.tree[2] > 0 ? Treemap.layout(data.tree, w, h) : { leaves: [], rects: new Map() };
  drawMap();
  if (st.view3d) build3d();
}

// The 3D view reuses the same pruned tree, so both views show the same partition.
function build3d() {
  if (!Scape3D.ready) {
    Scape3D.mount($("scape"), {
      colorOf,
      onPick: node => reveal(leafId(node)),
      onHover: (box, ev) => box ? placeTip(box.node, ev) : ($("tip").hidden = true),
    });
  }
  Scape3D.resize();
  Scape3D.build(st.tree);
  if (st.selected) Scape3D.select(st.selected.id);
}

function setView(on3d) {
  st.view3d = on3d;
  $("btn-2d").classList.toggle("on", !on3d);
  $("btn-3d").classList.toggle("on", on3d);
  $("btn-2d").setAttribute("aria-pressed", String(!on3d));
  $("btn-3d").setAttribute("aria-pressed", String(on3d));
  for (const id of ["map", "overlay"]) $(id).hidden = on3d;
  $("scape").hidden = !on3d;
  $("scape-hint").hidden = !on3d;
  $("tip").hidden = true;
  if (on3d) { build3d(); Scape3D.start(); } else Scape3D.stop();
}

function drawMap() {
  const [w, h] = mapSize;
  for (const c of [$("map"), $("overlay")]) { c.width = w; c.height = h; }
  const ctx = $("map").getContext("2d");
  ctx.clearRect(0, 0, w, h);
  const dim = st.highlight === null ? null : n => n[3] !== st.highlight;
  st.hit = Treemap.paint(ctx, w, h, st.map, n => colorOf(n[3]), dim);
  drawOverlay();
}

function drawOverlay() {
  const c = $("overlay"), ctx = c.getContext("2d"), dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, c.width, c.height);
  const box = (r, color, width) => {
    if (!r) return;
    ctx.lineWidth = width * dpr;
    ctx.strokeStyle = color;
    ctx.strokeRect(r[0] + ctx.lineWidth / 2, r[1] + ctx.lineWidth / 2,
      Math.max(0, r[2] - ctx.lineWidth), Math.max(0, r[3] - ctx.lineWidth));
  };
  const hov = st.map && st.map.leaves[st.hover];
  if (hov) box([hov.x, hov.y, hov.w, hov.h], "rgba(255,255,255,0.85)", 1);
  if (st.selected && st.map) {
    const r = st.map.rects.get(st.selected.id);
    box(r, "rgba(0,0,0,0.65)", 4);
    box(r, "#ffffff", 2);
  }
}

function leafAt(ev) {
  if (!st.hit) return -1;
  const r = $("overlay").getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const x = Math.floor((ev.clientX - r.left) * dpr), y = Math.floor((ev.clientY - r.top) * dpr);
  if (x < 0 || y < 0 || x >= mapSize[0] || y >= mapSize[1]) return -1;
  return st.hit[y * mapSize[0] + x];
}

function leafPath(n) {
  const parts = [];
  for (let p = n.parent; p && p.parent; p = p.parent) parts.unshift(p[1]);
  return [st.zoomPath.replace(/\\$/, ""), ...parts].join("\\");
}

function moveTip(ev) {
  const i = leafAt(ev);
  if (i !== st.hover) { st.hover = i; drawOverlay(); }
  const leaf = st.map && st.map.leaves[i];
  if (!leaf) { $("tip").hidden = true; return; }
  placeTip(leaf.node, ev);
}

function placeTip(n, ev) {
  const tip = $("tip");
  const kind = n[3] === -2 ? "Small items, grouped" : n[3] === -1 ? "Folder" : "File";
  tip.innerHTML = "<strong></strong><span></span><span></span>";
  tip.children[0].textContent = n[3] === -2 ? n.parent[1] : n[1];
  tip.children[1].textContent = `${bytes(n[2])}  ·  ${kind}`;
  tip.children[2].textContent = leafPath(n);
  tip.hidden = false;
  const wrap = $("map-wrap").getBoundingClientRect();
  let x = ev.clientX - wrap.left + 14, y = ev.clientY - wrap.top + 14;
  if (x + tip.offsetWidth > wrap.width) x = ev.clientX - wrap.left - tip.offsetWidth - 14;
  if (y + tip.offsetHeight > wrap.height) y = ev.clientY - wrap.top - tip.offsetHeight - 14;
  tip.style.left = Math.max(4, x) + "px";
  tip.style.top = Math.max(4, y) + "px";
}

// A grouped "small items" block stands for its folder.
const leafId = n => n[3] === -2 ? n.parent[0] : n[0];

// --- actions -------------------------------------------------------------

async function recycle() {
  const sel = st.selected;
  if (!sel || sel.id === 0) return;
  const chain = await api("ancestry?id=" + sel.id);
  $("confirm-name").textContent = `${sel.name}  ·  ${bytes(sel.size)}`;
  $("confirm-path").textContent = chain.map(a => a.name.replace(/\\$/, "")).join("\\");
  $("confirm").returnValue = "";
  $("confirm").showModal();
  $("confirm").onclose = async () => {
    if ($("confirm").returnValue !== "ok") return;
    try {
      const r = await api("delete", { id: sel.id });
      st.open.delete(sel.id);
      if (st.zoomChain.some(a => a.id === sel.id)) st.zoom = r.parent;
      st.selected = null;
      st.status = await api("status");
      await showResult();
      await reveal(r.parent);
    } catch (e) {
      alert(e.message);
    }
  };
}

$("tree").addEventListener("click", ev => {
  const el = ev.target.closest(".row");
  if (!el) return;
  const row = st.rows.find(r => r.id === +el.dataset.id);
  if (ev.target.closest(".chev")) return toggle(row.id);
  select(row);
});
$("tree").addEventListener("dblclick", ev => {
  const el = ev.target.closest(".row");
  const row = el && st.rows.find(r => r.id === +el.dataset.id);
  if (row && row.dir) zoomTo(row.id);
});
$("tree").addEventListener("keydown", ev => {
  const i = st.rows.findIndex(r => st.selected && r.id === st.selected.id), row = st.rows[i];
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    const next = st.rows[Math.max(0, Math.min(st.rows.length - 1, i + (ev.key === "ArrowDown" ? 1 : -1)))];
    if (next) select(next);
  } else if (row && ev.key === "ArrowRight" && row.dir) toggle(row.id, true);
  else if (row && ev.key === "ArrowLeft" && row.dir) toggle(row.id, false);
  else if (row && ev.key === "Enter" && row.dir) zoomTo(row.id);
  else return;
  ev.preventDefault();
});

$("overlay").addEventListener("mousemove", moveTip);
$("overlay").addEventListener("mouseleave", () => { st.hover = -1; $("tip").hidden = true; drawOverlay(); });
$("overlay").addEventListener("click", ev => {
  const leaf = st.map && st.map.leaves[leafAt(ev)];
  if (leaf) reveal(leafId(leaf.node));
});
$("overlay").addEventListener("dblclick", ev => {
  const leaf = st.map && st.map.leaves[leafAt(ev)];
  if (!leaf) return;
  const n = leaf.node, target = n[4] || n[3] === -1 ? n[0] : n.parent && n.parent[0];
  if (target !== undefined && target !== null && target !== st.zoom) zoomTo(target);
});

document.addEventListener("keydown", ev => {
  if ($("view-result").hidden || $("confirm").open || ev.target.tagName === "INPUT") return;
  if (ev.key === "Delete") recycle();
  else if (ev.key === "Backspace" && st.zoomChain.length > 1) zoomTo(st.zoomChain[st.zoomChain.length - 2].id);
});

$("btn-2d").onclick = () => setView(false);
$("btn-3d").onclick = () => setView(true);
$("btn-reveal").onclick = () => st.selected && api("reveal", { id: st.selected.id });
$("btn-delete").onclick = recycle;
$("btn-rescan").onclick = () => startScan(st.status.root);
$("btn-new").onclick = showStart;
$("btn-cancel").onclick = () => api("cancel", {});
$("btn-browse").onclick = async () => {
  const r = await api("pick", {});
  if (r.path) { $("path").value = r.path; startScan(r.path); }
};
$("pick").onsubmit = ev => { ev.preventDefault(); if ($("path").value.trim()) startScan($("path").value.trim()); };

$("split").addEventListener("pointerdown", ev => {
  const split = $("split"), left = $("view-result").getBoundingClientRect().left;
  split.setPointerCapture(ev.pointerId);
  split.classList.add("dragging");
  split.onpointermove = e => {
    const w = Math.max(280, Math.min(e.clientX - left, innerWidth - 320));
    $("view-result").style.setProperty("--side", w + "px");
  };
  split.onpointerup = () => { split.onpointermove = null; split.classList.remove("dragging"); };
});

let resizeTimer;
new ResizeObserver(() => {
  if ($("view-result").hidden || !st.map) return;
  if (st.view3d && Scape3D.ready) Scape3D.resize();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(loadMap, 150);
}).observe($("map-wrap"));

// The server exits when the window closes; it learns that from these.
setInterval(() => api("beat", {}).catch(() => {}), 5000);
addEventListener("pagehide", () => navigator.sendBeacon("/api/bye?t=" + encodeURIComponent(TOKEN)));

(async () => {
  const s = await api("status");
  if (s.state === "scanning") pollScan();
  else if (s.state === "done") { st.status = s; showResult(); }
  else showStart();
})();
