"""Building rides from rings of points: lofted solids (a hull's stations, a seat, a board's outline), sweeps
(a bumper, a handlebar) and caps, into one mesh with a part id per face and a bone per vertex.

Points are given in the game's frame (x to the rider's left, y up, z forward) and written in Blender's (x, -z,
y), which the glTF exporter turns back.
"""

import math

import bmesh
import bpy
import numpy as np
from mathutils import Vector

import blend


def to_blender(p):
    return Vector((float(p[0]), float(-p[2]), float(p[1])))


def to_game(a):
    """Blender coordinates (..., 3) as the game's."""
    a = np.asarray(a)
    return np.stack([a[..., 0], a[..., 2], -a[..., 1]], axis=-1)


def smoothstep(a, b, x):
    t = np.clip((np.asarray(x, dtype=np.float64) - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


class Builder:
    """One mesh made of closed pieces, each face tagged with a part and each vertex with a bone."""

    def __init__(self):
        self.pieces = []

    def _piece(self):
        bm = bmesh.new()
        part = bm.faces.layers.int.new("part")
        bone = bm.verts.layers.int.new("bone")
        return bm, part, bone

    def _finish(self, bm, part_layer, bone_layer, part, bone, outward=True):
        for f in bm.faces:
            f[part_layer] = part
        for v in bm.verts:
            v[bone_layer] = bone
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
        bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=1e-6)
        if outward:
            bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
            # (Recalculating can still leave a closed piece inside out: its volume says so.)
            if bm.calc_volume(signed=True) < 0:
                bmesh.ops.reverse_faces(bm, faces=bm.faces)
        self.pieces.append(bm)

    def loft(self, rings, part, bone=0, caps=(True, True), closed=True):
        """A solid through `rings` (each (n, 3), the same n, in order along it); a ring shrunk to a point closes
        that end in a point, `caps` close the others flat."""
        bm, pl, bl = self._piece()
        verts = []
        for r in rings:
            r = np.asarray(r, dtype=np.float64)
            span = np.ptp(r, axis=0).max()
            if span < 1e-6:
                v = bm.verts.new(to_blender(r[0]))
                verts.append([v] * len(r))
            else:
                verts.append([bm.verts.new(to_blender(p)) for p in r])
        n = len(rings[0])
        for a, b in zip(verts, verts[1:]):
            for j in range(n if closed else n - 1):
                k = (j + 1) % n
                quad = [a[j], a[k], b[k], b[j]]
                uniq = list(dict.fromkeys(quad))
                if len(uniq) >= 3:
                    try:
                        bm.faces.new(uniq)
                    except ValueError:
                        pass
        for end, ring in ((0, verts[0]), (1, verts[-1])):
            if caps[end] and len(set(ring)) > 2:
                try:
                    bm.faces.new(list(dict.fromkeys(ring)))
                except ValueError:
                    pass
        self._finish(bm, pl, bl, part, bone)

    def sweep(self, path, profile, part, bone=0, closed_path=False, up=(0, 1, 0), caps=True):
        """A profile ((m, 2) in the path's (side, up) frame) carried along a path ((n, 3))."""
        path = np.asarray(path, dtype=np.float64)
        n = len(path)
        rings = []
        for i in range(n):
            if closed_path:
                t = path[(i + 1) % n] - path[(i - 1) % n]
            else:
                t = path[min(i + 1, n - 1)] - path[max(i - 1, 0)]
            t = t / max(np.linalg.norm(t), 1e-9)
            u = np.asarray(up, dtype=np.float64)
            side = np.cross(u, t)
            if np.linalg.norm(side) < 1e-6:
                side = np.cross((1.0, 0, 0), t)
            side /= np.linalg.norm(side)
            uu = np.cross(t, side)
            rings.append(np.array([path[i] + p[0] * side + p[1] * uu for p in profile]))
        if closed_path:
            rings.append(rings[0])
            caps = False
        self.loft(rings, part, bone, caps=(caps, caps))

    def tube(self, path, radius, part, bone=0, sides=8, up=(0, 1, 0), caps=True):
        r = radius if callable(radius) else (lambda i, r=radius: r)
        path = np.asarray(path, dtype=np.float64)
        rings = []
        for i in range(len(path)):
            t = path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]
            t /= max(np.linalg.norm(t), 1e-9)
            u = np.asarray(up, dtype=np.float64)
            side = np.cross(u, t)
            if np.linalg.norm(side) < 1e-6:
                side = np.cross((0, 0, 1.0), t)
            side /= np.linalg.norm(side)
            uu = np.cross(t, side)
            ri = r(i)
            rings.append(np.array([path[i] + ri * (math.cos(a) * side + math.sin(a) * uu)
                                   for a in np.linspace(0, 2 * math.pi, sides, endpoint=False)]))
        self.loft(rings, part, bone, caps=(caps, caps))

    def box(self, centre, size, part, bone=0, round_=0.0, segments=2, rot=None):
        """A box (rounded by `round_` with `segments`), turned by the 3x3 `rot` about its centre."""
        bm, pl, bl = self._piece()
        bmesh.ops.create_cube(bm, size=1.0)
        if round_ > 0:
            bmesh.ops.bevel(bm, geom=list(bm.edges), offset=round_, segments=segments, affect="EDGES",
                            profile=0.5, clamp_overlap=True)
        for v in bm.verts:
            # The cube is built in Blender's frame: scale it as the game's (x, y, z) sizes.
            g = np.array([v.co.x, v.co.z, -v.co.y])
            if round_ > 0:
                # (The bevel rounded a unit cube: stretch its flats to size, keeping the rounding's radius.)
                core = np.clip(g, -(0.5 - round_), 0.5 - round_)
                g = core / (0.5 - round_) * (np.array(size) / 2 - round_) + (g - core)
            else:
                g = g * np.array(size)
            if rot is not None:
                g = np.asarray(rot) @ g
            v.co = to_blender(np.asarray(centre) + g)
        self._finish(bm, pl, bl, part, bone)

    def build(self, name):
        """The pieces as one object, with the `part` face attribute and a vertex group per bone."""
        bm = bmesh.new()
        for p in self.pieces:
            me = bpy.data.meshes.new("tmp")
            p.to_mesh(me)
            p.free()
            bm.from_mesh(me)
            bpy.data.meshes.remove(me)
        self.pieces = []
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        obj = blend.link(bpy.data.objects.new(name, me))
        return obj


