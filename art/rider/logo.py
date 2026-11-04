"""Brand wordmarks: text set in Blender, rendered once, then laid onto surfaces as decals."""

import bpy
import numpy as np

_cache = {}


def wordmark(text, height=128, shear=0.22, weight=0.018):
    """A mask (rows from the top, 0-1) of `text` in a bold slanted face, and its aspect (width / height)."""
    key = (text, height, shear, weight)
    if key in _cache:
        return _cache[key]
    main = bpy.context.window.scene if bpy.context.window else bpy.context.scene
    scene = bpy.data.scenes.new("wordmark")
    curve = bpy.data.curves.new("wordmark", "FONT")
    curve.body = text
    curve.shear = shear
    curve.offset = weight
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    curve.space_character = 1.05
    obj = bpy.data.objects.new("wordmark", curve)
    scene.collection.objects.link(obj)
    mat = bpy.data.materials.new("wordmark")
    mat.diffuse_color = (1, 1, 1, 1)
    curve.materials.append(mat)
    deps = bpy.context.evaluated_depsgraph_get()
    obj.update_tag()
    bpy.context.view_layer.update()
    # Size the camera to the text.
    me = obj.to_mesh()
    vs = np.array([v.co[:] for v in me.vertices]) if len(me.vertices) else np.zeros((1, 3))
    obj.to_mesh_clear()
    lo, hi = vs.min(0), vs.max(0)
    w, h = hi[0] - lo[0], hi[1] - lo[1]
    pad = 0.08 * h
    cam_data = bpy.data.cameras.new("wordmark")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = max(w, h) + 2 * pad
    cam = bpy.data.objects.new("wordmark.cam", cam_data)
    cam.location = ((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, 5)
    scene.collection.objects.link(cam)
    scene.camera = cam
    aspect = (w + 2 * pad) / (h + 2 * pad)
    r = scene.render
    r.engine = "BLENDER_WORKBENCH"
    r.resolution_x = int(height * aspect)
    r.resolution_y = height
    r.film_transparent = True
    scene.display.shading.light = "FLAT"
    scene.display.shading.color_type = "MATERIAL"
    scene.display_settings.display_device = "sRGB"
    scene.view_settings.view_transform = "Standard"
    cam_data.sensor_fit = "HORIZONTAL" if aspect >= 1 else "VERTICAL"
    import tempfile
    import os

    path = os.path.join(tempfile.gettempdir(), f"wordmark-{abs(hash(key))}.png")
    r.filepath = path
    with bpy.context.temp_override(scene=scene):
        bpy.ops.render.render(write_still=True, scene=scene.name)
    img = bpy.data.images.load(path)
    px = np.array(img.pixels[:], dtype=np.float32).reshape(img.size[1], img.size[0], 4)[::-1]
    mask = px[..., 3]
    bpy.data.images.remove(img)
    os.remove(path)
    bpy.data.objects.remove(obj)
    bpy.data.objects.remove(cam)
    bpy.data.curves.remove(curve)
    bpy.data.cameras.remove(cam_data)
    bpy.data.materials.remove(mat)
    bpy.data.scenes.remove(scene)
    _cache[key] = (mask, aspect)
    return mask, aspect


def sample(img, u, v):
    """Bilinear sample of a 2D image at u, v in 0-1 (v from the top); 0 outside."""
    h, w = img.shape
    x = u * (w - 1)
    y = v * (h - 1)
    inside = (u >= 0) & (u <= 1) & (v >= 0) & (v <= 1)
    x0 = np.clip(np.floor(x).astype(int), 0, w - 2)
    y0 = np.clip(np.floor(y).astype(int), 0, h - 2)
    fx = np.clip(x - x0, 0, 1)
    fy = np.clip(y - y0, 0, 1)
    a = img[y0, x0] * (1 - fx) + img[y0, x0 + 1] * fx
    b = img[y0 + 1, x0] * (1 - fx) + img[y0 + 1, x0 + 1] * fx
    return np.where(inside, a * (1 - fy) + b * fy, 0.0)


def decal(p, text, centre, normal, width, up=(0, 0, 1), depth=0.06, **style):
    """How much of `text` covers each point: projected along `normal` onto a plane at `centre`."""
    mask, aspect = wordmark(text, **style)
    n = np.asarray(normal, float)
    n /= np.linalg.norm(n)
    upv = np.asarray(up, float)
    upv = upv - n * (upv @ n)
    upv /= np.linalg.norm(upv)
    right = np.cross(upv, n)
    d = p - np.asarray(centre)
    height = width / aspect
    u = (d @ right) / width + 0.5
    v = 0.5 - (d @ upv) / height
    near = np.abs(d @ n) < depth
    return sample(mask, u, v) * near
