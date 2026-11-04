"""Builds the riders: sculpts, retopologizes, rigs, bakes, paints and exports them.

    /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \\
        --python art/rider/build.py -- [--out DIR] [--preview DIR] [--only NAME,...] [--fast]

Writes one .glb per model (meshes, skin, no materials) and its textures
(`<model>.<part>.detail.png`, `<model>.<part>.mask.png`) into
apps/client/public/riders/<body>/.
"""

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
import numpy as np  # noqa: E402

import bake  # noqa: E402
import blend  # noqa: E402
import headwear  # noqa: E402
import kit  # noqa: E402
import male  # noqa: E402
import paint  # noqa: E402
import rig  # noqa: E402
import uv  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", default=os.path.join(ROOT, "apps", "client", "public", "riders"))
    p.add_argument("--preview", default=None)
    p.add_argument("--only", default=None)
    p.add_argument("--fast", action="store_true", help="coarser sculpts and bakes, for quick looks")
    return p.parse_args(argv)


class Log:
    def __init__(self):
        self.t = time.time()

    def __call__(self, *msg):
        print(f"[{time.time() - self.t:6.1f}s]", *msg, flush=True)


def custom_normals(obj, shape, soft=0.002, softer=None, adjust=None):
    """Shades the low mesh with the sculpt's own normals (its distance field's gradient), measured
    over `soft` metres so small forms don't catch hard light; `softer(points)` picks points measured
    over twice that. Pieces split off later keep the same shading across the cut."""
    import sdf

    me = obj.data
    blend.shade_smooth(obj)
    v = blend.verts(obj)
    n = sdf.gradient(shape, v, h=soft)
    if softer is not None:
        pick = softer(v)
        if pick.any():
            n[pick] = sdf.gradient(shape, v[pick], h=soft * 2.5)
    if adjust is not None:
        n = adjust(v, n)
    me.normals_split_custom_set_from_vertices(n.tolist())


def split_by_material(obj):
    blend.select_only(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.separate(type="MATERIAL")
    bpy.ops.object.mode_set(mode="OBJECT")
    out = {}
    for o in bpy.context.selected_objects:
        name = o.data.materials[0].name
        o.name = o.data.name = name
        out[name] = o
    return out


def split_regions(obj, regions):
    """Cuts the mesh where body regions meet and tags every vertex with its region (`_region`),
    so a garment can hide whole regions without a face straddling two."""
    import bmesh

    n = len(obj.data.polygons)
    c = np.empty(n * 3)
    obj.data.polygons.foreach_get("center", c)
    reg = regions(c.reshape(n, 3))
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    cut = [e for e in bm.edges if len(e.link_faces) == 2 and reg[e.link_faces[0].index] != reg[e.link_faces[1].index]]
    bmesh.ops.split_edges(bm, edges=cut)
    bm.to_mesh(obj.data)
    bm.free()
    vreg = np.zeros(len(obj.data.vertices))
    for p in obj.data.polygons:
        for v in p.vertices:
            vreg[v] = reg[p.index]
    attr = obj.data.attributes.new("_region", "FLOAT", "POINT")
    attr.data.foreach_set("value", vreg)


def assign(obj, slots, pick):
    """Material slots by face: `pick(centres)` returns the slot index of each face."""
    obj.data.materials.clear()
    for s in slots:
        obj.data.materials.append(bpy.data.materials.get(s) or bpy.data.materials.new(s))
    n = len(obj.data.polygons)
    c = np.empty(n * 3)
    obj.data.polygons.foreach_get("center", c)
    idx = pick(c.reshape(n, 3)).astype(np.int32)
    obj.data.polygons.foreach_set("material_index", idx)
    obj.data.update()


def export(path, objects, arm):
    blend.deselect()
    arm.select_set(True)
    for o in objects:
        o.select_set(True)
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
        export_morph=True,
        export_morph_normal=True,
        export_animations=False,
        export_apply=False,
        export_yup=True,
        export_attributes=True,
        export_extras=True,
    )


