"""Builds the riders: box-modelled cages with MakeHuman's head (art/rider/mh), subdivided, rigged, baked,
painted and exported.

    /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \\
        --python art/rider/build.py -- [--out DIR] [--only NAME,...] [--fast] [--preview DIR] [--ref PNG]

Writes one .glb per model (meshes, skin, no materials) and its textures
(`<model>.<part>.detail.png`, `<model>.<part>.mask.png`, and the face's colour without its light,
`body.face.flat.png`) into apps/client/public/riders/<body>/.
"""

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bmesh  # noqa: E402
import bpy  # noqa: E402
import numpy as np  # noqa: E402

import bake  # noqa: E402
import blend  # noqa: E402
import hair  # noqa: E402
import headwear  # noqa: E402
import kit  # noqa: E402
import male  # noqa: E402
import mhface  # noqa: E402
import mhhead  # noqa: E402
import rig  # noqa: E402
import rings  # noqa: E402
import skin  # noqa: E402
import uv  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", default=os.path.join(ROOT, "apps", "client", "public", "riders"))
    p.add_argument("--only", default=None)
    p.add_argument("--fast", action="store_true", help="smaller bakes, for quick looks")
    p.add_argument("--preview", default=None, help="also render look-test sheets into this folder")
    p.add_argument("--ref", default=None, help="a reference image to put beside the look tests")
    return p.parse_args(argv)


class Log:
    def __init__(self):
        self.t = time.time()

    def __call__(self, *msg):
        print(f"[{time.time() - self.t:6.1f}s]", *msg, flush=True)


def keep_normals(obj):
    """Stores the whole mesh's smooth normals per vertex (`_nrm`), so pieces cut off later keep them."""
    blend.shade_smooth(obj)
    me = obj.data
    n = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("normal", n)
    a = me.attributes.new("_nrm", "FLOAT_VECTOR", "POINT")
    a.data.foreach_set("vector", n)


def restore_normals(obj):
    """Sets the stored normals as the mesh's custom normals."""
    me = obj.data
    a = me.attributes["_nrm"]
    n = np.empty(len(me.vertices) * 3)
    a.data.foreach_get("vector", n)
    n = n.reshape(-1, 3)
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
    blend.shade_smooth(obj)
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


def tag_regions(obj):
    """Cuts the mesh where body regions meet and tags every vertex with its region (`_region`),
    so a garment can hide whole regions without a face straddling two."""
    reg = rings.attribute(obj, "region")
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


def strip(obj, names):
    for n in names:
        a = obj.data.attributes.get(n)
        if a:
            obj.data.attributes.remove(a)


def assign(obj, slots, idx):
    obj.data.materials.clear()
    for s in slots:
        obj.data.materials.append(bpy.data.materials.get(s) or bpy.data.materials.new(s))
    obj.data.polygons.foreach_set("material_index", np.asarray(idx, dtype=np.int32))
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
        export_morph=False,
        export_animations=False,
        export_apply=False,
        export_yup=True,
        export_attributes=True,
        export_extras=True,
    )


# Texel density by body part: the face gets the most, the feet (always in shoes) the least.
DENSITY = {"head": 2.1, "eye": 3.0, "mouth": 1.0, "ear": 1.2, "neck": 1.0, "torso": 0.85, "arm": 1.0, "thumb": 1.0, "finger": 1.1, "leg": 0.9}


def face_textures(face_piece, src, size, cage):
    """What MakeHuman's textures show on the face: the skin's colour and the brows."""
    tex = os.path.join(mhhead.SOURCE, "")
    head = src["head.high"]
    return {
        "skin": bake.bake_textured(face_piece, [(head, tex + "skin.png", "rgb")], size, cage=cage),
        "brow": bake.bake_textured(face_piece, [(head, None, None), (src["brows.0"], tex + "brow.0.png", "a")],
                                   size, cage=cage),
    }


def bake_cage(piece, parts, push=0.008, eye_push=0.0012):
    """A copy of the face pushed out along its normals, only a little over the eyes (the lids are in front)."""
    eye = parts.get("eye", -1)
    c = rings.copy(piece, f"{piece.name}.cage")
    part = rings.attribute(c, "part")
    me = c.data
    co = np.empty(len(me.vertices) * 3)
    n = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    me.vertices.foreach_get("normal", n)
    d = np.where(part == eye, eye_push, push)[:, None]
    me.vertices.foreach_set("co", (co.reshape(-1, 3) + n.reshape(-1, 3) * d).ravel())
    me.update()
    c.hide_render = True
    return c


