"""UVs from a cage's seams: unwrapped, scaled per body part, packed per texture."""

import bmesh
import bpy
import numpy as np

import blend


def unwrap(obj, margin=0.004):
    """Unwraps along the marked seams, every island at the same texel density."""
    if not obj.data.uv_layers:
        obj.data.uv_layers.new(name="uv")
    blend.select_only(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.unwrap(method="ANGLE_BASED", margin=margin, correct_aspect=True)
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.average_islands_scale()
    bpy.ops.object.mode_set(mode="OBJECT")


def islands(bm, uv, faces=None):
    """Lists of faces joined by edges whose UVs match on both sides."""
    pool = set(faces if faces is not None else bm.faces)
    seen = set()
    out = []
    for f in pool:
        if f in seen:
            continue
        stack, isl = [f], []
        seen.add(f)
        while stack:
            g = stack.pop()
            isl.append(g)
            for loop in g.loops:
                e = loop.edge
                if e.seam:
                    continue
                for other in e.link_faces:
                    if other in seen or other not in pool:
                        continue
                    la = [lo for lo in other.loops if lo.edge == e]
                    if not la:
                        continue
                    la = la[0]
                    same = (la[uv].uv - loop.link_loop_next[uv].uv).length < 1e-5 and (
                        la.link_loop_next[uv].uv - loop[uv].uv).length < 1e-5
                    if same:
                        seen.add(other)
                        stack.append(other)
        out.append(isl)
    return out


def scale_islands(obj, factor):
    """Scales each island about its middle by `factor(face)` of its first face (a bmesh face)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    uv = bm.loops.layers.uv.active
    for isl in islands(bm, uv):
        s = float(np.mean([factor(bm, f) for f in isl]))
        uvs = [lo[uv].uv for f in isl for lo in f.loops]
        c = sum((u.copy() for u in uvs), uvs[0].copy() * 0) / len(uvs)
        for f in isl:
            for lo in f.loops:
                lo[uv].uv = c + (lo[uv].uv - c) * s
    bm.to_mesh(obj.data)
    bm.free()


def pack(obj, material_index, margin=0.006):
    """Packs the islands of one material's faces into the whole UV square."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    for f in bm.faces:
        f.select = f.material_index == material_index
    for e in bm.edges:
        e.select = all(f.select for f in e.link_faces) and bool(e.link_faces)
    for v in bm.verts:
        v.select = any(f.select for f in v.link_faces)
    bm.to_mesh(obj.data)
    bm.free()
    blend.select_only(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.context.scene.tool_settings.use_uv_select_sync = False
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.pack_islands(rotate=True, scale=True, margin=margin, shape_method="CONCAVE")
    bpy.ops.object.mode_set(mode="OBJECT")
