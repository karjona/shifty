"""Baking a detailed mesh into maps of the game mesh's texture.

The maps come back as numpy arrays (rows from the top, like the image a
browser loads): where each texel is on the detailed surface, its normal,
ambient occlusion, curvature, and how a soft key light and the sky light
it. The painters then work on those.
"""

import math
import os

import bpy
import numpy as np

import blend


def _image(name, size, float_buffer=True):
    img = bpy.data.images.get(name)
    if img:
        bpy.data.images.remove(img)
    return bpy.data.images.new(name, size, size, alpha=True, float_buffer=float_buffer)


def _pixels(img):
    w, h = img.size
    a = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    # Blender rows start at the bottom.
    return a.reshape(h, w, 4)[::-1]


def _target(obj, img):
    """Points the bake at `img` through every material of `obj`."""
    if not obj.data.materials:
        obj.data.materials.append(bpy.data.materials.new(f"{obj.name}.bake"))
    for mat in obj.data.materials:
        mat.use_nodes = True
        nodes = mat.node_tree.nodes
        node = nodes.get("bake_target") or nodes.new("ShaderNodeTexImage")
        node.name = "bake_target"
        node.image = img
        nodes.active = node


def _surface(obj, build, name):
    """Gives `obj` one material whose surface shader `build(nodes, links)` returns (an output socket)."""
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(build(nt.nodes, nt.links), out.inputs["Surface"])
    obj.data.materials.clear()
    obj.data.materials.append(mat)


def _emit(obj, colour):
    def build(n, links):
        em = n.new("ShaderNodeEmission")
        links.new(colour(n, links), em.inputs["Color"])
        return em.outputs["Emission"]

    _surface(obj, build, f"{obj.name}.emit")


def _diffuse(obj):
    def build(n, links):
        d = n.new("ShaderNodeBsdfDiffuse")
        d.inputs["Color"].default_value = (0.8, 0.8, 0.8, 1)
        return d.outputs["BSDF"]

    _surface(obj, build, f"{obj.name}.diffuse")


_gpu = None


def setup(samples):
    global _gpu
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    if _gpu is None:
        _gpu = False
        try:
            prefs = bpy.context.preferences.addons["cycles"].preferences
            prefs.compute_device_type = "METAL"
            prefs.get_devices()
            for d in prefs.devices:
                d.use = d.type != "CPU"
            _gpu = any(d.use for d in prefs.devices)
        except (KeyError, TypeError, AttributeError):
            _gpu = False
    scene.cycles.device = "GPU" if _gpu else "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False
    scene.render.bake.margin = 0
    scene.render.bake.margin_type = "EXTEND"


def light_rig(key=(0.0, -0.12, 1.0), key_power=0.55, softness=55.0, sky=(0.46, 0.47, 0.49), ground=(0.09, 0.08, 0.07)):
    """A soft light from overhead and a sky above a dim ground: the light painted into the textures, the same
    from every side (the game's sun adds the direction)."""
    scene = bpy.context.scene
    for o in [o for o in scene.objects if o.type == "LIGHT"]:
        bpy.data.objects.remove(o)
    data = bpy.data.lights.new("key", "SUN")
    data.energy = key_power
    data.angle = math.radians(softness)
    sun = blend.link(bpy.data.objects.new("key", data))
    d = np.asarray(key, dtype=np.float64)
    d /= np.linalg.norm(d)
    from mathutils import Vector

    sun.rotation_euler = Vector(d).to_track_quat("Z", "Y").to_euler()
    world = bpy.data.worlds.get("bake") or bpy.data.worlds.new("bake")
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    coord = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeMapRange")
    ramp.inputs["From Min"].default_value = -0.3
    ramp.inputs["From Max"].default_value = 0.6
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.inputs["A"].default_value = (*ground, 1)
    mix.inputs["B"].default_value = (*sky, 1)
    nt.links.new(coord.outputs["Generated"], sep.inputs[0])
    nt.links.new(sep.outputs["Z"], ramp.inputs["Value"])
    nt.links.new(ramp.outputs["Result"], mix.inputs["Factor"])
    nt.links.new(mix.outputs["Result"], bg.inputs["Color"])
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    scene.world = world


def _use_cage(bk, cage, extrusion):
    """Rays from `cage` (a copy of the low mesh, pushed out by as much as each part needs) or from the low
    mesh pushed out by `extrusion` everywhere."""
    bk.use_cage = cage is not None
    if cage is not None:
        bk.cage_object = cage
        bk.cage_extrusion = 0.0
    else:
        bk.cage_extrusion = extrusion


