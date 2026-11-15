"""Builds the scenery art: the club's terrace and the podium.

    /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \\
        --python art/scene/build.py -- [--out DIR] [--only club,podium]

Writes one .glb per scene into apps/client/public/env/ (see scene.py for what is in them).
"""

import argparse
import importlib
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SCENES = ["club", "podium"]


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", default=os.path.join(ROOT, "apps", "client", "public", "env"))
    p.add_argument("--only", default=None)
    a = p.parse_args(argv)
    os.makedirs(a.out, exist_ok=True)
    for name in a.only.split(",") if a.only else SCENES:
        t = time.time()
        scene = importlib.import_module(name).build()
        size = scene.write(os.path.join(a.out, f"{name}.glb"))
        print(f"{name}: {size / 1024:.0f} KB, {scene.triangles()}, {time.time() - t:.1f}s", flush=True)


main()
