"""The riders' heads from MakeHuman (exported by mh.py): placed on the body and stitched to the top ring of the
neck, with the eyes in their sockets and the mouth closed."""

import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
from mathutils.interpolate import poly_3d_calc

SOURCE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mh")

# MakeHuman's head onto the body: a little broader than life, back and up to sit over the neck.
SCALE = np.array([1.025, 1.0, 1.0])
OFFSET = np.array([0.0, 0.065, 0.025])

# How much of the neck ring's offset each row of vertices above it follows (row 0 is the ring itself).
FOLLOW = [1.0, 0.6, 0.25]


def _place(co):
    return co * SCALE + OFFSET


def landmark(name, body="male"):
    """A landmark of the placed head (see mh.landmarks): a point, or a height for "crown"."""
    import json

    with open(os.path.join(SOURCE, f"{body}.json")) as f:
        v = json.load(f)[name]
    if isinstance(v, list):
        return _place(np.array(v, dtype=np.float64))
    return float(v * SCALE[2] + OFFSET[2])


class Source:
    """The exported meshes, placed on the body."""

    def __init__(self, body):
        before = set(bpy.data.objects)
        bpy.ops.wm.obj_import(filepath=os.path.join(SOURCE, f"{body}.obj"))
        self.objects = {o.name: o for o in bpy.data.objects if o not in before}
        for o in self.objects.values():
            o.data.transform(o.matrix_world)
            o.matrix_world = Matrix.Identity(4)
            me = o.data
            co = np.empty(len(me.vertices) * 3)
            me.vertices.foreach_get("co", co)
            me.vertices.foreach_set("co", _place(co.reshape(-1, 3)).ravel())
            me.update()
            o.hide_render = True
        self.offset = None

    def __getitem__(self, name):
        return self.objects[name]

    def remove(self):
        for o in self.objects.values():
            bpy.data.objects.remove(o)


def _boundary_loops(bm):
    """Closed chains of boundary edges, as ordered lists of vertices."""
    left = {e for e in bm.edges if e.is_boundary}
    loops = []
    while left:
        e = left.pop()
        chain = [e.verts[0], e.verts[1]]
        while True:
            v = chain[-1]
            nxt = [x for x in v.link_edges if x in left]
            if not nxt:
                break
            left.discard(nxt[0])
            w = nxt[0].other_vert(v)
            if w is chain[0]:
                break
            chain.append(w)
        loops.append(chain)
    return loops


def _rows(bm, start):
    """Each vertex's distance in edges from the `start` vertices."""
    dist = {v: 0 for v in start}
    frontier = list(start)
    while frontier:
        nxt = []
        for v in frontier:
            for e in v.link_edges:
                w = e.other_vert(v)
                if w not in dist:
                    dist[w] = dist[v] + 1
                    nxt.append(w)
        frontier = nxt
    return dist


def _match(ring_pos, loop_pos):
    """The rotation and direction of `loop_pos` closest to `ring_pos` (both closed, the same length)."""
    n = len(ring_pos)
    best = None
    for flip in (False, True):
        q = loop_pos[::-1] if flip else loop_pos
        for k in range(n):
            d = np.linalg.norm(ring_pos - np.roll(q, -k, axis=0), axis=1).sum()
            if best is None or d < best[0]:
                best = (d, flip, k)
    _, flip, k = best
    idx = list(range(n))
    idx = idx[::-1] if flip else idx
    return idx[k:] + idx[:k]