def bake_maps(low, high, size, ao_distance=0.1, extrusion=0.008, ray=0.03, margin=16, light=True, samples=96,
              extra_lights=None, cage=None):
    """Bakes `high` onto `low` (or `low` onto itself if `high` is None): a dict of float maps (size x size,
    rows from the top)."""
    selfbake = high is None
    high = high or low
    setup(32)
    scene = bpy.context.scene
    bk = scene.render.bake
    bk.use_selected_to_active = not selfbake
    _use_cage(bk, cage if not selfbake else None, extrusion)
    bk.max_ray_distance = ray
    bk.margin = margin
    saved = list(low.data.materials)
    high_saved = list(high.data.materials)
    maps = {}

    def run(kind, image_name, **kw):
        img = _image(image_name, size)
        _target(low, img)
        blend.deselect()
        if bk.use_selected_to_active:
            high.select_set(True)
        low.select_set(True)
        bpy.context.view_layer.objects.active = low
        bpy.ops.object.bake(type=kind, **kw)
        px = _pixels(img)
        bpy.data.images.remove(img)
        return px

    _emit(high, lambda n, _l: n.new("ShaderNodeNewGeometry").outputs["Position"])
    maps["pos"] = run("EMIT", "bake.pos")[..., :3]
    _emit(high, lambda n, _l: n.new("ShaderNodeNewGeometry").outputs["Pointiness"])
    maps["curv"] = run("EMIT", "bake.curv")[..., 0]
    def part(n, links):
        a = n.new("ShaderNodeAttribute")
        a.attribute_name = "part"
        m = n.new("ShaderNodeMath")
        m.operation = "DIVIDE"
        m.inputs[1].default_value = 64
        links.new(a.outputs["Fac"], m.inputs[0])
        return m.outputs[0]

    if "part" in high.data.attributes:
        _emit(high, part)
        maps["part"] = np.round(run("EMIT", "bake.part")[..., 0] * 64).astype(np.int32)
    _diffuse(high)
    maps["nrm"] = run("NORMAL", "bake.nrm", normal_space="OBJECT")[..., :3] * 2 - 1
    world = scene.world or bpy.data.worlds.new("bake")
    scene.world = world
    world.light_settings.distance = ao_distance
    scene.cycles.samples = 64
    maps["ao"] = run("AO", "bake.ao")[..., 0]
    if light:
        light_rig()
        scene.cycles.samples = samples
        bk.use_pass_direct = True
        bk.use_pass_indirect = True
        bk.use_pass_color = False
        maps["light"] = run("DIFFUSE", "bake.light", pass_filter={"DIRECT", "INDIRECT"})[..., :3].mean(axis=2)
        for name, rig_kw in (extra_lights or {}).items():
            light_rig(**rig_kw)
            maps[name] = run("DIFFUSE", f"bake.{name}", pass_filter={"DIRECT", "INDIRECT"})[..., :3].mean(axis=2)
    # Texels inside the islands (no margin).
    bk.use_selected_to_active = False
    bk.use_cage = False
    bk.margin = 0
    scene.cycles.samples = 1

    def white(n, _l):
        rgb = n.new("ShaderNodeRGB")
        rgb.outputs[0].default_value = (1, 1, 1, 1)
        return rgb.outputs[0]

    _emit(low, white)
    maps["inside"] = run("EMIT", "bake.inside")[..., 0] > 0.5
    if not selfbake and "part" in low.data.attributes:
        # The game mesh's own parts (which texels are an eye, whatever the detailed mesh shows there) and
        # positions (where things are on its surface, which the rays to the detailed mesh can squeeze).
        _emit(low, part)
        maps["low_part"] = np.round(run("EMIT", "bake.low_part")[..., 0] * 64).astype(np.int32)
        _emit(low, lambda n, _l: n.new("ShaderNodeNewGeometry").outputs["Position"])
        maps["low_pos"] = run("EMIT", "bake.low_pos")[..., :3]
    high.data.materials.clear()
    for m in high_saved:
        high.data.materials.append(m)
    low.data.materials.clear()
    for m in saved:
        low.data.materials.append(m)
    bk.margin = margin
    for name in (f"{low.name}.emit", f"{high.name}.emit", f"{high.name}.diffuse"):
        m = bpy.data.materials.get(name)
        if m:
            bpy.data.materials.remove(m)
    return maps


def bake_attributes(obj, names, size, margin=16):
    """Bakes vector attributes of `obj`'s points onto its own texture: {name: (size, size, 3) map}."""
    setup(1)
    scene = bpy.context.scene
    bk = scene.render.bake
    bk.use_selected_to_active = False
    bk.use_cage = False
    bk.margin = margin
    saved = list(obj.data.materials)
    out = {}
    for name in names:
        def colour(n, _l, name=name):
            a = n.new("ShaderNodeAttribute")
            a.attribute_name = name
            return a.outputs["Vector"]

        _emit(obj, colour)
        img = _image(f"bake.{name}", size)
        _target(obj, img)
        blend.deselect()
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.bake(type="EMIT")
        out[name] = _pixels(img)[..., :3]
        bpy.data.images.remove(img)
    obj.data.materials.clear()
    for m in saved:
        obj.data.materials.append(m)
    m = bpy.data.materials.get(f"{obj.name}.emit")
    if m:
        bpy.data.materials.remove(m)
    return out


