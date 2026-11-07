"""Builds the rides: the catalog's jetskis and snowboards, modelled, unwrapped, baked, painted and exported.

    /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \\
        --python art/ride/build.py -- [--out DIR] [--only MODEL,...] [--fast] [--preview DIR] [--shape] \\
        [--cache DIR]

Writes one .glb per model into apps/client/public/rides/ (one mesh, `ride`, skinned to the bones `ride` and, on a
jetski, `bars`; no materials), its textures (`<model>.detail.png`, grey: the paint's tint factors and marks;
`<model>.mask.png`: RGB how much of the main, second and accent colour, A how glossy) and manifest.json (the
models built). `--shape` only renders the shapes into the preview folder (no bake); `--cache` keeps the baked maps
to repaint without baking again. The wordmarks are set in Archivo, from the client's node_modules (`pnpm install`).
"""

import argparse
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(1, os.path.join(HERE, "..", "rider"))

import bpy  # noqa: E402
import numpy as np  # noqa: E402

import bake  # noqa: E402
import blend  # noqa: E402
import board  # noqa: E402
import jetski  # noqa: E402
import livery  # noqa: E402
import shapes  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
MODELS = list(jetski.SKIS) + list(board.BOARDS)


def args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", default=os.path.join(ROOT, "apps", "client", "public", "rides"))
    p.add_argument("--only", default=None)
    p.add_argument("--fast", action="store_true", help="smaller bakes, for quick looks")
    p.add_argument("--preview", default=None, help="also render look-test sheets into this folder")
    p.add_argument("--shape", action="store_true", help="only render the shapes (with --preview)")
    p.add_argument("--cache", default=None, help="keep the baked maps here and reuse them (to repaint quickly)")
    return p.parse_args(argv)


class Log:
    def __init__(self):
        self.t = time.time()

    def __call__(self, *msg):
        print(f"[{time.time() - self.t:6.1f}s]", *msg, flush=True)


def export(path, obj, arm):
    blend.deselect()
    arm.select_set(True)
    obj.select_set(True)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_materials="PLACEHOLDER",
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_skins=True,
        export_morph=False,
        export_animations=False,
        export_apply=False,
        export_yup=True,
        export_attributes=False,
        export_extras=False,
    )


def make(model):
    """The model's mesh (triangulated, hard edges split, unwrapped) and its armature."""
    if model in jetski.SKIS:
        b = jetski.build(model)
        bones = [("ride", (0, 0, 0), (0, 0.3, 0), None),
                 ("bars", tuple(jetski.PIVOT), tuple(jetski.PIVOT + (0, 0.12, 0)), "ride")]
    else:
        b = board.build(model)
        bones = [("ride", (0, 0, 0), (0, 0.3, 0), None)]
    obj = b.build("ride")
    shapes.finish_mesh(obj)
    arm = shapes.armature(bones)
    return obj, arm, [n for n, *_ in bones]


def shape_preview(o, model, obj):
    import look

    os.makedirs(o.preview, exist_ok=True)
    blend.shade_smooth(obj)
    obj.data.set_sharp_from_angle(angle=0.66)
    jet = model in jetski.SKIS
    target = (0, 0, 0.55) if jet else (0, 0, 0.08)
    dist = 5.0 if jet else 2.4
    look.sheet(os.path.join(o.preview, f"{model}.shape.a.png"), [obj], [(90, 5), (150, 25)], target, dist)
    look.sheet(os.path.join(o.preview, f"{model}.shape.b.png"), [obj], [(180, 22), (30, 15), (0, 3)], target, dist)
    if not jet:
        look.sheet(os.path.join(o.preview, f"{model}.shape.c.png"), [obj], [(60, 30), (200, 20), (110, 10)],
                   (0, -board.STANCE, 0.12), 0.9)


def baked(o, model, obj, size):
    """The model's baked maps (from the cache when it holds them for this very mesh)."""
    import hashlib

    uv = np.empty(len(obj.data.loops) * 2)
    obj.data.uv_layers.active.data.foreach_get("uv", uv)
    co = np.empty(len(obj.data.vertices) * 3)
    obj.data.vertices.foreach_get("co", co)
    key = f"{model}.{size}." + hashlib.sha1(np.round(np.concatenate([uv, co]), 5).tobytes()).hexdigest()[:12]
    path = os.path.join(o.cache, f"{key}.npz") if o.cache else None
    if path and os.path.exists(path):
        with np.load(path) as f:
            return dict(f)
    # (Occlusion only: the game's sun lights a ride, the paint only darkens what is tucked away.)
    maps = bake.bake_maps(obj, None, size, ao_distance=0.25 if model in jetski.SKIS else 0.05, light=False)
    if path:
        os.makedirs(o.cache, exist_ok=True)
        np.savez(path, **maps)
    return maps


def main():
    o = args()
    log = Log()
    only = o.only.split(",") if o.only else MODELS
    for model in only:
        blend.clear_scene()
        obj, arm, names = make(model)
        log(model, blend.tris(obj), "triangles")
        if o.shape:
            shape_preview(o, model, obj)
            continue
        shapes.unwrap(obj)
        size = 1024 if o.fast else 2048
        maps = baked(o, model, obj, size)
        detail, mask = livery.paint(model, maps)
        if size > 1024:
            detail, mask = bake.downsample(detail, 2), bake.downsample(mask, 2)
        a = obj.data.attributes.get("part")
        if a:
            obj.data.attributes.remove(a)
        shapes.skin(obj, arm, names)
        export(os.path.join(o.out, f"{model}.glb"), obj, arm)
        bake.save_png(os.path.join(o.out, f"{model}.detail.png"), detail, grey=True)
        bake.save_png(os.path.join(o.out, f"{model}.mask.png"), mask[..., :3], alpha=mask[..., 3])
        if o.preview:
            livery.preview(o.preview, model, obj, detail, mask)
        log(model, "exported")
    if not o.shape:
        manifest(o)


def manifest(o):
    """Lists what has been built (rides/manifest.json), so the client only asks for what exists."""
    import json

    out = sorted(f[: -len(".glb")] for f in os.listdir(o.out) if f.endswith(".glb"))
    with open(os.path.join(o.out, "manifest.json"), "w") as f:
        json.dump(out, f, indent=2)
        f.write("\n")


main()
