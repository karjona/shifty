"""UVs, and baking a detailed mesh's surface into maps of a low one.

The maps come back as numpy arrays (rows from the top, like the image a
browser loads): where each texel is on the detailed surface, its normal,
ambient occlusion, curvature. The painters then work on those.
"""

import os

import bpy
import numpy as np

import blend


def uv_unwrap(obj, margin=0.01, angle=66, scale=None):
    """Smart-projects the UVs; `scale` gives faces a texel density weight (a function of face centres)."""
    blend.select_only(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=np.radians(angle), island_margin=margin, area_weight=0.0,
                             scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    if scale is not None:
        _weight_islands(obj, scale)
        blend.select_only(obj)
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.select_all(action="SELECT")
        bpy.ops.uv.pack_islands(rotate=True, margin=margin, scale=True)
        bpy.ops.object.mode_set(mode="OBJECT")


def _weight_islands(obj, scale):
    """Scales each UV island about its centre by `scale` at its faces' centre."""
    import bmesh

    bm = bmesh.new()
    bm.from_mesh(obj.data)
    uv = bm.loops.layers.uv.active
    bm.faces.ensure_lookup_table()
    # Islands: faces joined by edges whose UVs match.
    seen = set()
    for f in bm.faces:
        if f.index in seen:
            continue
        stack, island = [f], []
        seen.add(f.index)
        while stack:
            g = stack.pop()
            island.append(g)
            for loop in g.loops:
                e = loop.edge
                for other in e.link_faces:
                    if other.index in seen:
                        continue
                    a = [l for l in other.loops if l.edge == e]
                    if not a:
                        continue
                    la = a[0]
                    if (la[uv].uv - loop.link_loop_next[uv].uv).length < 1e-5 and (
                        la.link_loop_next[uv].uv - loop[uv].uv
                    ).length < 1e-5:
                        seen.add(other.index)
                        stack.append(other)
        c3 = np.mean([np.array(g.calc_center_median()) for g in island], axis=0)
        s = float(scale(c3))
        uvs = [l[uv].uv for g in island for l in g.loops]
        cu = sum((u.copy() for u in uvs), uvs[0].copy() * 0) / len(uvs)
        for g in island:
            for l in g.loops:
                l[uv].uv = cu + (l[uv].uv - cu) * s
    bm.to_mesh(obj.data)
    bm.free()


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


def _emit(obj, build):
    """Gives `obj` one emission material whose colour `build(nodes, links)` returns (an output socket)."""
    mat = bpy.data.materials.get(f"{obj.name}.emit") or bpy.data.materials.new(f"{obj.name}.emit")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    nt.links.new(build(nt.nodes, nt.links), em.inputs["Color"])
    nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
    obj.data.materials.clear()
    obj.data.materials.append(mat)


def _setup(samples):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.render.bake.margin = 0
    scene.render.bake.margin_type = "EXTEND"


def bake_maps(low, high, size, ao_samples=48, ao_distance=0.08, extrusion=0.006, ray=0.02, margin=12):
    """Bakes `high` onto `low`: a dict of float maps (size x size, rows from the top)."""
    _setup(ao_samples)
    scene = bpy.context.scene
    scene.render.bake.use_selected_to_active = True
    scene.render.bake.cage_extrusion = extrusion
    scene.render.bake.max_ray_distance = ray
    scene.render.bake.margin = margin
    world = scene.world or bpy.data.worlds.new("bake")
    scene.world = world
    world.light_settings.distance = ao_distance
    saved = list(low.data.materials)
    maps = {}

    def run(kind, image_name, **kw):
        img = _image(image_name, size)
        _target(low, img)
        blend.deselect()
        high.select_set(scene.render.bake.use_selected_to_active)
        low.select_set(True)
        bpy.context.view_layer.objects.active = low
        bpy.ops.object.bake(type=kind, **kw)
        px = _pixels(img)
        bpy.data.images.remove(img)
        return px

    high_saved = list(high.data.materials)
    _emit(high, lambda n, _l: n.new("ShaderNodeNewGeometry").outputs["Position"])
    maps["pos"] = run("EMIT", "bake.pos")[..., :3]

    def curvature(n, links):
        geo = n.new("ShaderNodeNewGeometry")
        return geo.outputs["Pointiness"]

    _emit(high, curvature)
    maps["curv"] = run("EMIT", "bake.curv")[..., 0]
    high.data.materials.clear()
    for m in high_saved:
        high.data.materials.append(m)
    maps["nrm"] = run("NORMAL", "bake.nrm", normal_space="OBJECT")[..., :3] * 2 - 1
    maps["ao"] = run("AO", "bake.ao")[..., 0]
    # Texels inside the islands (no margin), and the low mesh's own normals.
    scene.render.bake.use_selected_to_active = False
    scene.render.bake.margin = 0

    def white(n, _l):
        rgb = n.new("ShaderNodeRGB")
        rgb.outputs[0].default_value = (1, 1, 1, 1)
        return rgb.outputs[0]

    _emit(low, white)
    inside = run("EMIT", "bake.inside")[..., 0] > 0.5
    low.data.materials.clear()
    for m in saved:
        low.data.materials.append(m)
    scene.render.bake.margin = margin
    maps["base"] = run("NORMAL", "bake.base", normal_space="OBJECT")[..., :3] * 2 - 1
    maps["inside"] = inside
    for m in [bpy.data.materials.get(f"{o.name}.emit") for o in (low, high)]:
        if m:
            bpy.data.materials.remove(m)
    return maps


def save_png(path, rgb, alpha=None):
    """Writes an image (rows from the top, values 0-1) as an 8-bit PNG."""
    h, w = rgb.shape[:2]
    a = np.ones((h, w), np.float32) if alpha is None else alpha
    px = np.concatenate([np.clip(rgb, 0, 1), np.clip(a, 0, 1)[..., None]], axis=2)[::-1].astype(np.float32)
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=True)
    img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(px.ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)
