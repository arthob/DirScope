# DirScope

Disk usage at a glance: a directory tree with size bars, a file-type legend, and the
cushion treemap WinDirStat made famous, in a current UI with light and dark themes.
Switch the map to **Volumes** and the same partition stands up as solid blocks inside
a cube of the whole scan.

Windows only. It uses the Windows disk, Recycle Bin and volume APIs directly.

## Install

Download `DirScope.exe` and double-click it. Nothing to install, no Python needed,
and it writes nothing outside its own folder under `%LOCALAPPDATA%\DirScope`.

Windows will show a blue **"Windows protected your PC"** box the first time, because
the file is not code-signed. Click **More info**, then **Run anyway**. A signing
certificate costs a few hundred a year and this is a disk usage tool, so it is not
signed and that warning is expected.

If it will not start, open a terminal where the exe is and run:

```
DirScope.exe --doctor
```

That prints what the machine can and cannot do, one line per check, and exits
non-zero if something is actually wrong. Double-clicked, it says the same thing in a
message box.

## Run from source

```
python server.py
```

Python 3.9+ and nothing else: no packages, no build step. Opens an Edge app window,
and the server exits when the window closes.

## Build the exe

```
python build.py
```

Creates `.build-venv`, installs PyInstaller into it, and writes `dist/DirScope.exe`
(about 8 MB). The virtual environment is local to the checkout, so building on a
second machine does not change that machine's Python. The icon is committed as
`web/icon.ico`; regenerate it with `python tools/make_icon.py` only if the SVG changes.

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
- **Big and cold** ranks files by size multiplied by years since last changed, and glows
  them in both views, brightest first. In Volumes the top forty also get a beam you can
  see through the structure. It is scoped to wherever you have zoomed to.

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
- **Big and cold scores on last-modified time, deliberately, not last-access.** Access
  updates are enabled on this machine, but something sweeps every file: measured on
  2026-11-21, the oldest last-access time across 31,119 files under Documents was 11
  weeks, while modification times spanned years. Last-access therefore records machine
  activity, not whether a person opened anything, and a ranking built on it would show
  nothing as stale. Ages are clamped to 30 years, because restored and extracted files
  carry timestamps centuries out and one of those would own the ranking.
- `web/three.min.js` is vendored (three.js r128, MIT) rather than fetched from a CDN, so
  the app still works with no network. It is the only dependency, and there is still
  nothing to install and nothing to build.
