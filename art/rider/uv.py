"""Seams and unwraps, the way an artist would cut a mesh: along hidden lines."""

import heapq

import bmesh
import bpy
import numpy as np

import blend


def _edge_path(bm, start, goal, cost):
    """The cheapest edge path from vertex `start` to any vertex in `goal` (edge indices)."""
    dist = {start.index: 0.0}
    prev = {}
    heap = [(0.0, start.index)]
    verts = bm.verts
    while heap:
        d, i = heapq.heappop(heap)
        if i in goal:
            path = []
            while i in prev:
                i, e = prev[i]
                path.append(e)
            return path
        if d > dist.get(i, 1e18):
            continue
        v = verts[i]
        for e in v.link_edges:
            o = e.other_vert(v)
            nd = d + cost(e)
            if nd < dist.get(o.index, 1e18):
                dist[o.index] = nd
                prev[o.index] = (i, e.index)
                heapq.heappush(heap, (nd, o.index))
    return []


def mark(obj, seams_fn):
    """Marks seams: `seams_fn(bm)` returns the edges to cut."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    bm.edges.ensure_lookup_table()
    bm.faces.ensure_lookup_table()
    for e in bm.edges:
        e.seam = False
    for i in seams_fn(bm):
        bm.edges[i].seam = True
    bm.to_mesh(obj.data)
    bm.free()


def unwrap(obj, margin=0.01, method="CONFORMAL"):
    blend.select_only(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.unwrap(method=method, margin=margin)
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.pack_islands(rotate=True, margin=margin, scale=True)
    bpy.ops.object.mode_set(mode="OBJECT")


def region_edges(bm, inside):
    """Edges on the border of a set of faces (`inside(face_centre)` -> bool)."""
    flag = {f.index: bool(inside(np.array(f.calc_center_median()))) for f in bm.faces}
    out = []
    for e in bm.edges:
        fs = e.link_faces
        if len(fs) == 2 and flag[fs[0].index] != flag[fs[1].index]:
            out.append(e.index)
    return out


def boundary(bm):
    return [v for v in bm.verts if v.is_boundary]


def path_between(bm, start_pick, goal_pick, cost):
    """A seam from the vertex `start_pick` chooses to the vertices `goal_pick` accepts."""
    start = start_pick(bm)
    goal = {v.index for v in bm.verts if goal_pick(np.array(v.co))}
    return _edge_path(bm, start, goal, cost)


def head(obj, ear):
    """The head: one island peeled open up the back, the ears on their own."""

    def seams(bm):
        edges = region_edges(bm, ear)
        nape = max(boundary(bm), key=lambda v: v.co.y - 4 * abs(v.co.x))
        crown_z = max(v.co.z for v in bm.verts)

        def cost(e):
            m = (e.verts[0].co + e.verts[1].co) / 2
            return e.calc_length() * (1 + 400 * abs(m.x) + 200 * max(0.0, 0.04 - m.y))

        edges += _edge_path(bm, nape, {v.index for v in bm.verts if v.co.z > crown_z - 0.004}, cost)
        return edges

    mark(obj, seams)
    unwrap(obj, margin=0.008)
