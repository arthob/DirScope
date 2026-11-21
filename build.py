"""Build dist/DirScope.exe.

Creates its own virtual environment under .build-venv and installs PyInstaller
there, so building on a second machine does not change that machine's Python.
Everything else the app needs is in the standard library or vendored in web/.

    python build.py
"""
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
VENV = os.path.join(ROOT, ".build-venv")
VPY = os.path.join(VENV, "Scripts", "python.exe")
EXE = os.path.join(ROOT, "dist", "DirScope.exe")


def run(cmd):
    print("+", subprocess.list2cmdline(cmd), flush=True)
    subprocess.run(cmd, check=True, cwd=ROOT)


def version():
    src = open(os.path.join(ROOT, "server.py"), encoding="utf-8").read()
    return re.search(r'^VERSION = "([^"]+)"', src, re.M).group(1)


def main():
    if os.name != "nt":
        sys.exit("DirScope is a Windows application: build it on Windows.")
    for need in ("server.py", os.path.join("web", "index.html"), os.path.join("web", "icon.ico")):
        if not os.path.isfile(os.path.join(ROOT, need)):
            sys.exit("missing %s; run this from a full checkout" % need)

    if not os.path.isfile(VPY):
        run([sys.executable, "-m", "venv", VENV])
    run([VPY, "-m", "pip", "install", "--quiet", "--upgrade", "pip", "pyinstaller"])

    for d in ("build", "dist"):
        shutil.rmtree(os.path.join(ROOT, d), ignore_errors=True)
    run([VPY, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--noconsole",
         "--name", "DirScope", "--icon", os.path.join("web", "icon.ico"),
         "--add-data", "web%sweb" % os.pathsep, "server.py"])

    if not os.path.isfile(EXE):
        sys.exit("PyInstaller reported success but produced no exe")
    print("\nDirScope %s  ->  %s  (%.1f MB)" % (version(), EXE, os.path.getsize(EXE) / 1e6))
    print("Check it on this machine with:  dist\\DirScope.exe --doctor")


if __name__ == "__main__":
    main()
