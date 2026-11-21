"""DirScope: disk usage at a glance. A local HTTP server that scans a folder and
serves a browser UI with a directory tree, an extension legend and a cushion treemap.

Run: python server.py            (opens an Edge app window, exits when it closes)
     python server.py --port 8150 --no-browser
"""
import argparse
import ctypes
import json
import os
import queue
import secrets
import shutil
import string
import subprocess
import sys
import threading
import time
import webbrowser
from ctypes import wintypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
TOKEN = secrets.token_urlsafe(16)
MIN_AREA = 6           # treemap pixels below which an item is merged into its parent
MAX_CHILDREN = 3000    # rows returned per folder in the tree panel
LOCK = threading.RLock()


class Node:
    __slots__ = ("id", "name", "parent", "children", "size", "files", "ext")

    def __init__(self, name, parent, is_dir):
        self.name = name
        self.parent = parent
        self.children = [] if is_dir else None
        self.size = 0
        self.files = 0 if is_dir else 1
        self.ext = -1


class Scan:
    def __init__(self, root_path):
        self.root_path = os.path.abspath(root_path)
        self.nodes = []
        self.exts, self.ext_ids = [], {}
        self.ext_bytes, self.ext_count = [], []
        self.files = self.dirs = self.bytes = self.errors = 0
        self.current = self.root_path
        self.state = "scanning"
        self.cancelled = False
        self.started = time.time()
        self.elapsed = 0.0
        self.root = Node(self.root_path, None, True)
        self._add([self.root], [])
        threading.Thread(target=self._run, daemon=True).start()

    def _add(self, batch, ext_names):
        with LOCK:
            for n, ext in zip(batch, ext_names or [None] * len(batch)):
                n.id = len(self.nodes)
                self.nodes.append(n)
                if ext is not None:
                    eid = self.ext_ids.get(ext)
                    if eid is None:
                        eid = self.ext_ids[ext] = len(self.exts)
                        self.exts.append(ext)
                    n.ext = eid

    def _list(self, d, path, q):
        self.current = path
        try:
            with os.scandir(path) as it:
                entries = list(it)
        except OSError:
            self.errors += 1
            return
        files, file_exts, subdirs = [], [], []
        added = 0
        for e in entries:
            try:
                # Junctions and symlinks point at space counted elsewhere.
                if e.is_junction() or e.is_symlink():
                    continue
                if e.is_dir(follow_symlinks=False):
                    subdirs.append(Node(e.name, d, True))
                else:
                    n = Node(e.name, d, False)
                    st = e.stat(follow_symlinks=False)
                    n.size = on_disk(e.path) if st.st_file_attributes & NOT_LOCAL else st.st_size
                    added += n.size
                    files.append(n)
                    file_exts.append(os.path.splitext(e.name)[1].lower() or "(none)")
            except OSError:
                self.errors += 1
        self._add(files, file_exts)
        self._add(subdirs, [])
        d.children = subdirs + files
        with LOCK:
            self.files += len(files)
            self.dirs += len(subdirs)
            self.bytes += added
        for s in subdirs:
            q.put((s, os.path.join(path, s.name)))

    def _run(self):
        q = queue.Queue()
        q.put((self.root, self.root_path))

        def work():
            while True:
                item = q.get()
                if item is None:
                    return
                try:
                    if not self.cancelled:
                        self._list(item[0], item[1], q)
                finally:
                    q.task_done()

        threads = [threading.Thread(target=work, daemon=True) for _ in range(16)]
        for t in threads:
            t.start()
        q.join()
        for _ in threads:
            q.put(None)
        if self.cancelled:
            self.state = "cancelled"
            return
        with LOCK:
            # Children always get higher ids than their parent, so one reverse
            # pass rolls every size up to the root.
            for n in reversed(self.nodes):
                if n.children is not None:
                    n.children.sort(key=lambda c: c.size, reverse=True)
                if n.parent is not None:
                    n.parent.size += n.size
                    n.parent.files += n.files
            self.ext_bytes = [0] * len(self.exts)
            self.ext_count = [0] * len(self.exts)
            for n in self.nodes:
                if n.children is None:
                    self.ext_bytes[n.ext] += n.size
                    self.ext_count[n.ext] += 1
        self.elapsed = time.time() - self.started
        self.state = "done"

    def path(self, n):
        parts = []
        while n.parent is not None:
            parts.append(n.name)
            n = n.parent
        return os.path.join(self.root_path, *reversed(parts))

    def status(self):
        return {"state": self.state, "root": self.root_path, "rootId": 0,
                "files": self.files, "dirs": self.dirs, "bytes": self.root.size or self.bytes,
                "errors": self.errors, "current": self.current,
                "elapsed": self.elapsed or time.time() - self.started}

    def row(self, n):
        return {"id": n.id, "name": n.name, "size": n.size, "files": n.files,
                "dir": n.children is not None, "ext": n.ext}

    def folder(self, n):
        kids = n.children or []
        return {**self.row(n), "path": self.path(n),
                "children": [self.row(c) for c in kids[:MAX_CHILDREN]],
                "more": max(0, len(kids) - MAX_CHILDREN)}

    def ancestry(self, n):
        chain = []
        while n is not None:
            chain.append({"id": n.id, "name": n.name})
            n = n.parent
        return chain[::-1]

    def treemap(self, n, pixels):
        """Nested [id, name, size, ext, children?] pruned to what the canvas can show.
        ext -1 is a folder too small to subdivide, -2 is a folder's merged small items."""
        threshold = n.size * MIN_AREA / max(pixels, 1)

        def build(node):
            if node.children is None:
                return [node.id, node.name, node.size, node.ext]
            kids, kept = [], 0
            for c in node.children:
                if c.size < threshold or c.size == 0:
                    break
                kids.append(build(c))
                kept += c.size
            if not kids:
                return [node.id, node.name, node.size, -1]
            if node.size > kept:
                kids.append([node.id, "(small items)", node.size - kept, -2])
            return [node.id, node.name, node.size, -1, kids]

        return build(n)

    def extensions(self):
        order = sorted(range(len(self.exts)), key=lambda i: self.ext_bytes[i], reverse=True)
        return [{"id": i, "ext": self.exts[i], "bytes": self.ext_bytes[i],
                 "count": self.ext_count[i]} for i in order[:200] if self.ext_bytes[i] > 0]

    def remove(self, n):
        stack = [n]
        while stack:
            m = stack.pop()
            if m.children is None:
                self.ext_bytes[m.ext] -= m.size
                self.ext_count[m.ext] -= 1
            else:
                stack.extend(m.children)
        p = n.parent
        p.children.remove(n)
        while p is not None:
            p.size -= n.size
            p.files -= n.files
            p = p.parent


