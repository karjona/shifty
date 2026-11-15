"""Meshes for the scenery, written corner by corner in the game's axes
(metres, y up, right-handed) and handed to Blender for export.

Every corner carries a position, a normal, a colour (COLOR_0, linear) and
two masks in its UV (see each builder for what they mean in the game's
shaders: on trees, how far along a bough and how much snow it carries).
"""

import math
import random

import bpy


def srgb(h):
    """A 0xRRGGBB colour as linear RGB."""
    def lin(c):
        c /= 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (lin((h >> 16) & 255), lin((h >> 8) & 255), lin(h & 255))


def mixc(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def scale(c, k):
    return tuple(min(1.0, v * k) for v in c)


def add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def mul(a, k):
    return (a[0] * k, a[1] * k, a[2] * k)


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def norm(a):
    n = math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) or 1.0
    return (a[0] / n, a[1] / n, a[2] / n)


def lerp(a, b, t):
    return a + (b - a) * t


def lerp3(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def rot_y(p, a):
    c, s = math.cos(a), math.sin(a)
    return (p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c)


class Mesh:
    """Triangles, each corner with its own position, normal, colour and masks."""

    def __init__(self):
        self.pos = []
        self.nor = []
        self.col = []
        self.uv = []

    def tri(self, a, b, c, col, uv=(0.0, 0.0), nor=None):
        """A triangle (counter-clockwise from its front). `col`, `uv` and
        `nor` are one value for all three corners or a list of three; with
        no normals it is flat."""
        flat = norm(cross(sub(b, a), sub(c, a)))
        cols = col if isinstance(col, list) else [col] * 3
        uvs = uv if isinstance(uv, list) else [uv] * 3
        nors = nor if isinstance(nor, list) else [nor or flat] * 3
        for p, k, u, n in zip((a, b, c), cols, uvs, nors):
            self.pos.append(p)
            self.col.append(k)
            self.uv.append(u)
            self.nor.append(n or flat)

    def quad(self, a, b, c, d, col, uv=(0.0, 0.0), nor=None):
        """A quad a-b-c-d (counter-clockwise), split a-c."""
        cols = col if isinstance(col, list) else [col] * 4
        uvs = uv if isinstance(uv, list) else [uv] * 4
        nors = nor if isinstance(nor, list) else [nor] * 4
        self.tri(a, b, c, [cols[0], cols[1], cols[2]], [uvs[0], uvs[1], uvs[2]], [nors[0], nors[1], nors[2]])
        self.tri(a, c, d, [cols[0], cols[2], cols[3]], [uvs[0], uvs[2], uvs[3]], [nors[0], nors[2], nors[3]])

    def merge(self, other, at=(0.0, 0.0, 0.0), turn=0.0, size=1.0):
        """Adds another mesh, scaled, turned about y and moved."""
        for p, n, k, u in zip(other.pos, other.nor, other.col, other.uv):
            self.pos.append(add(rot_y(mul(p, size), turn), at))
            self.nor.append(rot_y(n, turn))
            self.col.append(k)
            self.uv.append(u)

    def count(self):
        return len(self.pos) // 3

    def tube(self, rings, col, sides=6, uv=(0.0, 0.0), smooth=True, cap=False, twist=0.0):
        """A tube through `rings`: (centre, radius) or (centre, radius,
        colour), bottom to top. Normals point out from each ring's centre
        when `smooth`."""
        pts = []
        for k, ring in enumerate(rings):
            c, r = ring[0], ring[1]
            row = []
            for i in range(sides):
                a = (i / sides) * math.tau + twist * k
                row.append((c[0] + math.cos(a) * r, c[1], c[2] + math.sin(a) * r))
            pts.append(row)
        for k in range(len(rings) - 1):
            ca = rings[k][2] if len(rings[k]) > 2 else col
            cb = rings[k + 1][2] if len(rings[k + 1]) > 2 else col
            for i in range(sides):
                j = (i + 1) % sides
                a, b = pts[k][i], pts[k][j]
                c, d = pts[k + 1][j], pts[k + 1][i]
                if smooth:
                    out = lambda p, ring: norm((p[0] - ring[0][0], 0.0, p[2] - ring[0][2]))
                    nn = [out(a, rings[k]), out(d, rings[k + 1]), out(c, rings[k + 1]), out(b, rings[k])]
                else:
                    nn = None
                self.quad(a, d, c, b, [ca, cb, cb, ca], uv, nn)
        if cap:
            top = rings[-1]
            ct = top[2] if len(top) > 2 else col
            for i in range(sides):
                j = (i + 1) % sides
                self.tri(top[0], pts[-1][j], pts[-1][i], ct, uv, (0.0, 1.0, 0.0) if smooth else None)

    def box(self, lo, hi, col, uv=(0.0, 0.0), faces="xXyYzZ"):
        """An axis-aligned box; `faces` picks its sides (x: -x, X: +x...). `col` is one colour or a dict per side."""
        x0, y0, z0 = lo
        x1, y1, z1 = hi
        sides = {
            "x": ((x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0)),
            "X": ((x1, y0, z1), (x1, y0, z0), (x1, y1, z0), (x1, y1, z1)),
            "y": ((x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)),
            "Y": ((x0, y1, z1), (x1, y1, z1), (x1, y1, z0), (x0, y1, z0)),
            "z": ((x1, y0, z0), (x0, y0, z0), (x0, y1, z0), (x1, y1, z0)),
            "Z": ((x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)),
        }
        for f in faces:
            a, b, c, d = sides[f]
            k = col[f] if isinstance(col, dict) else col
            self.quad(a, b, c, d, k, uv)


def to_blender(name, m):
    """The mesh as a Blender object (z up), with its colours, masks and normals."""
    n = len(m.pos)
    # Corners at one place share a vertex (the exporter then joins the ones that match in everything else).
    verts = []
    index = {}
    corner = []
    for p in m.pos:
        key = (round(p[0], 4), round(p[1], 4), round(p[2], 4))
        if key not in index:
            index[key] = len(verts)
            verts.append((p[0], -p[2], p[1]))
        corner.append(index[key])
    faces = [(corner[i], corner[i + 1], corner[i + 2]) for i in range(0, n, 3)]
    keep = [i for i, f in enumerate(faces) if len(set(f)) == 3]
    faces = [faces[i] for i in keep]
    loops = [k for i in keep for k in (i * 3, i * 3 + 1, i * 3 + 2)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    col = mesh.color_attributes.new(name="Color", type="FLOAT_COLOR", domain="CORNER")
    uv = mesh.uv_layers.new(name="UVMap")
    for i, k in enumerate(loops):
        c = m.col[k]
        col.data[i].color = (c[0], c[1], c[2], 1.0)
        # (The exporter flips v.)
        uv.data[i].uv = (m.uv[k][0], 1.0 - m.uv[k][1])
    mesh.color_attributes.active_color = col
    mesh.polygons.foreach_set("use_smooth", [True] * len(mesh.polygons))
    mesh.normals_split_custom_set([(m.nor[k][0], -m.nor[k][2], m.nor[k][1]) for k in loops])
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def export(path):
    """Everything in the scene as one .glb."""
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_materials="NONE",
        export_vertex_color="ACTIVE",
        export_active_vertex_color_when_no_material=True,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_skins=False,
        export_morph=False,
        export_animations=False,
        export_apply=False,
        export_yup=True,
        export_attributes=False,
        export_extras=False,
    )


def rng(seed):
    return random.Random(seed)


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def clip_polygon(poly, n, d):
    """The part of a polygon where n·p <= d, and the points where it was cut."""
    out = []
    cut = []
    for i, p in enumerate(poly):
        q = poly[(i + 1) % len(poly)]
        dp = dot(n, p) - d
        dq = dot(n, q) - d
        if dp <= 0:
            out.append(p)
        if (dp < 0 < dq) or (dq < 0 < dp):
            t = dp / (dp - dq)
            x = lerp3(p, q, t)
            out.append(x)
            cut.append(x)
    return out, cut


def convex(lo, hi, planes):
    """A box cut by planes (each `(normal, distance)`, keeping n·p <= d): its faces, each a polygon wound counter-clockwise from outside."""
    x0, y0, z0 = lo
    x1, y1, z1 = hi
    polys = [
        [(x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0)],
        [(x1, y0, z1), (x1, y0, z0), (x1, y1, z0), (x1, y1, z1)],
        [(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)],
        [(x0, y1, z1), (x1, y1, z1), (x1, y1, z0), (x0, y1, z0)],
        [(x1, y0, z0), (x0, y0, z0), (x0, y1, z0), (x1, y1, z0)],
        [(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)],
    ]
    for n, d in planes:
        n = norm(n)
        kept = []
        cuts = []
        for poly in polys:
            part, cut = clip_polygon(poly, n, d)
            if len(part) >= 3:
                kept.append(part)
            cuts.extend(cut)
        if len(cuts) >= 3:
            c = (sum(p[0] for p in cuts) / len(cuts), sum(p[1] for p in cuts) / len(cuts), sum(p[2] for p in cuts) / len(cuts))
            ref = (0.0, 1.0, 0.0) if abs(n[1]) < 0.9 else (1.0, 0.0, 0.0)
            u = norm(cross(ref, n))
            v = cross(n, u)
            ordered = sorted(cuts, key=lambda p: math.atan2(dot(sub(p, c), v), dot(sub(p, c), u)))
            cap = []
            for p in ordered:
                if not cap or math.dist(p, cap[-1]) > 1e-4:
                    cap.append(p)
            if len(cap) >= 3 and math.dist(cap[0], cap[-1]) < 1e-4:
                cap.pop()
            if len(cap) >= 3:
                kept.append(cap)
        polys = kept
    return polys


def polygon_normal(poly):
    n = (0.0, 0.0, 0.0)
    for i in range(1, len(poly) - 1):
        n = add(n, cross(sub(poly[i], poly[0]), sub(poly[i + 1], poly[0])))
    return norm(n)


def polygon_area(poly):
    n = (0.0, 0.0, 0.0)
    for i in range(1, len(poly) - 1):
        n = add(n, cross(sub(poly[i], poly[0]), sub(poly[i + 1], poly[0])))
    return 0.5 * math.sqrt(dot(n, n))


def centroid(poly):
    k = len(poly)
    return (sum(p[0] for p in poly) / k, sum(p[1] for p in poly) / k, sum(p[2] for p in poly) / k)
