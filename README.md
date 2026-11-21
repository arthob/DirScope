# DirScope

Disk usage at a glance: a directory tree with size bars, a file-type legend, and the
cushion treemap WinDirStat made famous, in a current UI with light and dark themes.

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

## Design

- `server.py` scans with 16 threads using `os.scandir`, skipping junctions and symlinks so
  nothing is counted twice, then serves a localhost API guarded by a per-launch token.
- `web/treemap.js` lays out a squarified treemap and shades it with van Wijk cushions.
  The server prunes the tree to what the canvas can actually show, so a million-file
  drive still loads instantly.
