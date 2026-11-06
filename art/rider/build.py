"""Builds the riders: box-modelled cages with MakeHuman's head (art/rider/mh), subdivided, rigged, baked,
painted and exported.

    /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \\
        --python art/rider/build.py -- [--out DIR] [--body male,female] [--only NAME,...] [--fast] \\
        [--preview DIR] [--ref PNG]

Writes one .glb per model (meshes, skin, no materials; the face's presets as morph targets) and its textures
(`<model>.<part>.detail.png` in grey, `<model>.<part>.mask.png`, the face's colour without its light,
`body.face.flat.png`, the brows and beards it can wear, `body.face.brows.<n>.png` and
`body.face.beard.<n>.png`, and the eye, nose and mouth presets' paint, `body.face.<part>.<n>.png`) into
apps/client/public/riders/<body>/.
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
import figure  # noqa: E402
import hair  # noqa: E402
import hairdo  # noqa: E402
import headwear  # noqa: E402
import kit  # noqa: E402
from female import FEMALE  # noqa: E402
from male import MALE  # noqa: E402
import mhface  # noqa: E402
import mhhead  # noqa: E402
import rig  # noqa: E402
import rings  # noqa: E402
import skin  # noqa: E402
import uv  # noqa: E402
import winter  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", default=os.path.join(ROOT, "apps", "client", "public", "riders"))
    p.add_argument("--body", default=None, help="only these bodies (male, female)")
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


def suit_regions(obj, fig, margin=0.003):
    """Moves the faces wholly under the swimsuit (kit.suit_field, `margin` inside its edges) into the `suit.`
    regions of the regions they were in."""
    reg = rings.attribute(obj, "region")
    me = obj.data
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    yc = np.interp(co[:, 2], [r[0] for r in fig.TORSO], [r[4] for r in fig.TORSO])
    th = np.degrees(np.arctan2(co[:, 0], -(co[:, 1] - yc))) % 360
    inside = kit.suit_field(th, co[:, 2], straps=False) > margin
    moved = {figure.R[n]: figure.R[f"suit.{n}"] for n in ("torso", "hips", "flanks")}
    for p in me.polygons:
        if reg[p.index] in moved and all(inside[v] for v in p.vertices):
            reg[p.index] = moved[reg[p.index]]
    me.attributes["region"].data.foreach_set("value", reg.astype(np.int32))


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


def coords(obj):
    co = np.empty(len(obj.data.vertices) * 3)
    obj.data.vertices.foreach_get("co", co)
    return co.reshape(-1, 3)


def preset_offsets(cage, low, off, src, levels=1):
    """Stores each face preset's offsets of the game mesh's vertices on it (`_m.<preset>` attributes): the
    cage moved by the preset and subdivided like the game mesh, less the game mesh."""
    base = coords(low)
    for name, d in mhhead.face_presets(cage, off, src).items():
        c = rings.copy(cage, f"cage.{name}")
        c.data.vertices.foreach_set("co", (coords(c) + d).ravel())
        c.data.update()
        rings.subdivide(c, levels)
        moved = coords(c)
        bpy.data.objects.remove(c)
        if moved.shape != base.shape:
            raise RuntimeError(f"face preset {name}: {len(moved)} vertices, the game mesh has {len(base)}")
        a = low.data.attributes.new(f"_m.{name}", "FLOAT_VECTOR", "POINT")
        a.data.foreach_set("vector", (moved - base).ravel())


def preset_normals(obj, names):
    """Stores the mesh's vertex normals (`_n`) and each face preset's (`_n.<preset>`, with the mesh moved by its
    `_m.<preset>` offsets) on it."""
    me = obj.data
    base = coords(obj)

    def store(name):
        n = np.empty(len(me.vertices) * 3)
        me.vertices.foreach_get("normal", n)
        a = me.attributes.new(name, "FLOAT_VECTOR", "POINT")
        a.data.foreach_set("vector", n)

    store("_n")
    for name in names:
        d = np.empty(len(base) * 3)
        me.attributes[name].data.foreach_get("vector", d)
        me.vertices.foreach_set("co", (base + d.reshape(-1, 3)).ravel())
        me.update()
        store(f"_n.{name[3:]}")
    me.vertices.foreach_set("co", base.ravel())
    me.update()


def morphs_from_offsets(obj, log):
    """Turns the `_m.<preset>` attributes into shape keys (glTF morph targets), where they move anything."""
    names = [a.name for a in obj.data.attributes if a.name.startswith("_m.")]
    base = coords(obj)
    keys = []
    for n in names:
        d = np.empty(len(base) * 3)
        obj.data.attributes[n].data.foreach_get("vector", d)
        d = d.reshape(-1, 3)
        if np.abs(d).max() > 1e-6:
            keys.append((n[3:], d))
        obj.data.attributes.remove(obj.data.attributes[n])
    if keys:
        obj.shape_key_add(name="Basis", from_mix=False)
        for n, d in keys:
            k = obj.shape_key_add(name=n, from_mix=False)
            k.data.foreach_set("co", (base + d).ravel())
        log(obj.name, "morphs", ", ".join(n for n, _ in keys), f"(at most {np.abs([d for _, d in keys]).max() * 1000:.1f} mm)")


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
        export_morph=True,
        export_morph_normal=False,
        export_morph_tangent=False,
        export_morph_animation=False,
        export_try_sparse_sk=True,
        export_animations=False,
        export_apply=False,
        export_yup=True,
        export_attributes=True,
        export_extras=True,
    )


# Texel density by body part: the face gets the most, the feet (always in shoes) the least.
DENSITY = {"head": 2.1, "eye": 3.0, "mouth": 1.0, "ear": 1.2, "neck": 1.0, "torso": 0.85, "arm": 1.0, "thumb": 1.0, "finger": 1.1, "leg": 0.9}


def face_textures(face_piece, src, size, cage):
    """What MakeHuman's textures show on the face: the skin's colour and each brow."""
    tex = os.path.join(mhhead.SOURCE, f"{src.body}.")
    head = src["head.high"]
    out = {"skin": bake.bake_textured(face_piece, [(head, tex + "skin.png", "rgb")], size, cage=cage)}
    for i in range(BROWS):
        out[f"brow.{i}"] = bake.bake_textured(face_piece, [(head, None, None),
                                                           (src[f"brows.{i}"], tex + f"brow.{i}.png", "a")],
                                              size, cage=cage)
    return out


BROWS = 5
# Beards (presets 1-4; 0 is none) are for male bodies only.
BEARDS = {"male": 5, "female": 1}


def bake_cage(piece, parts, push=0.008, eye_push=0.0012):
    """A copy of the face pushed out along its normals, only a little over the eyes (the lids are in front)."""
    eye = parts.get("eye", -1)
    c = rings.copy(piece, f"{piece.name}.cage")
    # (Without the presets' shape keys, which would keep the vertices where they were.)
    if c.data.shape_keys:
        c.shape_key_clear()
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


def build_body(o, log, fig, bake_it=True):
    """A body (rigged pieces, the armature and the detailed mesh), baked, painted and exported unless
    `bake_it` is false (when only the garments fitted to it are wanted)."""
    size = 1024 if o.fast else 2048
    blend.clear_scene()
    arm = rig.armature(fig.J, fig.TAILS)
    src = mhhead.Source(fig.name)
    cage, off = fig.build_cage(src)
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
            d = 3.2 if c.y < mhhead.landmark("centre", fig.name)[1] - 0.045 else 0.7
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
    preset_offsets(cage, low, off, src)
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
    if fig.SWIMSUIT:
        suit_regions(parts["skin"], fig)
    tag_regions(parts["skin"])
    for piece in parts.values():
        restore_normals(piece)
    log("low", sum(len(p.data.polygons) for p in parts.values()), "faces; high", len(high.data.polygons))
    if not bake_it:
        face_high.hide_render = high.hide_render = True
        src.remove()
        return parts, arm, {}, high
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
        maps["fig"] = fig
    face_high.hide_render = True
    head_tex = face_textures(parts["face"], src, size, face_cage)
    bpy.data.objects.remove(face_cage)
    # Where each face preset moves the face's surface, and which way the surface faces then, per texel.
    names = [a.name for a in parts["face"].data.attributes if a.name.startswith("_m.")]
    preset_normals(parts["face"], names)
    maps = bake.bake_attributes(parts["face"], names + ["_n"] + [f"_n.{n[3:]}" for n in names], size)
    offsets = {k[3:]: v for k, v in maps.items() if k.startswith("_m.")}
    normals = {k[3:] or "": v for k, v in maps.items() if k.startswith("_n")}
    log("baked")
    ref = skin.light_reference(baked["skin"])
    overlays = {f"brows.{i}": mhface.brows(baked["face"], head_tex[f"brow.{i}"], i) for i in range(BROWS)}
    overlays.update({f"beard.{k}": mhface.beard(baked["face"], head_tex, k) for k in range(1, BEARDS[fig.name])})
    features = mhface.features(baked["face"], offsets, normals, head_tex)
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
        strip(piece, ["part", "region", "_nrm", "_n"] + [a.name for a in piece.data.attributes
                                                         if a.name.startswith("_n.")])
        # (Only now: shape keys on the face change what Cycles bakes onto it.)
        morphs_from_offsets(piece, log)
        rig.bind(piece, arm)
    out = os.path.join(o.out, fig.name)
    export(os.path.join(out, "body.glb"), list(parts.values()), arm)
    for name, (detail, mask) in textures.items():
        bake.save_png(os.path.join(out, f"body.{name}.detail.png"), detail, grey=True)
        bake.save_png(os.path.join(out, f"body.{name}.mask.png"), mask)
    # The face's colour without its light, for shaders that light it themselves (at half size: plain colour).
    bake.save_png(os.path.join(out, "body.face.flat.png"), bake.downsample(flat, 2))
    # The brows and beards the face can wear: how much of each texel they cover, at the mask's size.
    f = size // 1024
    for name, a in overlays.items():
        bake.save_png(os.path.join(out, f"body.face.{name}.png"), bake.downsample(a, f) if f > 1 else a)
    # The eye and mouth presets' paint (ink, shade, iris and catchlight), at the mask's size too.
    for name, a in features.items():
        bake.save_png(os.path.join(out, f"body.face.{name}.png"), bake.downsample(a, f) if f > 1 else a)
    src.remove()
    log("exported", out)
    return parts, arm, textures, high


def build_hair(o, log, high, arm, fig, n):
    """A body's hair style `n` (hair.STYLES), as it falls freely and as it shows under a cap and under a
    beanie."""
    size = 1024 if o.fast else 2048
    model = f"hair.{n}"
    high.hide_render = False
    head = hair.Head(high, fig)
    make = hairdo.STYLES[fig.name][n]
    pieces = {kind: make(head, kind) for kind in ("free", "cap", "beanie")}
    # Where only a band shows under a hat: half the texture.
    small = [kind for kind, p in pieces.items() if p.get("half")]
    textures = {}
    for name, piece in pieces.items():
        blend.shade_smooth(piece)
        others = [p for p in pieces.values() if p is not piece]
        for p in others:
            p.hide_render = True
        maps = bake.bake_maps(piece, None, size // 2 if name in small else size, ao_distance=0.05)
        for p in others:
            p.hide_render = False
        detail, mask = hair.paint_hair(maps)
        # A tie's band, darker.
        h, w = detail.shape[:2]
        for b in piece.get("bands", ()):
            u0, v0, u1, v1 = (float(x) for x in b)
            detail[int((1 - v1) * h):int((1 - v0) * h), int(u0 * w):int(u1 * w)] *= 0.4
        for k in ("bands", "half"):
            if k in piece:
                del piece[k]
        f = detail.shape[0] // (512 if name in small else 1024)
        if f > 1:
            detail, mask = bake.downsample(detail, f), bake.downsample(mask, f)
        textures[name] = (detail, mask)
        piece["finish"] = {"roughness": 0.9, "rim": 0.4}
        piece["tints"] = "hair"
        rig.bind(piece, arm)
        log("hair", name, len(piece.data.polygons), "faces")
    high.hide_render = True
    out = os.path.join(o.out, fig.name)
    export(os.path.join(out, f"{model}.glb"), list(pieces.values()), arm)
    for name, (detail, mask) in textures.items():
        bake.save_png(os.path.join(out, f"{model}.{name}.detail.png"), detail, grey=True)
        bake.save_png(os.path.join(out, f"{model}.{name}.mask.png"), mask)
    # Piece names are only unique within a model: free them for the next ones.
    for name, piece in pieces.items():
        piece.name = piece.data.name = f"{model}.{name}"
    return pieces, textures


def build_garment(o, log, fig, model, pieces, painter, body, arm, hides=(), finish=None, size=1024, rigid=None,
                  own_weights=False):
    """Exports a catalog model for a body: its pieces fitted, weighted from the body (or all on one bone, or as
    their cages were weighted), baked and painted. `painter` and `finish` may be per piece (dicts by piece
    name)."""
    size = size // 2 if o.fast else size
    textures = {}
    for name, piece in pieces.items():
        blend.shade_smooth(piece)
        if own_weights:
            rig.limit(piece)
        else:
            rig.transfer(body, piece, rigid=rigid)
        maps = bake.bake_maps(piece, None, size * 2, ao_distance=0.06)
        maps["fig"] = fig
        paint = painter[name] if isinstance(painter, dict) else painter
        detail, mask = paint(maps)
        textures[name] = (bake.downsample(detail, 2), bake.downsample(mask, 2))
        fin = finish.get(name) if isinstance(finish, dict) and name in finish else finish
        piece["finish"] = fin if isinstance(fin, dict) and "roughness" in fin else {"roughness": 0.7, "rim": 0.35}
        piece["tints"] = "kit"
        # Hiding a region hides its part under a swimsuit too.
        hides = list(hides) + [f"suit.{r}" for r in hides if f"suit.{r}" in figure.REGIONS]
        piece["hides"] = [figure.REGIONS.index(r) for r in hides]
        rig.bind(piece, arm)
        log(fig.name, model, name, len(piece.data.polygons), "faces")
    out = os.path.join(o.out, fig.name)
    names = [p.name for p in pieces.values()]
    if names != list(pieces):
        raise RuntimeError(f"{model}: pieces named {names}, expected {list(pieces)}")
    export(os.path.join(out, f"{model}.glb"), list(pieces.values()), arm)
    for name, (detail, mask) in textures.items():
        bake.save_png(os.path.join(out, f"{model}.{name}.detail.png"), detail, grey=True)
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


BODIES = {"male": MALE, "female": FEMALE}


def build(o, log, fig, only):
    """Everything for one body: the body, its hair styles and the kit fitted to it."""

    def want(model):
        return only is None or model in only

    parts, arm, textures, high = build_body(o, log, fig, bake_it=want("body"))
    styles = {}
    for n in sorted(hairdo.STYLES[fig.name]):
        if want(f"hair.{n}"):
            styles[n] = build_hair(o, log, high, arm, fig, n)
            for p in styles[n][0].values():
                p.hide_render = True
    # Every garment bakes with only the body round it.
    body = kit.Body(high, fig)
    skin_ = parts["skin"]
    built = {}

    def garment(model, make, painter, bodies=("male", "female"), **kw):
        if want(model) and fig.name in bodies:
            pieces = make()
            built[model] = (pieces, build_garment(o, log, fig, model, pieces, painter, skin_, arm, **kw))
            for p in pieces.values():
                p.hide_render = True

    garment("summer.vest.foam", lambda: {"vest": kit.vest(body)}, kit.paint_vest, hides=("torso",),
            finish={"roughness": 0.55, "rim": 0.35})
    garment("summer.bottom.boardshorts", lambda: {"shorts": kit.shorts(fig)}, kit.paint_shorts,
            hides=("hips", "thighs"), finish={"roughness": 0.75, "rim": 0.3})
    garment("summer.bottom.swimsuit", lambda: {"swimsuit": kit.swimsuit(body)}, kit.paint_swimsuit,
            bodies=("female",), hides=("suit.torso", "suit.hips", "suit.flanks"),
            finish={"roughness": 0.45, "rim": 0.35})
    garment("summer.feet.watershoes", lambda: {"shoes": kit.shoes(fig)}, kit.paint_shoes, hides=("feet",),
            finish={"roughness": 0.65, "rim": 0.3}, size=512)
    head = hair.Head(high, fig)
    garment("summer.head.cap", lambda: {"cap": headwear.cap(head)}, headwear.paint_cap,
            finish={"roughness": 0.8, "rim": 0.3}, size=512, rigid="head")
    garment("summer.eyes.shades", lambda: headwear.shades(head),
            {"frame": headwear.paint_frame, "lens": headwear.paint_lens}, size=256, rigid="head",
            finish={"frame": {"roughness": 0.35, "rim": 0.3}, "lens": {"roughness": 0.12, "metalness": 0.4,
                                                                       "rim": 0.5}})
    garment("winter.top.puffer", lambda: {"puffer": winter.puffer(fig)}, winter.paint_puffer,
            hides=("torso", "flanks", "yoke", "upperarms", "forearms"), finish={"roughness": 0.55, "rim": 0.35},
            own_weights=True)
    garment("winter.bottom.pants", lambda: {"pants": winter.pants(fig)}, winter.paint_pants,
            hides=("hips", "thighs", "shins"), finish={"roughness": 0.75, "rim": 0.3})
    garment("winter.head.beanie", lambda: {"beanie": headwear.beanie(head)}, headwear.paint_beanie,
            finish={"roughness": 0.9, "rim": 0.3}, size=512, rigid="head")
    garment("winter.eyes.goggles", lambda: headwear.goggles(head),
            {"frame": headwear.paint_goggle_frame, "lens": headwear.paint_goggle_lens}, size=512, rigid="head",
            finish={"frame": {"roughness": 0.5, "rim": 0.3}, "lens": {"roughness": 0.12, "metalness": 0.4,
                                                                      "rim": 0.5}})
    garment("winter.hands.gloves", lambda: {"gloves": winter.gloves(fig)}, winter.paint_gloves, hides=("hands",),
            finish={"roughness": 0.7, "rim": 0.3}, size=512, own_weights=True)
    garment("winter.feet.boots", lambda: {"boots": winter.boots(fig)}, winter.paint_boots, hides=("feet",),
            finish={"roughness": 0.65, "rim": 0.3}, size=512, own_weights=True)
    if o.preview and only is None:
        (vest, vest_tex), (shorts, shorts_tex), (shoes, shoes_tex) = (
            built[m] for m in ("summer.vest.foam", "summer.bottom.boardshorts", "summer.feet.watershoes"))
        hair_pieces, hair_tex = styles[0]
        for p in (vest, shorts, shoes, {"hair": hair_pieces["free"]}):
            for piece in p.values():
                piece.hide_render = False
        import lookdev

        RED = (0xD9382E, 0x1C1D21, 0xF2F0EA)
        BLACK = (0x1C1D21, 0x8A8F96, 0xD9382E)
        GREY = (0x8A8F96, 0x1C1D21, 0xF07A1E)
        hair_pieces["cap"].hide_render = True
        pieces = {**parts, "hair": hair_pieces["free"], "vest": vest["vest"], "shorts": shorts["shorts"],
                  "shoes": shoes["shoes"]}
        tex = {**textures, "hair": hair_tex["free"], "vest": vest_tex["vest"], "shorts": shorts_tex["shorts"],
               "shoes": shoes_tex["shoes"]}
        lookdev.textured_sheet(os.path.join(o.preview, fig.name), pieces, tex, ref=o.ref,
                               tints={"hair": (lookdev.HAIR,) * 3, "vest": RED, "shorts": BLACK, "shoes": GREY})
        log("preview", o.preview)


def main():
    o = args()
    log = Log()
    only = set(o.only.split(",")) if o.only else None
    for name in o.body.split(",") if o.body else BODIES:
        build(o, log, BODIES[name], only)
    manifest(o)


main()