def build_body(o, log):
    size = 1024 if o.fast else 2048
    blend.clear_scene()
    arm = rig.armature(male.J, male.TAILS)
    src = mhhead.Source("male")
    cage, off = male.build_cage(src)
    cage.name = "cage"
    names = {v: k for k, v in cage["parts"].items()}
    part = rings.attribute(cage, "part")
    me = cage.data
    face_of = []
    for p in me.polygons:
        ps = {names.get(int(part[v]), "") for v in p.vertices}
        face_of.append(1 if ps and all(n in ("head", "eye", "mouth") or n.startswith("ear") for n in ps) else 0)
    assign(cage, ["skin", "face"], face_of)
    uv.unwrap(cage)
    layer_names = names

    def density(bm, f):
        lay = bm.verts.layers.int.get("part")
        ps = [layer_names.get(v[lay], "torso") for v in f.verts]
        base = [DENSITY.get(n.split(".")[0], 1.0) for n in ps]
        d = float(np.mean(base))
        c = f.calc_center_median()
        if all(n in ("head", "mouth") for n in ps):
            d = 3.2 if c.y < mhhead.landmark("centre")[1] - 0.045 else 0.7
        # Feet: below the ankles.
        if np.mean([v.co.z for v in f.verts]) < 0.075:
            d *= 0.35
        return d

    uv.scale_islands(cage, density)
    uv.pack(cage, 0)
    uv.pack(cage, 1)
    log("cage", len(me.polygons), "faces, unwrapped")
    low = rings.copy(cage, "body")
    rings.subdivide(low, 1)
    high = rings.copy(cage, "body.high")
    rings.subdivide(high, 3)
    blend.shade_smooth(high)
    face_high = mhhead.high(src, off, dict(cage["parts"]))
    mhhead.tag_parts(face_high, cage, dict(cage["parts"]))
    blend.shade_smooth(face_high)
    cage.hide_render = True
    keep_normals(low)
    rig.limit(low)
    parts = split_by_material(low)
    tag_regions(parts["skin"])
    for piece in parts.values():
        restore_normals(piece)
    log("low", sum(len(p.data.polygons) for p in parts.values()), "faces; high", len(high.data.polygons))
    textures = {}
    portrait = {"light_front": dict(key=(-0.75, -1.0, 0.8), key_power=3.0, softness=20.0, sky=(0.17, 0.18, 0.19),
                                    ground=(0.05, 0.045, 0.04))}
    baked = {}
    face_cage = bake_cage(parts["face"], dict(cage["parts"]))
    for name, piece in parts.items():
        hi = face_high if name == "face" else high
        other = face_high if hi is high else high
        other.hide_render, hi.hide_render = True, False
        baked[name] = bake.bake_maps(piece, hi, size, extra_lights=portrait if name == "face" else None,
                                     cage=face_cage if name == "face" else None)
        other.hide_render = False
    for maps in baked.values():
        maps["parts"] = dict(names)
    face_high.hide_render = True
    head_tex = face_textures(parts["face"], src, size, face_cage)
    bpy.data.objects.remove(face_cage)
    log("baked")
    ref = skin.light_reference(baked["skin"])
    flat = None
    for name, maps in baked.items():
        if name == "face":
            detail, mask = mhface.paint_face(maps, ref, head_tex)
            flat, _ = mhface.paint_face(maps, ref, head_tex, flat=True)
        else:
            detail, mask = skin.paint_skin(maps, ref)
        if size > 1024:
            f = size // 1024
            detail, mask = bake.downsample(detail, f), bake.downsample(mask, f)
            if name == "face":
                flat = bake.downsample(flat, f)
        textures[name] = (detail, mask)
    high.hide_render = True
    for name, piece in parts.items():
        # The face keeps more of its painted light: a portrait reads from any side.
        piece["finish"] = {"roughness": 0.75, "rim": 0.5, "flat": 0.78 if name == "face" else 0.5}
        piece["tints"] = "look"
        strip(piece, ["part", "region", "_nrm"])
        rig.bind(piece, arm)
    out = os.path.join(o.out, "male")
    export(os.path.join(out, "body.glb"), list(parts.values()), arm)
    for name, (detail, mask) in textures.items():
        bake.save_png(os.path.join(out, f"body.{name}.detail.png"), detail)
        bake.save_png(os.path.join(out, f"body.{name}.mask.png"), mask)
    # The face's colour without its light, for shaders that light it themselves (at half size: plain colour).
    bake.save_png(os.path.join(out, "body.face.flat.png"), bake.downsample(flat, 2))
    src.remove()
    log("exported", out)
    return parts, arm, textures, high


