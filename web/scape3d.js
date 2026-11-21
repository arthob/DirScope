// The treemap as solid volumes. The footprint of every box is the same squarified
// partition the 2D map draws, so the two views agree; depth in the tree becomes
// height, and the whole scan is scaled to a cube. Selecting a folder keeps its
// subtree solid and drops everything else to glass.
const Scape3D = (() => {
  const SIZE = 100;            // world units along each edge of the scan cube
  const GAP = 0.03;            // fraction of the shorter footprint side left between siblings
  const GHOST = 0.035;         // opacity of everything outside the focused subtree
  const GHOST_WASH = 0.78;     // how far ghosts fade toward neutral, so context keeps shape but loses colour
  const MIN_SIDE = 0.05;       // boxes thinner than this are not worth an instance

  let renderer, scene, camera, solid, ghost, outline, bounds, raf = 0;
  let boxes = [], solidIdx = [], ghostIdx = [], focus = -1, hover = -1;
  let colorOf = () => [140, 140, 140], onPick = () => {}, onHover = () => {};
  const cam = { theta: -0.9, phi: 1.02, dist: 210, tx: 0, ty: 0, tz: 0 };
  const want = { dist: 210, tx: 0, ty: SIZE * 0.3, tz: 0 };
  const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion();
  const tmpP = new THREE.Vector3(), tmpS = new THREE.Vector3(), tmpC = new THREE.Color();
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const WHITE = new THREE.Color(1, 1, 1), NEUTRAL = new THREE.Color(0.42, 0.46, 0.52);
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // --- layout ------------------------------------------------------------

  function depthOf(node, d) {
    if (!node[4] || !node[4].length) return d;
    let m = d;
    for (const c of node[4]) m = Math.max(m, depthOf(c, d + 1));
    return m;
  }

  function build(tree) {
    boxes = [];
    focus = -1;
    hover = -1;
    if (!tree || tree[2] <= 0) return refresh();
    const levels = depthOf(tree, 0) + 1, step = SIZE / levels;
    (function walk(node, x, z, w, d, depth, parent) {
      const i = boxes.length;
      boxes.push({
        node, depth, parent, end: 0,
        x: x + w / 2, z: z + d / 2, w, d,
        y: depth * step + step / 2, h: step,
      });
      const kids = node[4];
      if (kids && kids.length) {
        const g = Math.min(w, d) * GAP;
        const iw = Math.max(1e-4, w - 2 * g), id = Math.max(1e-4, d - 2 * g);
        Treemap.squarify(kids, x + g, z + g, iw, id, node[2],
          (c, cx, cz, cw, cd) => walk(c, cx, cz, cw, cd, depth + 1, i));
      }
      boxes[i].end = boxes.length;
    })(tree, -SIZE / 2, -SIZE / 2, SIZE, SIZE, 0, -1);
    frame(0);
    refresh();
  }

  // A node's subtree is contiguous because the walk above is depth first.
  const inFocus = i => focus < 0 || (i >= focus && i < boxes[focus].end);

  // --- instances ---------------------------------------------------------

  function fill(mesh, idx, lit) {
    mesh.count = idx.length;
    for (let n = 0; n < idx.length; n++) {
      const b = boxes[idx[n]];
      tmpP.set(b.x, b.y, b.z);
      tmpS.set(Math.max(MIN_SIDE, b.w), b.h, Math.max(MIN_SIDE, b.d));
      mesh.setMatrixAt(n, tmpM.compose(tmpP, tmpQ, tmpS));
      const [r, g, bl] = colorOf(b.node[3]);
      tmpC.setRGB(r / 255, g / 255, bl / 255).convertSRGBToLinear();
      if (lit && idx[n] === hover) tmpC.lerp(WHITE, 0.35);
      else if (!lit) tmpC.lerp(NEUTRAL, GHOST_WASH);
      mesh.setColorAt(n, tmpC);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.visible = idx.length > 0;
  }

  function refresh() {
    solidIdx = [];
    ghostIdx = [];
    for (let i = 0; i < boxes.length; i++) (inFocus(i) ? solidIdx : ghostIdx).push(i);
    fill(solid, solidIdx, true);
    fill(ghost, ghostIdx, false);
    const b = focus >= 0 ? boxes[focus] : null;
    outline.visible = !!b;
    if (b) {
      outline.position.set(b.x, b.y, b.z);
      outline.scale.set(Math.max(MIN_SIDE, b.w), b.h, Math.max(MIN_SIDE, b.d));
    }
  }

  // --- camera ------------------------------------------------------------

  function frameBox(b) {
    want.tx = b.x; want.ty = b.y; want.tz = b.z;
    want.dist = Math.max(14, Math.hypot(b.w, b.h, b.d) * 2.1);
  }

  // The whole scan sits in a SIZE cube standing on y = 0, so framing it means
  // looking at the middle of that cube from far enough back to clear its diagonal.
  function frame(i) {
    if (!boxes.length) return;
    if (i > 0) return frameBox(boxes[i]);
    want.tx = 0; want.tz = 0;
    want.ty = SIZE * 0.45;
    want.dist = SIZE * 2.4;
  }

  function step() {
    const k = still ? 1 : 0.12;
    cam.tx += (want.tx - cam.tx) * k;
    cam.ty += (want.ty - cam.ty) * k;
    cam.tz += (want.tz - cam.tz) * k;
    cam.dist += (want.dist - cam.dist) * k;
    const sp = Math.sin(cam.phi);
    camera.position.set(
      cam.tx + cam.dist * sp * Math.sin(cam.theta),
      cam.ty + cam.dist * Math.cos(cam.phi),
      cam.tz + cam.dist * sp * Math.cos(cam.theta));
    camera.lookAt(cam.tx, cam.ty, cam.tz);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(step);
  }

  // --- picking -----------------------------------------------------------

  function pickAt(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set((ev.clientX - r.left) / r.width * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    for (const [mesh, idx] of [[solid, solidIdx], [ghost, ghostIdx]]) {
      if (!mesh.visible) continue;
      const hit = ray.intersectObject(mesh)[0];
      if (hit) return idx[hit.instanceId];
    }
    return -1;
  }

  // --- controls ----------------------------------------------------------

  function controls(el) {
    let mode = 0, px = 0, py = 0, moved = 0;
    el.addEventListener("pointerdown", ev => {
      mode = ev.button === 0 && !ev.shiftKey ? 1 : 2;
      px = ev.clientX; py = ev.clientY; moved = 0;
      el.setPointerCapture(ev.pointerId);
    });
    el.addEventListener("pointermove", ev => {
      const dx = ev.clientX - px, dy = ev.clientY - py;
      if (!mode) {
        const i = pickAt(ev);
        if (i !== hover) { hover = i; fill(solid, solidIdx, true); }
        onHover(i < 0 ? null : boxes[i], ev);
        return;
      }
      moved += Math.abs(dx) + Math.abs(dy);
      px = ev.clientX; py = ev.clientY;
      if (mode === 1) {
        cam.theta -= dx * 0.008;
        cam.phi = Math.min(Math.PI - 0.08, Math.max(0.08, cam.phi - dy * 0.008));
      } else {
        const s = cam.dist * 0.0016;
        want.tx -= (dx * Math.cos(cam.theta) - dy * 0.5 * Math.sin(cam.theta)) * s;
        want.tz += (dx * Math.sin(cam.theta) + dy * 0.5 * Math.cos(cam.theta)) * s;
        cam.tx = want.tx; cam.tz = want.tz;
      }
    });
    el.addEventListener("pointerup", ev => {
      const was = mode;
      mode = 0;
      if (was === 1 && moved < 5) {
        const i = pickAt(ev);
        if (i >= 0) onPick(boxes[i].node, i);
      }
    });
    el.addEventListener("pointerleave", () => { hover = -1; onHover(null); fill(solid, solidIdx, true); });
    el.addEventListener("wheel", ev => {
      ev.preventDefault();
      want.dist = Math.min(SIZE * 4, Math.max(4, want.dist * (ev.deltaY > 0 ? 1.12 : 0.89)));
    }, { passive: false });
    el.addEventListener("contextmenu", ev => ev.preventDefault());
  }

  // --- lifecycle ---------------------------------------------------------

  function mount(canvas, opts) {
    colorOf = opts.colorOf; onPick = opts.onPick; onHover = opts.onHover;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.outputEncoding = THREE.sRGBEncoding;
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(42, 1, 0.5, 4000);

    scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x202833, 0.72));
    const key = new THREE.DirectionalLight(0xffffff, 0.78);
    key.position.set(-0.6, 1.3, 0.75);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x93b4ff, 0.3);
    rim.position.set(0.9, 0.35, -0.8);
    scene.add(rim);

    const box = new THREE.BoxGeometry(1, 1, 1);
    const cap = 60000;
    solid = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ roughness: 0.58, metalness: 0.05 }), cap);
    ghost = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({
      roughness: 1, metalness: 0, transparent: true, opacity: GHOST, depthWrite: false,
    }), cap);
    for (const m of [solid, ghost]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      scene.add(m);
    }

    outline = new THREE.LineSegments(new THREE.EdgesGeometry(box),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }));
    outline.visible = false;
    scene.add(outline);

    bounds = new THREE.LineSegments(new THREE.EdgesGeometry(box),
      new THREE.LineBasicMaterial({ color: 0x7f8c9b, transparent: true, opacity: 0.3 }));
    bounds.scale.setScalar(SIZE);
    bounds.position.y = SIZE / 2;
    scene.add(bounds);

    controls(canvas);
    resize();
  }

  function resize() {
    if (!renderer) return;
    const el = renderer.domElement, w = el.clientWidth || 1, h = el.clientHeight || 1;
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function select(id) {
    const i = boxes.findIndex(b => (b.node[3] === -2 ? b.parent >= 0 && boxes[b.parent].node[0] : b.node[0]) === id);
    focus = i;
    if (i >= 0) frameBox(boxes[i]);
    refresh();
  }

  const start = () => { if (!raf && renderer) step(); };
  const stop = () => { cancelAnimationFrame(raf); raf = 0; };

  return { mount, build, select, resize, start, stop, get ready() { return !!renderer; } };
})();