def _encode_png(px):
    """An 8-bit PNG of `px` (h, w, channels: 1 grey, 3 RGB or 4 RGBA; rows from the top), each row with the
    filter that leaves the smallest differences, at zlib's best compression."""
    import struct
    import zlib

    h, w, c = px.shape
    raw = px.reshape(h, w * c).astype(np.int16)
    zero_row = np.zeros((1, w * c), np.int16)
    zero_px = np.zeros((h, c), np.int16)
    up = np.vstack([zero_row, raw[:-1]])
    left = np.hstack([zero_px, raw[:, :-c]])
    corner = np.hstack([zero_px, up[:, :-c]])
    p = left + up - corner
    pa, pb, pc = np.abs(p - left), np.abs(p - up), np.abs(p - corner)
    paeth = np.where((pa <= pb) & (pa <= pc), left, np.where(pb <= pc, up, corner))
    filtered = np.stack([raw, raw - left, raw - up, raw - ((left + up) >> 1), raw - paeth]) & 0xFF
    cost = np.abs(filtered.astype(np.uint8).astype(np.int8).astype(np.int32)).sum(axis=2)
    best = np.argmin(cost, axis=0)
    rows = filtered[best, np.arange(h)].astype(np.uint8)
    data = np.hstack([best[:, None].astype(np.uint8), rows]).tobytes()

    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)

    head = struct.pack(">IIBBBBB", w, h, 8, {1: 0, 3: 2, 4: 6}[c], 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", head) + chunk(b"IDAT", zlib.compress(data, 9)) + chunk(b"IEND", b"")


def save_png(path, rgb, alpha=None, grey=False):
    """Writes an image (rows from the top, values 0-1) as an 8-bit PNG: RGB, RGBA with `alpha`, or with `grey`
    one channel of its luminance (what the game reads from detail maps)."""
    img = np.clip(np.asarray(rgb, dtype=np.float64), 0, 1)
    if img.ndim == 2:
        img = img[..., None]
    if grey and img.shape[2] == 3:
        img = (img @ np.array([0.299, 0.587, 0.114]))[..., None]
    if alpha is not None:
        img = np.concatenate([img, np.clip(alpha, 0, 1)[..., None]], axis=2)
    px = np.round(img * 255).astype(np.uint8)
    with open(path, "wb") as f:
        f.write(_encode_png(px))


def downsample(img, f=2):
    """Box-filters an (h, w, ...) image down by `f`."""
    h, w = img.shape[:2]
    return img.reshape(h // f, f, w // f, f, *img.shape[2:]).mean(axis=(1, 3))


def bake_textured(low, sources, size, extrusion=0.008, ray=0.03, margin=16, cage=None):
    """Bakes what textured meshes show onto `low` (an RGB map): `sources` are (object, image path, what), with
    `what` "rgb" for the image's colour or "a" for its alpha (as grey) through the object's UVs, or (object,
    None, None) for black."""
    setup(1)
    scene = bpy.context.scene
    bk = scene.render.bake
    bk.use_selected_to_active = True
    _use_cage(bk, cage, extrusion)
    bk.max_ray_distance = ray
    bk.margin = margin
    for obj, path, what in sources:
        def colour(n, links, path=path, what=what):
            if path is None:
                rgb = n.new("ShaderNodeRGB")
                rgb.outputs[0].default_value = (0, 0, 0, 1)
                return rgb.outputs[0]
            tex = n.new("ShaderNodeTexImage")
            tex.image = bpy.data.images.load(path, check_existing=True)
            tex.image.colorspace_settings.name = "Non-Color"
            return tex.outputs["Alpha" if what == "a" else "Color"]

        _emit(obj, colour)
    saved = list(low.data.materials)
    img = _image(f"{low.name}.textured", size)
    _target(low, img)
    blend.deselect()
    for obj, _, _ in sources:
        obj.hide_render = False
        obj.select_set(True)
    low.select_set(True)
    bpy.context.view_layer.objects.active = low
    bpy.ops.object.bake(type="EMIT")
    px = _pixels(img)[..., :3]
    bpy.data.images.remove(img)
    low.data.materials.clear()
    for m in saved:
        low.data.materials.append(m)
    for obj, _, _ in sources:
        obj.hide_render = True
    bk.use_cage = False
    return px
