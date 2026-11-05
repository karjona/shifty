"""Textured look tests in Blender: the painted maps tinted the way the game's shader does it, lit by a
sun and a sky like the bay's, rendered beside a reference."""

import math
import os

import bpy
import numpy as np

import preview

SKIN = 0xE2B896
EYES = 0x3A2414
HAIR = 0x3B2617


def srgb_to_linear(c):
    c = np.asarray(c, dtype=np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def hex_linear(h):
    return srgb_to_linear(np.array([(h >> 16) & 255, (h >> 8) & 255, h & 255]) / 255.0)


def albedo(detail, mask, tints):
    """The game's tint maths (render/rider/material.ts): linear albedo."""
    t = np.stack([hex_linear(h) for h in tints])
    w = mask
    s = w.sum(axis=2, keepdims=True)
    tint = (w[..., 0:1] * t[0] + w[..., 1:2] * t[1] + w[..., 2:3] * t[2]) / np.maximum(s, 1e-4)
    g = detail
    # Twice the factor times the tint; past full brightness the hue holds and the excess turns to white.
    lit = tint * g * 2
    top = lit.max(axis=2, keepdims=True)
    tinted = lit / np.maximum(top, 1) + np.clip(top - 1, 0, 1) * 0.5
    plain = g**2.2
    return plain * (1 - np.clip(s, 0, 1)) + np.clip(tinted, 0, 1) * np.clip(s, 0, 1)


def _image(name, px):
    h, w = px.shape[:2]
    img = bpy.data.images.get(name)
    if img:
        bpy.data.images.remove(img)
    img = bpy.data.images.new(name, w, h, alpha=True, float_buffer=True)
    img.colorspace_settings.name = "Non-Color"
    rgba = np.concatenate([px, np.ones((h, w, 1))], axis=2)[::-1]
    img.pixels.foreach_set(rgba.astype(np.float32).ravel())
    img.pack()
    return img


# render/rider/material.ts: the share of the painted colour that shows whatever the light.
FLAT = 0.42


def material(name, px, roughness=0.8):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Specular IOR Level"].default_value = 0.25
    lit = nt.nodes.new("ShaderNodeTexImage")
    lit.image = _image(name + ".lit", px * (1 - FLAT))
    flat = nt.nodes.new("ShaderNodeTexImage")
    flat.image = _image(name + ".flat", px * FLAT)
    nt.links.new(lit.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(flat.outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = 1.0
    return mat


def scene_light(sun_dir=(0.45, -0.7, 0.75), sun=2.6, sky=(0.4, 0.38, 0.34), ground=(0.02, 0.07, 0.11)):
    """A sun and sky like the bay's (world.ts: sun 2.6, hemisphere 1.2 from warm white to sea blue)."""
    scene = bpy.context.scene
    for o in [o for o in scene.objects if o.type == "LIGHT"]:
        bpy.data.objects.remove(o)
    data = bpy.data.lights.new("sun", "SUN")
    data.energy = sun
    data.angle = math.radians(2)
    # The game's riders cast shadows but don't receive them.
    data.use_shadow = False
    obj = bpy.data.objects.new("sun", data)
    scene.collection.objects.link(obj)
    from mathutils import Vector

    d = Vector(sun_dir).normalized()
    obj.rotation_euler = d.to_track_quat("Z", "Y").to_euler()
    world = bpy.data.worlds.new("look")
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    coord = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value = -1
    mr.inputs["From Max"].default_value = 1
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.inputs["A"].default_value = (*ground, 1)
    mix.inputs["B"].default_value = (*sky, 1)
    nt.links.new(coord.outputs["Generated"], sep.inputs[0])
    nt.links.new(sep.outputs["Z"], mr.inputs["Value"])
    nt.links.new(mr.outputs["Result"], mix.inputs["Factor"])
    nt.links.new(mix.outputs["Result"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 1.0
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    scene.world = world


def dress(parts, textures, tints=None):
    """Gives each piece its painted, tinted material."""
    global FLAT
    for name, piece in parts.items():
        detail, mask = textures[name]
        t = tints.get(name) if tints else None
        px = albedo(detail, mask, t or (SKIN, EYES, HAIR))
        fin = dict(piece.get("finish", {})) if "finish" in piece else {}
        FLAT = float(fin.get("flat", 0.42))
        mat = material(f"look.{name}", px)
        piece.data.materials.clear()
        piece.data.materials.append(mat)


def render_eevee(path, objects, **kw):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.view_settings.view_transform = "Standard"
    scene.eevee.taa_render_samples = 32
    preview.sheet(path, objects, engine="BLENDER_EEVEE", background=None, **kw)


def textured_sheet(folder, parts, textures, ref=None, extra=(), tints=None):
    os.makedirs(folder, exist_ok=True)
    dress(parts, textures, tints)
    scene_light()
    objects = list(parts.values()) + list(extra)
    render_eevee(os.path.join(folder, "body.png"), objects, views=("front", "three", "side", "back"), ref=ref,
                 height=820)
    render_eevee(os.path.join(folder, "face.png"), objects, views=("front", "three", "side"),
                 target=(0, 0.02, 1.675), span=0.36, height=560, aspect=1.0)
