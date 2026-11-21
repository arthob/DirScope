# DirScope

Disk usage at a glance: a directory tree with size bars, a file-type legend, and the
cushion treemap WinDirStat made famous, in a current UI with light and dark themes.
Switch the map to **Volumes** and the same partition stands up as solid blocks inside
a cube of the whole scan.

## Run

```
python server.py
```

Opens an Edge app window. The server exits when the window closes. Python 3.12+ and
nothing else: no packages, no build step.

## Use

- **Click** a block on the map to find it in the tree. **Double-click** a block to zoom in;
  the breadcrumb or **Backspace** zooms back out.
- **Click** a file type to light up every file of that type on the map.
- **Show in Explorer** opens the selection in File Explorer.
- **Recycle** (or **Del**) moves the selection to the Recycle Bin. Nothing is ever
  deleted permanently, and Windows warns you first if an item is too big to recycle.
- Drag the divider to widen the tree.
- **Map / Volumes** switches between the flat treemap and the 3D one. In Volumes, drag
  to orbit, scroll to zoom, shift-drag to pan. Selecting anything in the tree flies the
  camera to it and drops everything outside it to glass.

## Design

- `server.py` scans with 16 threads using `os.scandir`, skipping junctions and symlinks so
  nothing is counted twice, then serves a localhost API guarded by a per-launch token.
- `web/treemap.js` lays out a squarified treemap and shades it with van Wijk cushions.
  The server prunes the tree to what the canvas can actually show, so a million-file
  drive still loads instantly.
- `web/scape3d.js` reuses that same layout for the Volumes view: the footprint of every
  block is its rectangle on the flat map, depth in the tree becomes height, and the two
  views therefore always agree. Blocks are drawn as two instanced meshes, one solid and
  one glass, so focusing is a repartition rather than a rebuild.
- `web/three.min.js` is vendored (three.js r128, MIT) rather than fetched from a CDN, so
  the app still works with no network. It is the only dependency, and there is still
  nothing to install and nothing to build.
