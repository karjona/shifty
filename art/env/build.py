"""Builds the mountain's scenery models into apps/client/public/env/snow.glb.

    /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \
        --python art/env/build.py

One mesh per model, named as the game asks for it (render/env/models.ts).
"""

import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import meshlib  # noqa: E402
import rocks  # noqa: E402
import trees  # noqa: E402

OUT = os.path.normpath(os.path.join(HERE, "..", "..", "apps", "client", "public", "env", "snow.glb"))


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    models = {}
    for module in (trees, rocks):
        models.update(module.build())
    for name, mesh in sorted(models.items()):
        meshlib.to_blender(name, mesh)
        print(f"{name}: {mesh.count()} triangles")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    meshlib.export(OUT)
    print(f"{OUT}: {os.path.getsize(OUT) / 1024:.0f} KB")


main()
