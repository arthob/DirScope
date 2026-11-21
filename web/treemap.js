// Squarified cushion treemap (Bruls et al. layout, van Wijk & van de Wetering shading),
// the same picture WinDirStat draws. A tree node is [id, name, size, ext, children?].
const Treemap = (() => {
  const HEIGHT = 0.38, FALLOFF = 0.91, AMBIENT = 0.18, GAIN = 1.25;
  const L = (() => { const v = [-1, -1, 10], m = Math.hypot(...v); return v.map(x => x / m); })();

  function ridge(s, i, a, b, h) {
    if (b - a < 1e-9) return;
    s[i] += 4 * h * (b + a) / (b - a);
    s[i + 1] -= 4 * h / (b - a);
  }

  function worst(sum, max, min, side) {
    const s2 = sum * sum, w2 = side * side;
    return Math.max(w2 * max / s2, s2 / (w2 * min));
  }

  // Lays children (sorted largest first) into the rectangle, calling put(child, x, y, w, h).
  function squarify(kids, x, y, w, h, total, put) {
    const scale = w * h / total;
    let i = 0;
    while (i < kids.length) {
      const side = Math.min(w, h);
      if (side <= 0) return;
      let j = i, sum = 0, best = Infinity;
      while (j < kids.length) {
        const a = kids[j][2] * scale, next = sum + a;
        const r = worst(next, kids[i][2] * scale, a, side);
        if (r > best) break;
        best = r; sum = next; j++;
      }
      const thick = sum / side;
      let off = 0;
      for (let k = i; k < j; k++) {
        const len = kids[k][2] * scale / thick;
        if (w >= h) put(kids[k], x, y + off, thick, len);
        else put(kids[k], x + off, y, len, thick);
        off += len;
      }
      if (w >= h) { x += thick; w -= thick; } else { y += thick; h -= thick; }
      i = j;
    }
  }

  function layout(root, w, h) {
    const leaves = [], rects = new Map();
    (function place(node, x, y, rw, rh, s, height, parent) {
      node.parent = parent;
      if (node[3] !== -2) rects.set(node[0], [x, y, rw, rh]);
      const surf = s.slice();
      ridge(surf, 0, x, x + rw, height);
      ridge(surf, 2, y, y + rh, height);
      const kids = node[4];
      if (!kids || rw < 2 || rh < 2) { leaves.push({ node, x, y, w: rw, h: rh, s: surf }); return; }
      squarify(kids, x, y, rw, rh, node[2], (c, cx, cy, cw, ch) =>
        place(c, cx, cy, cw, ch, surf, height * FALLOFF, node));
    })(root, 0, 0, w, h, [0, 0, 0, 0], HEIGHT, null);
    return { leaves, rects };
  }

  // Paints the leaves into ctx and returns a pixel -> leaf index lookup for hit testing.
  function paint(ctx, w, h, map, colorOf, dimmed) {
    const img = ctx.createImageData(w, h), px = img.data, hit = new Int32Array(w * h).fill(-1);
    map.leaves.forEach((leaf, idx) => {
      const x0 = Math.round(leaf.x), x1 = Math.min(w, Math.round(leaf.x + leaf.w));
      const y0 = Math.round(leaf.y), y1 = Math.min(h, Math.round(leaf.y + leaf.h));
      if (x1 <= x0 || y1 <= y0) return;
      const [r, g, b] = colorOf(leaf.node), s = leaf.s, k = dimmed && dimmed(leaf.node) ? 0.28 : 1;
      for (let py = y0; py < y1; py++) {
        const ny = -(2 * s[3] * (py + 0.5) + s[2]);
        let o = (py * w + x0) * 4, hi = py * w + x0;
        for (let pxl = x0; pxl < x1; pxl++, o += 4, hi++) {
          const nx = -(2 * s[1] * (pxl + 0.5) + s[0]);
          const cos = (nx * L[0] + ny * L[1] + L[2]) / Math.sqrt(nx * nx + ny * ny + 1);
          const i = (AMBIENT + (1 - AMBIENT) * Math.max(0, cos)) * GAIN * k;
          px[o] = Math.min(255, r * i); px[o + 1] = Math.min(255, g * i); px[o + 2] = Math.min(255, b * i);
          px[o + 3] = 255;
          hit[hi] = idx;
        }
      }
    });
    ctx.putImageData(img, 0, 0);
    return hit;
  }

  return { layout, paint };
})();