def build_hair(o, log, high, arm):
    """Hair 0, as it falls freely and as it shows under a cap."""
    size = 1024 if o.fast else 2048
    high.hide_render = False
    head = hair.Head(high)
    pieces = {"free": hair.helmet(head), "cap": hair.helmet(head, under_cap=True)}
    textures = {}
    for name, piece in pieces.items():
        blend.shade_smooth(piece)
        others = [p for p in pieces.values() if p is not piece]
        for p in others:
            p.hide_render = True
        # Under a cap only a band shows: half the texture.
        maps = bake.bake_maps(piece, None, size // 2 if name == "cap" else size, ao_distance=0.05)
        for p in others:
            p.hide_render = False
        detail, mask = hair.paint_hair(maps)
        f = detail.shape[0] // (512 if name == "cap" else 1024)
        if f > 1:
            detail, mask = bake.downsample(detail, f), bake.downsample(mask, f)
        textures[name] = (detail, mask)
        piece["finish"] = {"roughness": 0.9, "rim": 0.4}
        piece["tints"] = "hair"
        rig.bind(piece, arm)
        log("hair", name, len(piece.data.polygons), "faces")
    high.hide_render = True
    out = os.path.join(o.out, "male")
    export(os.path.join(out, "hair.0.glb"), list(pieces.values()), arm)
    for name, (detail, mask) in textures.items():
        bake.save_png(os.path.join(out, f"hair.0.{name}.detail.png"), detail)
        bake.save_png(os.path.join(out, f"hair.0.{name}.mask.png"), mask)
    # Piece names are only unique within a model: free them for the next ones.
    for name, piece in pieces.items():
        piece.name = piece.data.name = f"hair.0.{name}"
    return pieces, textures


def build_garment(o, log, model, pieces, painter, body, arm, hides=(), finish=None, size=1024, rigid=None):
    """Exports a catalog model: its pieces fitted, weighted from the body (or all on one bone), baked and
    painted. `painter` and `finish` may be per piece (dicts by piece name)."""
    size = size // 2 if o.fast else size
    textures = {}
    for name, piece in pieces.items():
        blend.shade_smooth(piece)
        rig.transfer(body, piece, rigid=rigid)
        maps = bake.bake_maps(piece, None, size * 2, ao_distance=0.06)
        paint = painter[name] if isinstance(painter, dict) else painter
        detail, mask = paint(maps)
        textures[name] = (bake.downsample(detail, 2), bake.downsample(mask, 2))
        fin = finish.get(name) if isinstance(finish, dict) and name in finish else finish
        piece["finish"] = fin if isinstance(fin, dict) and "roughness" in fin else {"roughness": 0.7, "rim": 0.35}
        piece["tints"] = "kit"
        piece["hides"] = [male.REGIONS.index(r) for r in hides]
        rig.bind(piece, arm)
        log(model, name, len(piece.data.polygons), "faces")
    out = os.path.join(o.out, "male")
    names = [p.name for p in pieces.values()]
    if names != list(pieces):
        raise RuntimeError(f"{model}: pieces named {names}, expected {list(pieces)}")
    export(os.path.join(out, f"{model}.glb"), list(pieces.values()), arm)
    for name, (detail, mask) in textures.items():
        bake.save_png(os.path.join(out, f"{model}.{name}.detail.png"), detail)
        bake.save_png(os.path.join(out, f"{model}.{name}.mask.png"), mask)
    for name, piece in pieces.items():
        piece.name = piece.data.name = f"{model}.{name}"
    return textures


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
    parts, arm, textures, high = build_body(o, log)
    hair_pieces, hair_tex = build_hair(o, log, high, arm)
    body = kit.Body(high)
    vest = {"vest": kit.vest(body)}
    vest_tex = build_garment(o, log, "summer.vest.foam", vest, kit.paint_vest, parts["skin"], arm,
                             hides=("torso",), finish={"roughness": 0.55, "rim": 0.35})
    shorts = {"shorts": kit.shorts()}
    shorts_tex = build_garment(o, log, "summer.bottom.boardshorts", shorts, kit.paint_shorts, parts["skin"], arm,
                               hides=("hips", "thighs"), finish={"roughness": 0.75, "rim": 0.3})
    shoes = {"shoes": kit.shoes()}
    shoes_tex = build_garment(o, log, "summer.feet.watershoes", shoes, kit.paint_shoes, parts["skin"], arm,
                              hides=("feet",), finish={"roughness": 0.65, "rim": 0.3}, size=512)
    head = hair.Head(high)
    cap = {"cap": headwear.cap(head)}
    build_garment(o, log, "summer.head.cap", cap, headwear.paint_cap, parts["skin"], arm,
                  finish={"roughness": 0.8, "rim": 0.3}, size=512, rigid="head")
    shades = headwear.shades(head)
    build_garment(o, log, "summer.eyes.shades", shades, {"frame": headwear.paint_frame, "lens": headwear.paint_lens},
                  parts["skin"], arm, size=256, rigid="head",
                  finish={"frame": {"roughness": 0.35, "rim": 0.3}, "lens": {"roughness": 0.12, "metalness": 0.4,
                                                                             "rim": 0.5}})
    for o_ in list(cap.values()) + list(shades.values()):
        o_.hide_render = True
    if o.preview:
        import lookdev

        RED = (0xD9382E, 0x1C1D21, 0xF2F0EA)
        BLACK = (0x1C1D21, 0x8A8F96, 0xD9382E)
        GREY = (0x8A8F96, 0x1C1D21, 0xF07A1E)
        hair_pieces["cap"].hide_render = True
        pieces = {**parts, "hair": hair_pieces["free"], "vest": vest["vest"], "shorts": shorts["shorts"],
                  "shoes": shoes["shoes"]}
        tex = {**textures, "hair": hair_tex["free"], "vest": vest_tex["vest"], "shorts": shorts_tex["shorts"],
               "shoes": shoes_tex["shoes"]}
        lookdev.textured_sheet(o.preview, pieces, tex, ref=o.ref,
                               tints={"hair": (lookdev.HAIR,) * 3, "vest": RED, "shorts": BLACK, "shoes": GREY})
        log("preview", o.preview)
    manifest(o)


main()