def build_body(o, log):
    voxel = 0.004 if o.fast else 0.0028
    size = 512 if o.fast else 1024
    blend.clear_scene()
    arm = rig.armature(male.J, male.TAILS)
    shape = male.body()
    high = blend.sdf_mesh(shape, voxel, "body.high")
    high.data.uv_layers.new(name="uv")
    log("sculpt", len(high.data.polygons), "faces")
    low = high.copy()
    low.data = high.data.copy()
    low.name = "body"
    blend.link(low)
    # The face keeps more of its detail.
    blend.decimate(low, 7600, region=male.in_head(blend.verts(low)), region_faces=1800)
    log("decimated", len(low.data.polygons), "faces")
    custom_normals(low, shape, softer=male.in_head, adjust=male.face_normals)
    assign(low, ["skin", "face"], lambda c: male.in_head(c))
    parts = split_by_material(low)
    split_regions(parts["skin"], male.regions)
    uv.head(parts["face"], male.in_ear)
    bake.uv_unwrap(parts["skin"], margin=0.006)
    chains = male.chains()
    for name, part in parts.items():
        rig.sculpt_weights(part, chains, male.J, male.TAILS)
        rig.bind(part, arm)
        log("rigged", name)
    maps = {}
    for name, part in parts.items():
        maps[name] = bake.bake_maps(part, high, size)
        log("baked", name)
    textures = paint.body(maps, male)
    bpy.data.objects.remove(high)
    for name, part in parts.items():
        part["finish"] = {"roughness": 0.55, "rim": 0.55}
        part["tints"] = "look"
    out = os.path.join(o.out, "male")
    export(os.path.join(out, "body.glb"), list(parts.values()), arm)
    for name, (detail, mask) in textures.items():
        bake.save_png(os.path.join(out, f"body.{name}.detail.png"), detail)
        bake.save_png(os.path.join(out, f"body.{name}.mask.png"), mask)
    log("exported", out)
    return parts, arm


def build_garment(o, log, garment, body, arm):
    out = os.path.join(o.out, "male")
    objects = []
    for piece in garment.pieces:
        voxel = piece.voxel * (1.4 if o.fast else 1.0)
        size = piece.size // (2 if o.fast else 1)
        high = blend.sdf_mesh(piece.shape, voxel, f"{piece.name}.high")
        high.data.uv_layers.new(name="uv")
        low = high.copy()
        low.data = high.data.copy()
        low.name = low.data.name = piece.name
        blend.link(low)
        blend.decimate(low, piece.faces)
        custom_normals(low, piece.shape, soft=0.0015)
        bake.uv_unwrap(low, margin=0.008)
        rig.transfer(body, low, rigid=piece.rigid)
        rig.bind(low, arm)
        maps = bake.bake_maps(low, high, size, extrusion=piece.extrusion, ray=piece.extrusion * 3)
        detail, mask = piece.paint(paint.Canvas(maps), maps)
        bake.save_png(os.path.join(out, f"{garment.model}.{piece.name}.detail.png"), detail)
        bake.save_png(os.path.join(out, f"{garment.model}.{piece.name}.mask.png"), mask)
        bpy.data.objects.remove(high)
        low["finish"] = piece.finish
        low["tints"] = piece.tints
        low["hides"] = [male.REGIONS.index(r) for r in garment.hides]
        objects.append(low)
        log(garment.model, piece.name, blend.tris(low), "tris")
    export(os.path.join(out, f"{garment.model}.glb"), objects, arm)
    for obj in objects:
        bpy.data.objects.remove(obj)


def manifest(o):
    """Lists what has been built (riders/manifest.json), so the client only asks for what exists."""
    import json

    out = {}
    for body in sorted(os.listdir(o.out)):
        d = os.path.join(o.out, body)
        if os.path.isdir(d):
            out[body] = sorted(f[: -len(".glb")] for f in os.listdir(d) if f.endswith(".glb"))
    with open(os.path.join(o.out, "manifest.json"), "w") as f:
        json.dump(out, f, indent=2)
        f.write("\n")


def main():
    o = args()
    log = Log()
    only = set(o.only.split(",")) if o.only else None
    parts, arm = build_body(o, log)
    for model, make in {**kit.GARMENTS, **headwear.MODELS}.items():
        if only is None or model in only:
            build_garment(o, log, make(), parts["skin"], arm)
    manifest(o)


main()