class Offset:
    """Moves the neck of the MakeHuman head onto the body's neck ring, fading out up the neck; the same
    offset is applied to the other meshes (the detailed head, the eyes) by where they sit on the head."""

    def __init__(self, bm, base, ring_pos):
        self.centre = np.array([v.co[:] for v in base]).mean(axis=0)
        loop_pos = np.array([v.co[:] for v in base])
        order = _match(ring_pos, loop_pos)
        self.base = [base[i] for i in order]
        d = ring_pos - np.array([v.co[:] for v in self.base])
        ang = np.array([self._angle(v.co) for v in self.base])
        k = np.argsort(ang)
        self.ang, self.d = ang[k], d[k]
        rows = _rows(bm, self.base)
        self.per_vert = {}
        for v, r in rows.items():
            f = FOLLOW[r] if r < len(FOLLOW) else 0.0
            self.per_vert[v.index] = self.at(v.co) * f if f else np.zeros(3)
        bm.verts.ensure_lookup_table()
        self.rest = np.array([v.co[:] for v in bm.verts])
        self.moved = self.rest + np.array([self.per_vert[i] for i in range(len(bm.verts))])
        self.faces = [[v.index for v in f.verts] for f in bm.faces]
        self.tree = BVHTree.FromPolygons([tuple(p) for p in self.rest], self.faces)

    def _angle(self, p):
        return math.atan2(p[1] - self.centre[1], p[0] - self.centre[0])

    def at(self, p):
        """The ring's offset at the angle of `p` round the neck."""
        a = self._angle(p)
        ang = np.concatenate([self.ang - 2 * math.pi, self.ang, self.ang + 2 * math.pi])
        d = np.concatenate([self.d, self.d, self.d])
        return np.array([np.interp(a, ang, d[:, i]) for i in range(3)])

    def apply_all(self, src):
        """Moves every other exported mesh (the detailed head, eyes, brows, lashes) with the head."""
        for name, obj in src.objects.items():
            if name != "head":
                self.apply(obj)

    def apply(self, obj):
        """Moves another mesh by the offset of the nearest point of the head."""
        me = obj.data
        co = np.empty(len(me.vertices) * 3)
        me.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3)
        for i, p in enumerate(co):
            hit, _, fi, _ = self.tree.find_nearest(Vector(p))
            if fi is None:
                continue
            ids = self.faces[fi]
            w = poly_3d_calc([Vector(self.rest[j]) for j in ids], hit)
            co[i] = p + sum(wj * (self.moved[j] - self.rest[j]) for wj, j in zip(w, ids))
        me.vertices.foreach_set("co", co.ravel())
        me.update()


def _uv_seams(bm):
    uv = bm.loops.layers.uv.active
    out = []
    for e in bm.edges:
        if len(e.link_faces) != 2:
            continue
        f1, f2 = e.link_faces

        def uvs(f):
            return {lo.vert: lo[uv].uv.copy() for lo in f.loops}

        a, b = uvs(f1), uvs(f2)
        if any((a[v] - b[v]).length > 1e-5 for v in e.verts):
            out.append(e)
    return out


def _ear_side(bm):
    """Vertex -> 1 or -1 for the ears (the UV islands off the main one), 0 elsewhere."""
    uv = bm.loops.layers.uv.active
    seams = set(_uv_seams(bm))
    seen, islands = set(), []
    for f in bm.faces:
        if f in seen:
            continue
        stack, isl = [f], []
        seen.add(f)
        while stack:
            g = stack.pop()
            isl.append(g)
            for e in g.edges:
                if e in seams:
                    continue
                for h in e.link_faces:
                    if h not in seen:
                        seen.add(h)
                        stack.append(h)
        islands.append(isl)
    islands.sort(key=len, reverse=True)
    side = {}
    for isl in islands[1:]:
        vs = {v for f in isl for v in f.verts}
        x = np.mean([v.co.x for v in vs])
        if abs(x) > 0.05:
            for v in vs:
                side[v] = 1 if x > 0 else -1
    del uv
    return side


def head_weights(row, z, y):
    """Neck and head weights for a head vertex `row` edges above the neck ring."""
    w = 0.0 if row <= 1 else (0.65 if row == 2 else 1.0)
    # The back of the neck turns with the neck up to the skull.
    if y > 0.075:
        w = min(w, max(0.0, min(1.0, (z - 1.555) / 0.05)))
    return {"neck": 1.0 - w, "head": w} if w < 1.0 else {"head": 1.0}


def face_region(bm, off):
    """The faces of the face: in front of the ears, from under the chin to the top of the forehead."""
    eye_z = landmark("eye_l")[2]
    centre_y = landmark("centre")[1]
    out = set()
    for f in bm.faces:
        c = np.mean([off.moved[v.index] for v in f.verts], axis=0)
        if c[1] < centre_y - 0.045 and eye_z - 0.105 < c[2] < eye_z + 0.055 and abs(c[0]) < 0.068:
            out.add(f)
    return out