SCAN = None


# --- Windows helpers -------------------------------------------------------

# Cloud-only OneDrive placeholders report their full size but occupy nothing here
# (measured: 217 GB of phantom size on C:). Compressed and sparse files also differ.
# These, and only these, cost an extra call to ask what is really on disk.
NOT_LOCAL = 0x400000 | 0x40000 | 0x1000 | 0x200 | 0x800  # recall on access/open, offline, sparse, compressed
GetCompressedFileSizeW = ctypes.windll.kernel32.GetCompressedFileSizeW
GetCompressedFileSizeW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(wintypes.DWORD)]
GetCompressedFileSizeW.restype = wintypes.DWORD


def on_disk(path):
    high = wintypes.DWORD(0)
    low = GetCompressedFileSizeW(path, ctypes.byref(high))
    if low == 0xFFFFFFFF and ctypes.GetLastError():
        return 0
    return (high.value << 32) + low


class SHFILEOPSTRUCTW(ctypes.Structure):
    _fields_ = [("hwnd", wintypes.HWND), ("wFunc", wintypes.UINT),
                ("pFrom", wintypes.LPCWSTR), ("pTo", wintypes.LPCWSTR),
                ("fFlags", ctypes.c_uint16), ("fAnyOperationsAborted", wintypes.BOOL),
                ("hNameMappings", ctypes.c_void_p), ("lpszProgressTitle", wintypes.LPCWSTR)]


def recycle(path):
    """Send to the Recycle Bin. Windows still warns before anything would be
    deleted permanently (FOF_WANTNUKEWARNING), so this never silently destroys."""
    FO_DELETE, FOF_SILENT, FOF_NOCONFIRMATION = 3, 0x4, 0x10
    FOF_ALLOWUNDO, FOF_NOERRORUI, FOF_WANTNUKEWARNING = 0x40, 0x400, 0x4000
    op = SHFILEOPSTRUCTW(wFunc=FO_DELETE, pFrom=path + "\0",
                         fFlags=FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT
                         | FOF_NOERRORUI | FOF_WANTNUKEWARNING)
    rc = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
    return rc == 0 and not op.fAnyOperationsAborted and not os.path.lexists(path)


def drives():
    out = []
    mask = ctypes.windll.kernel32.GetLogicalDrives()
    for i, letter in enumerate(string.ascii_uppercase):
        if not mask >> i & 1:
            continue
        root = letter + ":\\"
        try:
            usage = shutil.disk_usage(root)
        except OSError:
            continue
        label = ctypes.create_unicode_buffer(261)
        ctypes.windll.kernel32.GetVolumeInformationW(root, label, 261, None, None, None, None, 0)
        out.append({"path": root, "label": label.value, "total": usage.total, "free": usage.free})
    return out


def pick_folder():
    script = ("Add-Type -AssemblyName System.Windows.Forms;"
              "$d=New-Object System.Windows.Forms.FolderBrowserDialog;"
              "$d.Description='Choose a folder to scan';"
              "if($d.ShowDialog() -eq 'OK'){$d.SelectedPath}")
    r = subprocess.run(["powershell", "-NoProfile", "-STA", "-Command", script],
                       capture_output=True, text=True, creationflags=subprocess.CREATE_NO_WINDOW)
    return r.stdout.strip() or None