def bones_of(obj):
    a = obj.data.attributes.get("bone")
    n = len(obj.data.vertices)
    out = np.zeros(n, dtype=np.int32)
    if a:
        a.data.foreach_get("value", out)
    return out


def finish_mesh(obj, sharp_angle=38.0, tris=True):
    """Triangulated, smooth shaded with hard edges past `sharp_angle`."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    if tris:
        bmesh.ops.triangulate(bm, faces=bm.faces, quad_method="BEAUTY", ngon_method="BEAUTY")
    bm.to_mesh(obj.data)
    bm.free()
    # (Where an outline closes in a point, a triangle can come out twice: one goes.)
    obj.data.validate()
    blend.shade_smooth(obj)
    obj.data.set_sharp_from_angle(angle=math.radians(sharp_angle))


def unwrap(obj, angle=55.0, margin=0.004):
    """Hard-surface UVs: islands split where the surface turns by more than `angle`, all at one texel density,
    packed into the square."""
    if not obj.data.uv_layers:
        obj.data.uv_layers.new(name="uv")
    blend.select_only(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=margin, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.average_islands_scale()
    bpy.ops.uv.pack_islands(rotate=True, rotate_method="ANY", scale=True, margin=margin, shape_method="CONCAVE")
    bpy.ops.object.mode_set(mode="OBJECT")


def armature(bones, name="rig"):
    """An armature of (name, head, tail, parent) bones, heads and tails in the game's frame."""
    data = bpy.data.armatures.new(name)
    obj = blend.link(bpy.data.objects.new(name, data))
    blend.select_only(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    for b, head, tail, _ in bones:
        eb = data.edit_bones.new(b)
        eb.head = to_blender(head)
        eb.tail = to_blender(tail)
        eb.roll = 0
    for b, _, _, parent in bones:
        if parent:
            data.edit_bones[b].parent = data.edit_bones[parent]
    bpy.ops.object.mode_set(mode="OBJECT")
    return obj


def skin(obj, arm, names):
    """Weights each vertex fully to its bone (the `bone` attribute indexes `names`) and parents to `arm`."""
    b = bones_of(obj)
    for i, name in enumerate(names):
        g = obj.vertex_groups.new(name=name)
        idx = np.nonzero(b == i)[0].tolist()
        if idx:
            g.add(idx, 1.0, "REPLACE")
    a = obj.data.attributes.get("bone")
    if a:
        obj.data.attributes.remove(a)
    obj.parent = arm
    m = obj.modifiers.new("rig", "ARMATURE")
    m.object = arm