def attach(cage, neck, src, region):
    """Builds the head into the cage on top of `neck` (a closed ring of 16 cage vertices). Returns the offset
    (for the detailed head) and the cage vertices of the eye sockets and the mouth."""
    head = src["head"]
    bm = bmesh.new()
    bm.from_mesh(head.data)
    bm.verts.ensure_lookup_table()
    loops = _boundary_loops(bm)
    base = min(loops, key=lambda L: np.mean([v.co.z for v in L]))
    if len(base) != len(neck):
        raise RuntimeError(f"neck loop has {len(base)} vertices, the ring {len(neck)}")
    holes = [L for L in loops if L is not base]
    mouth = min(holes, key=lambda L: np.mean([v.co.z for v in L]))
    eyes = [L for L in holes if L is not mouth]
    ring_pos = np.array([v.co[:] for v in neck])
    off = Offset(bm, base, ring_pos)
    rows = _rows(bm, off.base)
    ears = _ear_side(bm)
    vmap = {v: c for v, c in zip(off.base, neck)}
    for v in bm.verts:
        if v in vmap:
            continue
        p = off.moved[v.index]
        side = ears.get(v, 0)
        part = f"ear.{side}" if side else "head"
        vmap[v] = cage.vert(p, head_weights(rows[v], p[2], p[1]), part=part)
    skin_faces = set()
    for f in bm.faces:
        cf = cage.face([vmap[v] for v in f.verts], region)
        if any(v in vmap and vmap[v] in neck for v in f.verts):
            skin_faces.add(f)
    # Seams: MakeHuman's own, round the face (its own island, so it gets the texels), and where the face's
    # texture meets the body's.
    for e in _uv_seams(bm):
        cage.seam([vmap[e.verts[0]], vmap[e.verts[1]]])
    front = face_region(bm, off)
    for e in bm.edges:
        fs = e.link_faces
        if len(fs) == 2 and ((fs[0] in front) != (fs[1] in front)):
            cage.seam([vmap[e.verts[0]], vmap[e.verts[1]]])
    for e in bm.edges:
        fs = e.link_faces
        if len(fs) == 2 and ((fs[0] in skin_faces) != (fs[1] in skin_faces)):
            cage.seam([vmap[e.verts[0]], vmap[e.verts[1]]])
    # The mouth: lips meeting at a line a little behind them.
    m = [vmap[v] for v in mouth]
    centre = np.mean([off.moved[v.index] for v in mouth], axis=0) + np.array([0, 0.004, 0])
    cage.cap(m, centre, {"head": 1.0}, region, part="mouth")
    cage.seam(m, closed=True)
    sockets = [[vmap[v] for v in L] for L in eyes]
    # The eyes: each socket closed a little behind the lids, the eyeball painted onto it by the bake. The lids
    # keep their shape when subdivided, so the eyes stay as open as MakeHuman's.
    for L, sock in zip(eyes, sockets):
        cage.crease(sock, 1.0)
        c = np.mean([off.moved[v.index] for v in L], axis=0) + np.array([0, 0.0025, 0])
        cage.cap(sock, c, {"head": 1.0}, region, part="head")
    # The eyes' part names the detailed eyeballs the bake paints onto the sockets.
    cage.part_id("eye")
    off.mouth = centre
    off.apply_all(src)
    bm.free()
    return off, sockets


def high(src, off, parts, subdiv=1):
    """The detailed head (its mouth closed) and the eyes as one mesh to bake from, every vertex tagged with its
    part (`part`: the eyes now, the rest by `tag_parts`)."""
    objs = []
    for name in ("head.high", "eyes"):
        o = src[name].copy()
        o.data = src[name].data.copy()
        bpy.context.scene.collection.objects.link(o)
        o.hide_render = False
        objs.append(o)
    bm = bmesh.new()
    bm.from_mesh(objs[0].data)
    loops = _boundary_loops(bm)
    mouth = min(loops, key=lambda L: np.linalg.norm(np.mean([v.co[:] for v in L], axis=0) - off.mouth))
    edges = [e for e in bm.edges if e.is_boundary and e.verts[0] in mouth and e.verts[1] in mouth]
    bmesh.ops.holes_fill(bm, edges=edges, sides=0)
    bm.to_mesh(objs[0].data)
    bm.free()
    for o, pid in zip(objs, (parts.get("head", 0), parts.get("eye", 0))):
        a = o.data.attributes.new("part", "INT", "POINT")
        a.data.foreach_set("value", np.full(len(o.data.vertices), pid, dtype=np.int32))
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    obj = objs[0]
    obj.name = obj.data.name = "head.bake"
    if subdiv:
        m = obj.modifiers.new("subd", "SUBSURF")
        m.levels = m.render_levels = subdiv
        bpy.ops.object.modifier_apply(modifier=m.name)
    return obj


def tag_parts(obj, low, parts):
    """Copies the part of the nearest low-head vertex onto the detailed head (ears, mouth), keeping the eyes."""
    from mathutils.kdtree import KDTree

    lp = low.data.attributes["part"]
    n = len(low.data.vertices)
    kd = KDTree(n)
    for v in low.data.vertices:
        kd.insert(v.co, v.index)
    kd.balance()
    lpart = np.empty(n, dtype=np.int64)
    lp.data.foreach_get("value", lpart)
    a = obj.data.attributes["part"]
    cur = np.empty(len(obj.data.vertices), dtype=np.int64)
    a.data.foreach_get("value", cur)
    eye = parts.get("eye", -1)
    for v in obj.data.vertices:
        if cur[v.index] == eye:
            continue
        _, i, _ = kd.find(v.co)
        cur[v.index] = lpart[i]
    a.data.foreach_set("value", cur.astype(np.int32))
