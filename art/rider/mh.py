"""Exports the riders' heads from MakeHuman (MPFB 2): the low-poly head of the `male1591` proxy, the detailed
head of the base mesh to bake from, the low-poly eyes and the brows.

Needs the MPFB extension and the MakeHuman system asset pack, unzipped (see art/rider/mh/README.md):

    /Applications/Blender.app/Contents/MacOS/Blender --background --python art/rider/mh.py -- \\
        --assets <asset pack folder> [--out art/rider/mh]

Writes `<body>.obj` (meshes `head`, `head.high`, `eyes`, `brows.<n>`, in MakeHuman's space and UVs, no
materials), its landmarks (`<body>.json`) and the textures the bakes use (`<body>.brow.<n>.png`,
`<body>.skin.png`).
"""

import argparse
import json
import os
import shutil
import sys

import bmesh
import bpy
import numpy as np
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__))

# The body's MakeHuman settings: an athletic young man, idealised proportions.
MALE = {
    "macro": {"gender": 1.0, "age": 0.5, "muscle": 0.7, "weight": 0.45, "height": 0.5, "proportions": 0.75,
              "cupsize": 0.5, "firmness": 0.5, "race": {"african": 0.15, "asian": 0.1, "caucasian": 0.75}},
    # A square jaw and a forward chin, high cheekbones over lean cheeks, a strong brow, no double chin; eyes a
    # little more open, and a smirk (one corner of the mouth up).
    "targets": {"head-square": 0.6, "chin-prominent-incr": 0.5, "chin-width-incr": 0.45, "chin-bones-incr": 0.5,
                "l-cheek-bones-incr": 0.7, "r-cheek-bones-incr": 0.7, "l-cheek-volume-decr": 0.6,
                "r-cheek-volume-decr": 0.6, "eyebrows-trans-forward": 0.7, "neck-double-decr": 0.8,
                "l-eye-scale-incr": 0.25, "r-eye-scale-incr": 0.25, "mouth-scale-horiz-incr": 0.2,
                "nose-point-width-decr": 0.3, "nose-scale-depth-incr": 0.2, "l-eye-height2-incr": 0.3,
                "r-eye-height2-incr": 0.3, "mouth-angles-up": 0.2, "asym-mouth-1-r": 0.45,
                "chin-height-decr": 0.2},
    "proxy": "proxymeshes/male1591/male1591.proxy",
    "skin": "skins/young_caucasian_male/young_lightskinned_male_diffuse.png",
    "brows": ["eyebrow008", "eyebrow009", "eyebrow003", "eyebrow005", "eyebrow007"],
}

# An athletic young woman, idealised proportions.
FEMALE = {
    "macro": {"gender": 0.0, "age": 0.5, "muscle": 0.62, "weight": 0.42, "height": 0.5, "proportions": 0.8,
              "cupsize": 0.5, "firmness": 0.6, "race": {"african": 0.15, "asian": 0.1, "caucasian": 0.75}},
    # An oval face with high cheekbones over lean cheeks and a defined (not square) jaw, a small straight nose,
    # eyes a little bigger and more open with the outer corners lifted, full lips with a clear cupid's bow and a
    # slight smile, brows a little raised.
    "targets": {"head-oval": 0.45, "l-cheek-bones-incr": 0.6, "r-cheek-bones-incr": 0.6, "l-cheek-volume-decr": 0.4,
                "r-cheek-volume-decr": 0.4, "chin-bones-incr": 0.25, "chin-prominent-incr": 0.2,
                "chin-width-decr": 0.15, "neck-double-decr": 0.8, "l-eye-scale-incr": 0.42, "r-eye-scale-incr": 0.42,
                "l-eye-height2-incr": 0.35, "r-eye-height2-incr": 0.35, "l-eye-corner2-up": 0.3,
                "r-eye-corner2-up": 0.3, "nose-scale-horiz-decr": 0.25, "nose-point-width-decr": 0.35,
                "nose-scale-vert-decr": 0.1, "nose-point-up": 0.15, "mouth-upperlip-volume-incr": 0.35,
                "mouth-lowerlip-volume-incr": 0.35, "mouth-cupidsbow-incr": 0.5, "mouth-angles-up": 0.3,
                "eyebrows-trans-up": 0.25, "eyebrows-angle-up": 0.2},
    "proxy": "proxymeshes/female1605/female1605.proxy",
    "skin": "skins/young_caucasian_female/young_lightskinned_female_diffuse.png",
    "brows": ["eyebrow002", "eyebrow001", "eyebrow011", "eyebrow010", "eyebrow004"],
}


def _both(**kw):
    """The same targets on both eyes (`eye-scale-incr=0.5` → l- and r-)."""
    return {f"{side}-{k.replace('_', '-')}": v for k, v in kw.items() for side in ("l", "r")}


