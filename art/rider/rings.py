"""Cages: low-poly meshes box-modelled from rings of vertices bridged into
quads. Every vertex carries its skin weights and every face a body region
and a UV island seam plan, so subdividing the cage keeps all three.

A ring is a list of points around a centre in a frame (`axis` along the
part, `e1` and `e2` across it); profiles give each ring its own outline.
"""

import math

import bmesh
import bpy
import numpy as np

import blend
import rig


def frame_of(axis, e2_hint):
    """An orthonormal frame (e1, e2, axis) with e2 as close to `e2_hint` as possible."""
    a = np.asarray(axis, dtype=np.float64)
    a = a / np.linalg.norm(a)
    h = np.asarray(e2_hint, dtype=np.float64)
    e2 = h - a * np.dot(h, a)
    e2 /= np.linalg.norm(e2)
    e1 = np.cross(e2, a)
    return e1, e2, a


def outline(n, r1p, r1n, r2p, r2n, power=2.0, start=0.0, bumps=()):
    """`n` points of a four-radius superellipse: +e1 has radius r1p, -e1 r1n, +e2 r2p, -e2 r2n.

    Angle 0 is +e1, angles grow toward +e2. `bumps` are (angle, width, amount) radial pushes (radians, m).
    Returns (n, 2) coordinates in (e1, e2).
    """
    out = []
    for i in range(n):
        t = start + 2 * math.pi * i / n
        c, s = math.cos(t), math.sin(t)
        ex = 2.0 / power
        x = math.copysign(abs(c) ** ex, c) * (r1p if c >= 0 else r1n)
        y = math.copysign(abs(s) ** ex, s) * (r2p if s >= 0 else r2n)
        r = math.hypot(x, y)
        push = 0.0
        for a, w, amt in bumps:
            d = math.atan2(math.sin(t - a), math.cos(t - a))
            push += amt * math.exp(-((d / w) ** 2))
        if r > 1e-9:
            x *= (r + push) / r
            y *= (r + push) / r
        out.append((x, y))
    return np.array(out)


def place(centre, e1, e2, pts):
    c = np.asarray(centre, dtype=np.float64)
    return [c + p[0] * e1 + p[1] * e2 for p in pts]


class Cage:
    """A cage under construction."""

    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.deform = self.bm.verts.layers.deform.verify()
        self.region = self.bm.faces.layers.int.new("region")
        self.part = self.bm.verts.layers.int.new("part")
        self.parts = {}

    def part_id(self, name):
        return self.parts.setdefault(name, len(self.parts) + 1)

    def vert(self, p, weights, part=None):
        v = self.bm.verts.new(tuple(float(x) for x in p))
        for b, w in weights.items():
            if w > 1e-5:
                v[self.deform][rig.BONES.index(b)] = float(w)
        if part:
            v[self.part] = self.part_id(part)
        return v

    def ring(self, pts, weights, part=None):
        """Vertices for points; `weights` is one dict for all or a list of dicts."""
        ws = weights if isinstance(weights, list) else [weights] * len(pts)
        return [self.vert(p, w, part) for p, w in zip(pts, ws)]

    def face(self, vs, region):
        f = self.bm.faces.new(vs)
        f[self.region] = region
        return f

    def bridge(self, a, b, region, closed=True, skip=()):
        n = len(a)
        assert n == len(b), (n, len(b))
        for i in range(n if closed else n - 1):
            if i in skip:
                continue
            j = (i + 1) % n
            self.face([a[i], a[j], b[j], b[i]], region)

    def loft(self, rings, region, closed=True):
        regions = region if isinstance(region, list) else [region] * (len(rings) - 1)
        for a, b, r in zip(rings, rings[1:], regions):
            self.bridge(a, b, r, closed)

    def bridge_aligned(self, loop, ring, region):
        """Bridges a loop of existing vertices to a ring, matching the closest rotation and direction."""
        n = len(loop)
        assert n == len(ring), (n, len(ring))
        P = np.array([v.co[:] for v in loop])
        Q = np.array([v.co[:] for v in ring])
        best = None
        for flip in (False, True):
            qq = Q[::-1] if flip else Q
            for k in range(n):
                d = np.linalg.norm(P - np.roll(qq, -k, axis=0), axis=1).sum()
                if best is None or d < best[0]:
                    best = (d, flip, k)
        _, flip, k = best
        r = ring[::-1] if flip else ring
        r = r[k:] + r[:k]
        self.bridge(loop, r, region)
        return r

    def cap(self, ring, centre, weights, region, part=None, inset=None):
        """Closes a ring of even length with quads around a centre vertex (or two rings of quads with `inset`)."""
        n = len(ring)
        if inset is not None:
            # An inner ring at `inset` of the way to the centre, then the centre.
            c = np.asarray(centre)
            inner = self.ring([c + (np.array(v.co[:]) - c) * inset for v in ring], weights, part)
            self.bridge(ring, inner, region)
            ring = inner
        c = self.vert(centre, weights, part)
        assert n % 2 == 0
        for i in range(0, n, 2):
            self.face([ring[i], ring[(i + 1) % n], ring[(i + 2) % n], c], region)
        return c

    def seam(self, verts, closed=False):
        """Marks the edges along a chain of vertices as UV seams."""
        n = len(verts)
        for i in range(n if closed else n - 1):
            e = self.bm.edges.get([verts[i], verts[(i + 1) % n]])
            if e is not None:
                e.seam = True

    def crease(self, verts, value, closed=True):
        """Sharpens the edges along a chain of vertices when subdivided (0-1)."""
        layer = self.bm.edges.layers.float.get("crease_edge") or self.bm.edges.layers.float.new("crease_edge")
        n = len(verts)
        for i in range(n if closed else n - 1):
            e = self.bm.edges.get([verts[i], verts[(i + 1) % n]])
            if e is not None:
                e[layer] = value

    def finish(self):
        """The cage as a mesh object (normals outward, vertex groups in BONES order)."""
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        me = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(me)
        self.bm.free()
        obj = blend.link(bpy.data.objects.new(self.name, me))
        obj["parts"] = dict(self.parts)
        for b in rig.BONES:
            obj.vertex_groups.new(name=rig.gltf_name(b))
        return obj


def subdivide(obj, levels, crease=None):
    """Catmull-Clark, applied; UVs smoothed but island borders kept."""
    m = obj.modifiers.new("subd", "SUBSURF")
    m.levels = m.render_levels = levels
    m.uv_smooth = "PRESERVE_BOUNDARIES"
    m.boundary_smooth = "ALL"
    m.quality = 3
    blend.apply_modifiers(obj)
    return obj


def copy(obj, name):
    o = obj.copy()
    o.data = obj.data.copy()
    o.name = o.data.name = name
    return blend.link(o)


def attribute(obj, name, domain_size=None):
    a = obj.data.attributes[name]
    n = len(a.data)
    out = np.empty(n, dtype=np.int64 if a.data_type == "INT" else np.float64)
    a.data.foreach_get("value", out)
    return out