# --- HTTP ------------------------------------------------------------------

LAST_BEAT = [time.time()]
TYPES = {".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def authorised(self, query):
        # The header blocks cross-site requests from other pages; the Host check
        # blocks DNS rebinding. Only the beacon on window close uses the query token.
        host_ok = self.headers.get("Host", "").split(":")[0] in ("127.0.0.1", "localhost")
        return host_ok and TOKEN in (self.headers.get("X-Token"), query.get("t", [None])[0])

    def node_arg(self, query):
        try:
            return SCAN.nodes[int(query["id"][0])]
        except (KeyError, ValueError, IndexError, TypeError, AttributeError):
            return None

    def do_GET(self):
        url = urlparse(self.path)
        if not url.path.startswith("/api/"):
            name = "index.html" if url.path == "/" else url.path.lstrip("/")
            full = os.path.normpath(os.path.join(WEB, name))
            if not full.startswith(WEB) or not os.path.isfile(full):
                return self.send(404, {"error": "not found"})
            with open(full, "rb") as f:
                return self.send(200, f.read(), TYPES.get(os.path.splitext(full)[1], "text/plain"))
        q = parse_qs(url.query)
        if not self.authorised(q):
            return self.send(403, {"error": "forbidden"})
        route = url.path[5:]
        if route == "drives":
            return self.send(200, drives())
        if route == "status":
            return self.send(200, SCAN.status() if SCAN else {"state": "idle"})
        if not SCAN or SCAN.state != "done":
            return self.send(409, {"error": "no finished scan"})
        with LOCK:
            n = self.node_arg(q)
            if route == "extensions":
                return self.send(200, SCAN.extensions())
            if n is None:
                return self.send(404, {"error": "unknown id"})
            if route == "folder":
                return self.send(200, SCAN.folder(n))
            if route == "ancestry":
                return self.send(200, SCAN.ancestry(n))
            if route == "treemap":
                return self.send(200, {"path": SCAN.path(n),
                                       "tree": SCAN.treemap(n, int(q.get("px", ["1000000"])[0]))})
        self.send(404, {"error": "unknown route"})

    def do_POST(self):
        global SCAN
        url = urlparse(self.path)
        q = parse_qs(url.query)
        if not self.authorised(q):
            return self.send(403, {"error": "forbidden"})
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}") if length else {}
        route = url.path[5:]
        if route == "beat":
            LAST_BEAT[0] = time.time()
            return self.send(200, {})
        if route == "bye":
            # A reload also says bye, then beats again within a second or two.
            LAST_BEAT[0] = time.time() - 595
            return self.send(200, {})
        if route == "pick":
            return self.send(200, {"path": pick_folder()})
        if route == "scan":
            path = body.get("path") or (SCAN.root_path if SCAN else "")
            if not os.path.isdir(path):
                return self.send(400, {"error": "Not a folder: " + path})
            if SCAN and SCAN.state == "scanning":
                SCAN.cancelled = True
            SCAN = Scan(path)
            return self.send(200, SCAN.status())
        if route == "cancel":
            if SCAN:
                SCAN.cancelled = True
            return self.send(200, {})
        if not SCAN or SCAN.state != "done":
            return self.send(409, {"error": "no finished scan"})
        with LOCK:
            n = self.node_arg({"id": [str(body.get("id"))]})
            if n is None:
                return self.send(404, {"error": "unknown id"})
            path = SCAN.path(n)
            if route == "reveal":
                subprocess.Popen(["explorer", "/select,", path])
                return self.send(200, {})
            if route == "delete":
                if n.parent is None:
                    return self.send(400, {"error": "Refusing to delete the scanned root."})
                if not recycle(path):
                    return self.send(500, {"error": "Windows did not move it to the Recycle Bin."})
                SCAN.remove(n)
                return self.send(200, {"parent": n.parent.id})
        self.send(404, {"error": "unknown route"})


def find_edge():
    for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles")):
        exe = os.path.join(base or "", "Microsoft", "Edge", "Application", "msedge.exe")
        if os.path.isfile(exe):
            return exe
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--token", help="fixed token, for testing")
    args = ap.parse_args()
    global TOKEN
    TOKEN = args.token or TOKEN
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = "http://127.0.0.1:%d/?t=%s" % (server.server_address[1], TOKEN)
    print(url, flush=True)
    if args.no_browser:
        return server.serve_forever()

    edge = find_edge()
    if edge:
        profile = os.path.join(os.environ["LOCALAPPDATA"], "DirScope", "edge")
        subprocess.Popen([edge, "--app=" + url, "--user-data-dir=" + profile,
                          "--window-size=1440,900", "--no-first-run"])
    else:
        webbrowser.open(url)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    # The page beats every few seconds and says bye on close. Background windows
    # get their timers throttled, so silence alone is only trusted after 10 minutes.
    while True:
        time.sleep(2)
        if time.time() - LAST_BEAT[0] > 600:
            sys.exit(0)


if __name__ == "__main__":
    main()