# The face presets the creator offers, as targets over the body's own (0 is the body as designed). A target
# the body already has is replaced. `gain` scales the preset's whole change (Blender caps a target at 1):
# features have to read apart at portrait distance, on a face drawn in a few flat tones.
FACES = {
    "eyes": [
        {},
        # Narrow and keen: the upper lid low, the outer corners up.
        {"gain": 1.3, **_both(eye_height2_incr=0.0, eye_height1_decr=1.0, eye_height2_decr=0.5, eye_corner2_up=1.0,
                              eye_corner1_down=0.7)},
        # Big and round, a little wider apart.
        {"gain": 1.15, **_both(eye_height1_incr=1.0, eye_height2_incr=1.0, eye_height3_incr=0.7, eye_scale_incr=0.4,
                              eye_trans_out=0.4)},
        # Heavy lids, a calm look: the upper lid low and level over the eye, a fold above it.
        {"gain": 1.3, **_both(eye_height2_incr=0.0, eye_eyefold_down=1.0, eye_height1_decr=0.7, eye_bag_incr=0.6,
                              eye_eyefold_convex=0.6, eye_trans_in=0.3)},
        # Gentle: the outer corners well down, the inner up.
        {"gain": 1.9, **_both(eye_corner2_down=1.0, eye_corner1_up=1.0, eye_eyefold_angle_down=1.0,
                              eye_height2_incr=0.5)},
    ],
    "nose": [
        {},
        # Long and straight.
        {"gain": 1.3, "nose-scale-vert-incr": 1.0, "nose-scale-horiz-decr": 0.6, "nose-greek-incr": 1.0,
         "nose-point-down": 0.3, "nose-width1-decr": 0.5},
        # Broad.
        {"gain": 1.15, "nose-scale-horiz-incr": 1.0, "nose-nostrils-width-incr": 1.0, "nose-flaring-incr": 0.8,
         "nose-point-width-decr": 0.0, "nose-point-width-incr": 0.8, "nose-scale-depth-incr": 0.0,
         "nose-scale-depth-decr": 0.3},
        # Hooked.
        {"gain": 1.1, "nose-hump-incr": 1.0, "nose-point-down": 0.5, "nose-scale-vert-incr": 0.3,
         "nose-curve-convex": 0.6, "nose-scale-depth-incr": 0.3},
        # Small and upturned.
        {"gain": 1.4, "nose-point-up": 1.0, "nose-scale-vert-decr": 0.8, "nose-scale-depth-incr": 0.0,
         "nose-scale-depth-decr": 0.5, "nose-volume-decr": 0.6, "nose-nostrils-angle-up": 0.6},
    ],
    "mouth": [
        {},
        # Wide, thin lips, a grin.
        {"gain": 1.4, "mouth-scale-horiz-incr": 1.0, "mouth-upperlip-volume-decr": 0.8,
         "mouth-lowerlip-volume-decr": 0.4, "mouth-angles-up": 1.0, "asym-mouth-1-r": 0.0,
         "mouth-laugh-lines-out": 1.0},
        # Full lips.
        {"gain": 1.4, "mouth-upperlip-volume-incr": 1.0, "mouth-lowerlip-volume-incr": 1.0,
         "mouth-cupidsbow-incr": 1.0, "mouth-upperlip-height-incr": 0.8, "mouth-lowerlip-height-incr": 0.6,
         "mouth-scale-horiz-incr": 0.35},
        # Stern: level and thin, a little down at the corners.
        {"gain": 1.3, "mouth-angles-up": 0.0, "mouth-angles-down": 0.6, "asym-mouth-1-r": 0.0,
         "mouth-scale-horiz-incr": 0.3, "mouth-upperlip-volume-decr": 0.8, "mouth-upperlip-height-decr": 0.4,
         "mouth-lowerlip-volume-decr": 0.3},
        # Small, a pout.
        {"gain": 1.3, "mouth-scale-horiz-incr": 0.0, "mouth-scale-horiz-decr": 1.0,
         "mouth-lowerlip-volume-incr": 1.0, "mouth-upperlip-volume-incr": 0.6, "mouth-trans-forward": 0.3,
         "mouth-lowerlip-middle-down": 0.5, "asym-mouth-1-r": 0.0},
    ],
}

BODIES = {"male": MALE, "female": FEMALE}


def args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--assets", required=True, help="the MakeHuman system asset pack, unzipped")
    p.add_argument("--out", default=os.path.join(HERE, "mh"))
    p.add_argument("--faces", action="store_true", help="only the face presets (<body>.faces.json)")
    p.add_argument("--body", default=None, help="only these bodies (male, female)")
    return p.parse_args(argv)


def evaluated(obj):
    """A world-space bmesh of the object as it shows (shape keys, fitting and modifiers applied)."""
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = ev.to_mesh()
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.transform(obj.matrix_world)
    ev.to_mesh_clear()
    return bm


