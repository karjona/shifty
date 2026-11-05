"""Blender helpers: distance fields into meshes, cleanup, previews."""

import math

import bmesh
import bpy
import numpy as np
from mathutils import Vector


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for c in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.armatures):
        for x in list(c):
            c.remove(x)


def link(obj, collection=None):
    (collection or bpy.context.scene.collection).objects.link(obj)
    return obj


def flip(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.reverse_faces(bm, faces=bm.faces)
    bm.to_mesh(obj.data)
    bm.free()


def deselect():
    for o in bpy.context.view_layer.objects:
        if o is not None:
            o.select_set(False)


def select_only(obj):
    deselect()
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def apply_modifiers(obj):
    select_only(obj)
    for m in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def tris(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def decimate(obj, faces, region=None, region_faces=None):
    """Collapses to about `faces` triangles; a `region` (a mask over vertices) gets `region_faces` of them.

    Collapse only touches vertices in its vertex group, so the region and the
    rest are decimated in turn.
    """
    if region is None:
        _collapse(obj, faces, None)
        return
    region = np.asarray(region, dtype=bool)
    rest_faces = faces - region_faces
    for target, inside in ((rest_faces, False), (region_faces, True)):
        v = verts(obj)
        mask = region_of(obj, v, region, inside)
        n_in = _faces_touching(obj, mask)
        others = tris(obj) - n_in
        vertex_group(obj, "decimate", mask.astype(float))
        _collapse(obj, others + target, "decimate")
        obj.vertex_groups.clear()
        region = _remap(obj, v, region)


def region_of(obj, v, region, inside):
    return region if inside else ~region


def _faces_touching(obj, mask):
    n = 0
    for p in obj.data.polygons:
        if all(mask[i] for i in p.vertices):
            n += len(p.vertices) - 2
    return n


def _remap(obj, old_verts, old_region):
    """The region's mask on the decimated mesh (by nearest old vertex)."""
    from mathutils.kdtree import KDTree

    tree = KDTree(len(old_verts))
    for i, p in enumerate(old_verts):
        tree.insert(p, i)
    tree.balance()
    return np.array([old_region[tree.find(p)[1]] for p in verts(obj)], dtype=bool)


def _collapse(obj, faces, group):
    for _ in range(6):
        n = tris(obj)
        if n <= faces * 1.03:
            return
        m = obj.modifiers.new("decimate", "DECIMATE")
        m.decimate_type = "COLLAPSE"
        m.ratio = max(0.01, faces / n)
        m.use_collapse_triangulate = True
        if group:
            m.vertex_group = group
            m.vertex_group_factor = 1.0
        apply_modifiers(obj)
        if tris(obj) >= n * 0.99:
            return


def smooth(obj, factor=0.5, iterations=5):
    m = obj.modifiers.new("smooth", "SMOOTH")
    m.factor = factor
    m.iterations = iterations
    apply_modifiers(obj)


def shade_smooth(obj):
    for p in obj.data.polygons:
        p.use_smooth = True


def verts(obj):
    n = len(obj.data.vertices)
    a = np.empty(n * 3)
    obj.data.vertices.foreach_get("co", a)
    return a.reshape(n, 3)


def vertex_group(obj, name, weights):
    g = obj.vertex_groups.get(name) or obj.vertex_groups.new(name=name)
    for i, w in enumerate(weights):
        if w > 1e-4:
            g.add([i], float(w), "REPLACE")
    return g


def material(name, color=(0.8, 0.8, 0.8, 1), roughness=0.6, image=None):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = roughness
    mat.diffuse_color = color
    if image is not None:
        tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
        tex.image = image
        mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    return mat


def look_at(cam, target):
    d = Vector(target) - cam.location
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


def preview(path, objects, views=("front", "side", "back", "three"), size=(420, 760), target=(0, 0, 0.9),
            dist=4.2, lens=50, engine="BLENDER_WORKBENCH", ortho=None):
    """Renders the objects from a few angles side by side into one PNG."""
    scene = bpy.context.scene
    scene.render.engine = engine
    scene.render.resolution_x, scene.render.resolution_y = size
    scene.render.film_transparent = False
    if engine == "BLENDER_WORKBENCH":
        sh = scene.display.shading
        sh.light = "STUDIO"
        sh.color_type = "MATERIAL"
        sh.show_cavity = True
        sh.cavity_type = "BOTH"
        sh.show_shadows = False
        sh.show_specular_highlight = True
    world = bpy.data.worlds.get("preview") or bpy.data.worlds.new("preview")
    world.color = (0.32, 0.36, 0.42)
    scene.world = world
    cam_data = bpy.data.cameras.get("preview") or bpy.data.cameras.new("preview")
    cam_data.lens = lens
    if ortho:
        cam_data.type = "ORTHO"
        cam_data.ortho_scale = ortho
    cam = bpy.data.objects.get("preview") or link(bpy.data.objects.new("preview", cam_data))
    scene.camera = cam
    hidden = [o for o in scene.objects if o.type == "MESH" and o not in objects]
    for o in hidden:
        o.hide_render = True
    angles = {"front": 0, "side": 90, "back": 180, "three": 35, "three_l": -35}
    tiles = []
    for v in views:
        a = math.radians(angles[v])
        cam.location = Vector(target) + Vector((math.sin(a) * dist, -math.cos(a) * dist, 0.05 * dist))
        look_at(cam, target)
        scene.render.filepath = f"{path}.{v}.png"
        bpy.ops.render.render(write_still=True)
        tiles.append(scene.render.filepath)
    for o in hidden:
        o.hide_render = False
    images = [bpy.data.images.load(t) for t in tiles]
    w, h = size
    out = np.zeros((h, w * len(images), 4), dtype=np.float32)
    for i, img in enumerate(images):
        px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
        out[:, i * w : (i + 1) * w] = px
        bpy.data.images.remove(img)
    img = bpy.data.images.new("preview_sheet", w * len(tiles), h, alpha=True)
    img.pixels.foreach_set(out.ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)
    import os

    for t in tiles:
        os.remove(t)
