"""Look tests: renders models from a few angles into one sheet, optionally next to a reference image.

    Blender --background --factory-startup --python art/rider/preview.py -- OUT.png [--ref REF.png]
        [--stage cage|low|textured] [--views front,three,side,back] [--face]
"""

import math

import bpy
import numpy as np
from mathutils import Vector

import blend


def _img(path):
    img = bpy.data.images.load(path)
    w, h = img.size
    a = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    bpy.data.images.remove(img)
    return a.reshape(h, w, 4)[::-1]


def resize(px, h):
    """Bilinear resize to height `h` (rows from the top)."""
    H, W = px.shape[:2]
    w = max(1, round(W * h / H))
    ys = np.linspace(0, H - 1, h)
    xs = np.linspace(0, W - 1, w)
    y0 = np.floor(ys).astype(int)
    x0 = np.floor(xs).astype(int)
    y1 = np.minimum(y0 + 1, H - 1)
    x1 = np.minimum(x0 + 1, W - 1)
    fy = (ys - y0)[:, None, None]
    fx = (xs - x0)[None, :, None]
    a = px[y0][:, x0] * (1 - fx) + px[y0][:, x1] * fx
    b = px[y1][:, x0] * (1 - fx) + px[y1][:, x1] * fx
    return a * (1 - fy) + b * fy


def save(path, px):
    h, w = px.shape[:2]
    img = bpy.data.images.new("sheet", w, h, alpha=True)
    img.pixels.foreach_set(np.ascontiguousarray(px[::-1]).astype(np.float32).ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)


ANGLES = {"front": 0, "three": 35, "side": 90, "back": 180, "three_l": -35}


def sheet(path, objects, views=("front", "three", "side"), height=900, target=(0, 0, 0.9), span=1.9,
          ref=None, engine="BLENDER_WORKBENCH", lens=85, sun=None, background=(0.55, 0.62, 0.7), aspect=0.48):
    """Renders each view at `height` pixels showing `span` metres top to bottom, and puts `ref` first."""
    scene = bpy.context.scene
    scene.render.engine = engine
    width = int(height * aspect)
    scene.render.resolution_x, scene.render.resolution_y = width, height
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "Standard"
    if engine == "BLENDER_WORKBENCH":
        sh = scene.display.shading
        sh.light = "STUDIO"
        sh.color_type = "TEXTURE" if any(o.data.uv_layers for o in objects) and sun == "tex" else "MATERIAL"
        sh.show_cavity = True
        sh.cavity_type = "WORLD"
        sh.cavity_ridge_factor = 1.0
        sh.cavity_valley_factor = 1.0
        sh.show_shadows = False
        sh.show_specular_highlight = False
    if background is not None:
        world = bpy.data.worlds.get("preview") or bpy.data.worlds.new("preview")
        world.color = background
        scene.world = world
    cam_data = bpy.data.cameras.get("preview") or bpy.data.cameras.new("preview")
    cam_data.lens = lens
    cam = bpy.data.objects.get("preview") or blend.link(bpy.data.objects.new("preview", cam_data))
    scene.camera = cam
    # Distance so `span` metres fill the frame's height.
    cam_data.sensor_fit = "VERTICAL"
    cam_data.sensor_height = 36
    fov_v = 2 * math.atan(18 / lens)
    dist = span / 2 / math.tan(fov_v / 2)
    hidden = [o for o in scene.objects if o.type == "MESH" and o not in objects]
    for o in hidden:
        o.hide_render = True
    tiles = []
    for v in views:
        a = math.radians(ANGLES[v])
        cam.location = Vector(target) + Vector((math.sin(a) * dist, -math.cos(a) * dist, 0))
        d = Vector(target) - cam.location
        cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = f"{path}.{v}.png"
        bpy.ops.render.render(write_still=True)
        tiles.append(_img(scene.render.filepath))
        import os

        os.remove(scene.render.filepath)
    for o in hidden:
        o.hide_render = False
    if ref:
        r = _img(ref)
        tiles.insert(0, resize(r, height))
    out = np.concatenate([t[..., :4] for t in tiles], axis=1)
    out[..., 3] = 1
    save(path, out)
