// The treemap as solid volumes. The footprint of every box is the same squarified
// partition the 2D map draws, so the two views agree; depth in the tree becomes
// height, and the whole scan is scaled to a cube. Selecting a folder keeps its
// subtree solid and drops everything else to glass.
const Scape3D = (() => {
  const SIZE = 100;            // world units along each edge of the scan cube
  const GAP = 0.03;            // fraction of the shorter footprint side left between siblings
  const GHOST = 0.035;         // opacity of the surround when nothing is picked out
  const GHOST_FOCUS = 0.018;   // and once something is, so the framed volume is not fogged by its own context
  const GHOST_WASH = 0.78;     // how far ghosts fade toward neutral, so context keeps shape but loses colour
  const MIN_SIDE = 0.05;       // boxes thinner than this are not worth an instance
  const EDGE = 0.1;            // world units the dark shell stands proud of each solid block
  const SINK = 0.52;           // how dark the deepest-buried terrace goes, as a fraction of its own colour
  const MARGIN = 1.14;         // slack left around a framed volume
  const ROT = 0.0075;          // radians of orbit per pixel dragged

  let renderer, scene, camera, solid, shell, ghost, outline, bounds, raf = 0;
  let geo, matSolid, matShell, matGhost, cap = 0;
  let boxes = [], solidIdx = [], ghostIdx = [], focus = -1, hover = -1, levels = 1, fitBB = null;
  let colorOf = () => [140, 140, 140], onPick = () => {}, onHover = () => {};
  const cam = { theta: -0.9, phi: 1.02, dist: 240, tx: 0, ty: 0, tz: 0 };
  const want = { dist: 240, tx: 0, ty: 0, tz: 0 };
  const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion();
  const tmpP = new THREE.Vector3(), tmpS = new THREE.Vector3(), tmpC = new THREE.Color();
  const axisX = new THREE.Vector3(), axisY = new THREE.Vector3();
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
    if (tree && tree[2] > 0) {
      levels = depthOf(tree, 0) + 1;
      const step = SIZE / levels;
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
    }
    refresh();
    fitTo(boundsOf(-1));
  }

  // A node's subtree is contiguous because the walk above is depth first.
  const inFocus = i => focus < 0 || (i >= focus && i < boxes[focus].end);

  // --- framing -----------------------------------------------------------

  // The volume a selection actually occupies is its own slab plus everything
  // standing on it, which is the range that stays opaque.
  function boundsOf(i) {
    const from = i < 0 ? 0 : i, to = i < 0 ? boxes.length : boxes[i].end;
    const b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity };
    for (let j = from; j < to; j++) {
      const k = boxes[j];
      b.x0 = Math.min(b.x0, k.x - k.w / 2); b.x1 = Math.max(b.x1, k.x + k.w / 2);
      b.y0 = Math.min(b.y0, k.y - k.h / 2); b.y1 = Math.max(b.y1, k.y + k.h / 2);
      b.z0 = Math.min(b.z0, k.z - k.d / 2); b.z1 = Math.max(b.z1, k.z + k.d / 2);
    }
    return isFinite(b.x0) ? b : { x0: -SIZE / 2, x1: SIZE / 2, y0: 0, y1: SIZE, z0: -SIZE / 2, z1: SIZE / 2 };
  }

  // Fit the volume's bounding SPHERE, not its box: the camera orbits, and a box
  // that just fits head-on spills off the edges the moment it is turned.
  function fitTo(b) {
    fitBB = b;
    if (!camera) return;
    want.tx = (b.x0 + b.x1) / 2;
    want.ty = (b.y0 + b.y1) / 2;
    want.tz = (b.z0 + b.z1) / 2;
    const r = Math.max(1e-3, Math.hypot(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0) / 2);
    const vFov = camera.fov * Math.PI / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    want.dist = r / Math.sin(Math.min(vFov, hFov) / 2) * MARGIN;
  }

  // --- instances ---------------------------------------------------------

  function ensureCapacity(n) {
    if (n <= cap) return;
    cap = Math.max(8192, Math.ceil(n * 1.3));
    for (const m of [solid, shell, ghost]) {
      if (!m) continue;
      scene.remove(m);
      m.dispose();
    }
    solid = new THREE.InstancedMesh(geo, matSolid, cap);
    shell = new THREE.InstancedMesh(geo, matShell, cap);
    ghost = new THREE.InstancedMesh(geo, matGhost, cap);
    for (const m of [shell, solid, ghost]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      scene.add(m);
    }
  }

  function fill(mesh, idx, lit, grow) {
    mesh.count = idx.length;
    for (let n = 0; n < idx.length; n++) {
      const b = boxes[idx[n]];
      tmpP.set(b.x, b.y, b.z);
      tmpS.set(Math.max(MIN_SIDE, b.w) + grow, b.h + grow, Math.max(MIN_SIDE, b.d) + grow);
      mesh.setMatrixAt(n, tmpM.compose(tmpP, tmpQ, tmpS));
      if (!lit) continue;
      const [r, g, bl] = colorOf(b.node[3]);
      tmpC.setRGB(r / 255, g / 255, bl / 255).convertSRGBToLinear();
      if (lit === 1) {
        // Buried terraces sit in their own shadow, which is what gives the stack its layers.
        tmpC.multiplyScalar(SINK + (1 - SINK) * (levels < 2 ? 1 : b.depth / (levels - 1)));
        if (idx[n] === hover) tmpC.lerp(WHITE, 0.4);
      } else {
        tmpC.lerp(NEUTRAL, GHOST_WASH);
      }
      mesh.setColorAt(n, tmpC);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (lit && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.visible = idx.length > 0;
  }

  function refresh() {
    ensureCapacity(boxes.length);
    solidIdx = [];
    ghostIdx = [];
    for (let i = 0; i < boxes.length; i++) (inFocus(i) ? solidIdx : ghostIdx).push(i);
    matGhost.opacity = focus >= 0 ? GHOST_FOCUS : GHOST;
    fill(shell, solidIdx, 0, EDGE * 2);
    fill(solid, solidIdx, 1, 0);
    fill(ghost, ghostIdx, 2, 0);
    const b = focus >= 0 ? boxes[focus] : null;
    outline.visible = !!b;
    if (b) {
      outline.position.set(b.x, b.y, b.z);
      outline.scale.set(Math.max(MIN_SIDE, b.w), b.h, Math.max(MIN_SIDE, b.d));
    }
  }

  // --- loop --------------------------------------------------------------

  function step() {
    const k = still ? 1 : 0.14;
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
      if (!mode) {
        const i = pickAt(ev);
        if (i !== hover) { hover = i; fill(solid, solidIdx, 1, 0); }
        onHover(i < 0 ? null : boxes[i], ev);
        return;
      }
      const dx = ev.clientX - px, dy = ev.clientY - py;
      px = ev.clientX; py = ev.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (mode === 1) {
        cam.theta += dx * ROT;
        cam.phi = Math.min(Math.PI - 0.06, Math.max(0.06, cam.phi + dy * ROT));
        return;
      }
      // Pan across the camera's own screen plane, scaled so a pixel of drag moves
      // the target one pixel's worth of world at the distance being looked at.
      const k = 2 * cam.dist * Math.tan(camera.fov * Math.PI / 360) / Math.max(1, el.clientHeight);
      axisX.setFromMatrixColumn(camera.matrix, 0).multiplyScalar(-dx * k);
      axisY.setFromMatrixColumn(camera.matrix, 1).multiplyScalar(dy * k);
      want.tx += axisX.x + axisY.x; cam.tx = want.tx;
      want.ty += axisX.y + axisY.y; cam.ty = want.ty;
      want.tz += axisX.z + axisY.z; cam.tz = want.tz;
    });
    el.addEventListener("pointerup", ev => {
      const was = mode;
      mode = 0;
      if (was === 1 && moved < 5) {
        const i = pickAt(ev);
        if (i >= 0) onPick(boxes[i].node, i);
      }
    });
    el.addEventListener("pointerleave", () => {
      if (mode) return;
      hover = -1;
      onHover(null);
      fill(solid, solidIdx, 1, 0);
    });
    el.addEventListener("wheel", ev => {
      ev.preventDefault();
      want.dist = Math.min(SIZE * 6, Math.max(2, want.dist * (ev.deltaY > 0 ? 1.12 : 0.89)));
    }, { passive: false });
    el.addEventListener("contextmenu", ev => ev.preventDefault());
  }

  // --- lifecycle ---------------------------------------------------------

  function mount(canvas, opts) {
    colorOf = opts.colorOf; onPick = opts.onPick; onHover = opts.onHover;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25;
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(42, 1, 0.5, 6000);

    scene.add(new THREE.HemisphereLight(0xe4edff, 0x141a24, 0.55));
    const key = new THREE.DirectionalLight(0xfff4e8, 1.45);
    key.position.set(-0.55, 1.15, 0.8);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x86aaff, 0.85);
    rim.position.set(0.95, 0.25, -0.75);
    scene.add(rim);
    const fill2 = new THREE.DirectionalLight(0xffffff, 0.25);
    fill2.position.set(0.2, -1, 0.35);
    scene.add(fill2);

    geo = new THREE.BoxGeometry(1, 1, 1);
    matSolid = new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.12 });
    // A back-faced shell a hair larger than each block reads as a drawn edge and
    // costs one more draw call rather than one line object per box.
    matShell = new THREE.MeshBasicMaterial({ color: 0x0b0f14, side: THREE.BackSide });
    matGhost = new THREE.MeshStandardMaterial({
      roughness: 1, metalness: 0, transparent: true, opacity: GHOST, depthWrite: false,
    });
    ensureCapacity(8192);

    outline = new THREE.LineSegments(new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 }));
    outline.visible = false;
    scene.add(outline);

    bounds = new THREE.LineSegments(new THREE.EdgesGeometry(geo),
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
    if (fitBB) fitTo(fitBB);   // a new aspect ratio changes what "fits"
  }

  function select(id) {
    focus = boxes.findIndex(b =>
      (b.node[3] === -2 ? b.parent >= 0 && boxes[b.parent].node[0] : b.node[0]) === id);
    refresh();
    fitTo(boundsOf(focus));
  }

  const start = () => { if (!raf && renderer) step(); };
  const stop = () => { cancelAnimationFrame(raf); raf = 0; };

  return { mount, build, select, resize, start, stop, get ready() { return !!renderer; } };
})();
