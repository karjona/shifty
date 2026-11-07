"""Look tests in Blender: the shapes from a few angles in one sheet."""

import math
import os

import bpy
import numpy as np
from mathutils import Vector

import blend


def sheet(path, objects, views, target, dist, size=(720, 480), lens=50, engine="BLENDER_WORKBENCH"):
    """Renders `objects` from each (azimuth, elevation) view in degrees (azimuth 0 looks at the front, 180 from
    behind) side by side into one PNG."""
    scene = bpy.context.scene
    scene.render.engine = engine
    scene.render.resolution_x, scene.render.resolution_y = size
    if engine == "BLENDER_WORKBENCH":
        sh = scene.display.shading
        sh.light = "STUDIO"
        sh.color_type = "MATERIAL" if any(o.data.materials for o in objects) else "OBJECT"
        sh.show_cavity = True
        sh.cavity_type = "BOTH"
        sh.show_object_outline = True
        sh.show_specular_highlight = True
    world = bpy.data.worlds.get("look") or bpy.data.worlds.new("look")
    world.color = (0.32, 0.36, 0.42)
    scene.world = world
    cam_data = bpy.data.cameras.get("look") or bpy.data.cameras.new("look")
    cam_data.lens = lens
    cam = bpy.data.objects.get("look") or blend.link(bpy.data.objects.new("look", cam_data))
    scene.camera = cam
    hidden = [o for o in scene.objects if o.type == "MESH" and o not in objects and not o.hide_render]
    for o in hidden:
        o.hide_render = True
    tiles = []
    for i, (az, el) in enumerate(views):
        a, e = math.radians(az), math.radians(el)
        d = Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e)))
        cam.location = Vector(target) + d * dist
        blend.look_at(cam, target)
        scene.render.filepath = f"{path}.{i}.png"
        bpy.ops.render.render(write_still=True)
        tiles.append(scene.render.filepath)
    for o in hidden:
        o.hide_render = False
    w, h = size
    out = np.zeros((h, w * len(tiles), 4), dtype=np.float32)
    for i, t in enumerate(tiles):
        img = bpy.data.images.load(t)
        out[:, i * w:(i + 1) * w] = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
        bpy.data.images.remove(img)
        os.remove(t)
    img = bpy.data.images.new("sheet", w * len(tiles), h, alpha=True)
    img.pixels.foreach_set(out.ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)