def _opposite(v, e):
    """The edge across a 4-valent vertex from `e`: the next edge of the loop."""
    if len(v.link_edges) != 4:
        return None
    fs = set(e.link_faces)
    nxt = [x for x in v.link_edges if x is not e and not (set(x.link_faces) & fs)]
    return nxt[0] if len(nxt) == 1 else None


def edge_loop(e0):
    loop, v, e = [e0], e0.verts[1], e0
    for _ in range(400):
        e = _opposite(v, e)
        if e is None:
            return None
        if e is e0:
            return loop
        loop.append(e)
        v = e.other_vert(v)
    return None


def neck_loop(bm):
    """The closed edge loop round the base of the neck: the lowest loop round the neck below the jaw."""
    bm.verts.ensure_lookup_table()
    co = np.array([v.co[:] for v in bm.verts])
    top = co[:, 2].max()
    best = None
    for v in bm.verts:
        if abs(v.co.x) > 0.004 or not (top - 0.32 < v.co.z < top - 0.2) or v.co.y > 0:
            continue
        for e in v.link_edges:
            o = e.other_vert(v)
            if abs(o.co.z - v.co.z) > 0.012 or abs(o.co.x) < 0.004:
                continue
            loop = edge_loop(e)
            if not loop:
                continue
            vs = {x for ed in loop for x in ed.verts}
            p = np.array([x.co[:] for x in vs])
            # Round the neck: narrower than the shoulders, wider than the mouth.
            if not (0.09 < np.ptp(p[:, 0]) < 0.2 and np.ptp(p[:, 1]) > 0.07):
                continue
            z = p[:, 2].mean()
            if best is None or z < best[0]:
                best = (z, loop)
    if best is None:
        raise RuntimeError("no neck loop found")
    return best[1]


def head_faces(bm, loop):
    """The faces above the neck loop (flood-filled from the crown without crossing it)."""
    cut = set(loop)
    crown = max(bm.verts, key=lambda v: v.co.z)
    seen = set(crown.link_faces)
    stack = list(seen)
    while stack:
        f = stack.pop()
        for e in f.edges:
            if e in cut:
                continue
            for g in e.link_faces:
                if g not in seen:
                    seen.add(g)
                    stack.append(g)
    return seen


def keep_faces(bm, keep):
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f not in keep], context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")


def to_object(bm, name):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def human_with(spec, assets, targets):
    """A new scene with the body's human (its targets replaced or added to by `targets`) and its proxy:
    (human, proxy, add) where `add(kind, path)` adds another asset."""
    from bl_ext.blender_org.mpfb.services.humanservice import HumanService
    from bl_ext.blender_org.mpfb.services.targetservice import TargetService

    bpy.ops.wm.read_factory_settings(use_empty=True)
    human = HumanService.create_human(macro_detail_dict=spec["macro"], scale=0.1)
    folder = os.path.join(os.path.dirname(sys.modules[HumanService.__module__].__file__), "..", "data", "targets")
    files = {f[: -len(".target.gz")]: os.path.join(d, f) for d, _, fs in os.walk(folder) for f in fs
             if f.endswith(".target.gz")}
    for name, value in {**spec["targets"], **targets}.items():
        if value:
            TargetService.load_target(human, files[name], weight=value)

    def add(kind, path):
        return HumanService.add_mhclo_asset(os.path.join(assets, path), human, asset_type=kind, subdiv_levels=0,
                                            set_up_rigging=False)

    return human, add("Proxymeshes", spec["proxy"]), add


def head_of(proxy):
    """The proxy's head (a bmesh, world space) and the loop round its neck."""
    low = evaluated(proxy)
    loop = neck_loop(low)
    return low, loop, head_faces(low, loop)


def faces(body, spec, assets, out):
    """Each face preset's head as offsets from the designed one (`<body>.faces.json`): per preset, the
    vertices of the `head` mesh it moves and by how much (MakeHuman's space, metres), and under "check" a few
    vertices of the designed head."""
    _, proxy, _ = human_with(spec, assets, {})
    low, _, head = head_of(proxy)
    keep_faces(low, head)
    base = np.array([v.co[:] for v in low.verts])
    low.free()
    # A few of the designed head's vertices, so a build can tell the presets still match its head.
    result = {"check": [[i, *(round(float(x), 6) for x in base[i])] for i in range(0, len(base), 61)]}
    for part, presets in FACES.items():
        for n, preset in enumerate(presets):
            if not preset:
                continue
            targets = {k: v for k, v in preset.items() if k != "gain"}
            _, proxy, _ = human_with(spec, assets, targets)
            low, _, head = head_of(proxy)
            keep_faces(low, head)
            co = np.array([v.co[:] for v in low.verts])
            low.free()
            if co.shape != base.shape:
                raise RuntimeError(f"{part} {n}: the head has {len(co)} vertices, not {len(base)}")
            d = (co - base) * preset.get("gain", 1.0)
            moved = np.nonzero(np.linalg.norm(d, axis=1) > 2e-6)[0]
            result[f"{part}.{n}"] = [[int(i), *(round(float(x), 6) for x in d[i])] for i in moved]
            print(body, part, n, len(moved), "vertices moved, at most", f"{np.abs(d).max() * 1000:.1f} mm")
    with open(os.path.join(out, f"{body}.faces.json"), "w") as f:
        f.write("{\n" + ",\n".join(f"  {json.dumps(k)}: {json.dumps(v, separators=(',', ':'))}"
                                    for k, v in result.items()) + "\n}\n")


def build(body, spec, assets, out):
    human, proxy, add = human_with(spec, assets, {})
    eyes = add("Eyes", "eyes/low-poly/low-poly.mhclo")
    brows = {}
    for i, b in enumerate(spec["brows"]):
        brows[i] = add("Eyebrows", f"eyebrows/{b}/{b}.mhclo")

    low, loop, head = head_of(proxy)
    # One more row of faces under the neck loop, so the detailed head reaches past the seam.
    below = {f for v in {x for e in loop for x in e.verts} for f in v.link_faces} - head
    tree = BVHTree.FromBMesh(low)
    face_of = {i: f for i, f in enumerate(low.faces)}
    keep_high = head | below
    high = evaluated(human)
    bmesh.ops.delete(high, geom=[f for f in high.faces if not keep_high_face(f, tree, face_of, keep_high)],
                     context="FACES")
    bmesh.ops.delete(high, geom=[v for v in high.verts if not v.link_faces], context="VERTS")
    keep_faces(low, head)
    marks = landmarks(low, evaluated(eyes))
    objs = [to_object(low, "head"), to_object(high, "head.high"), to_object(evaluated(eyes), "eyes")]
    objs += [to_object(evaluated(o), f"brows.{i}") for i, o in brows.items()]
    for o in (human, proxy, eyes, *brows.values()):
        bpy.data.objects.remove(o)
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    os.makedirs(out, exist_ok=True)
    # OBJ keeps the quads and the UVs as they are (glTF would triangulate and split them).
    bpy.ops.wm.obj_export(filepath=os.path.join(out, f"{body}.obj"), export_selected_objects=True,
                          export_materials=False, export_uv=True, export_normals=False, apply_modifiers=False)
    for i, b in enumerate(spec["brows"]):
        shutil.copy(os.path.join(assets, f"eyebrows/{b}/{b}.png"), os.path.join(out, f"{body}.brow.{i}.png"))
    # The skin's colour (where the lips, the stubble and the warm cheeks are), at the size the bakes need.
    img = bpy.data.images.load(os.path.join(assets, spec["skin"]))
    img.scale(1024, 1024)
    img.filepath_raw = os.path.join(out, f"{body}.skin.png")
    img.file_format = "PNG"
    img.save()
    with open(os.path.join(out, f"{body}.json"), "w") as f:
        f.write("{\n" + ",\n".join(f"  {json.dumps(k)}: {json.dumps(v)}" for k, v in marks.items()) + "\n}\n")
    print(body, "head", len(objs[0].data.polygons), "faces; detailed", len(objs[1].data.polygons))


def landmarks(head, eyes):
    """Where things sit on the head (MakeHuman's space): the eyes, the ears, the skull's middle, the crown."""
    co = np.array([v.co[:] for v in head.verts])
    ec = np.array([v.co[:] for v in eyes.verts])
    eye_l = ec[ec[:, 0] > 0].mean(axis=0)
    eye_r = ec[ec[:, 0] < 0].mean(axis=0)
    eye_z = float((eye_l[2] + eye_r[2]) / 2)
    band = co[np.abs(co[:, 2] - eye_z) < 0.02]
    ear = band[np.argmax(band[:, 0])]
    upper = co[co[:, 2] > eye_z]
    centre = [0.0, float((upper[:, 1].min() + upper[:, 1].max()) / 2), eye_z]
    return {"eye_l": eye_l.tolist(), "eye_r": eye_r.tolist(), "ear": ear.tolist(), "centre": centre,
            "crown": float(co[:, 2].max()), "front": float(upper[:, 1].min()), "back": float(upper[:, 1].max())}


def keep_high_face(f, tree, face_of, keep):
    _, _, idx, _ = tree.find_nearest(f.calc_center_median())
    return idx is not None and face_of[idx] in keep


def main():
    o = args()
    for body in o.body.split(",") if o.body else BODIES:
        (faces if o.faces else build)(body, BODIES[body], o.assets, o.out)


main()
