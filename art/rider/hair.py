"""Hair: a shell over the scalp and chunky clumps rooted in it, the way the old consoles built spiky hair.

Everything is placed on the head by casting rays at its detailed mesh, so the
hair sits on whatever head it is built for.
"""

import math

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

import blend
import mhhead
import rig
from paint import fbm, smoothstep

# The designed head the hairlines (a body's HAIRLINE: by azimuth, degrees from the front either side, the
# height before `head_scaled`) were drawn on had its eyes here.
EYES_Z = 1.669


def direction(az, el):
    a, e = math.radians(az), math.radians(el)
    return np.array([math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e)])


class Head:
    """A body's head: ray casts against its detailed mesh, and where its hairline runs."""

    def __init__(self, high, fig):
        self.tree = BVHTree.FromObject(high, bpy.context.evaluated_depsgraph_get())
        self.fig = fig
        self.centre = mhhead.landmark("centre", fig.name)
        self.eye_z = float(mhhead.landmark("eye_l", fig.name)[2])
        self.ear = mhhead.landmark("ear", fig.name)

    def surface(self, d):
        """Where a ray from outside toward the centre along -d first meets the head, and the normal there."""
        d = np.asarray(d, dtype=np.float64)
        d = d / np.linalg.norm(d)
        o = self.centre + d * 0.3
        hit, normal, _, _ = self.tree.ray_cast(Vector(o), Vector(-d), 0.4)
        if hit is None:
            return self.centre + d * 0.09, d
        return np.array(hit), np.array(normal)

    def hairline_z(self, az):
        return hairline_z(self.fig, az)


def hairline_z(fig, az):
    """The hairline's height on a body's head at this azimuth."""
    keys = np.array(fig.HAIRLINE)
    z = float(np.interp(abs(az), keys[:, 0], keys[:, 1]))
    # The designed head had its eyes this much higher.
    eyes_down = float(fig.head_scaled((0, 0, EYES_Z))[2]) - float(mhhead.landmark("eye_l", fig.name)[2])
    return float(fig.head_scaled((0, 0, z))[2]) - eyes_down


def hairline_elev(head, az):
    """The elevation (degrees) at which the head's surface reaches the hairline at this azimuth."""
    lo, hi = -50.0, 89.0
    z = head.hairline_z(az)
    for _ in range(30):
        mid = (lo + hi) / 2
        p, _ = head.surface(direction(az, mid))
        if p[2] < z:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def beanie_band(head, az):
    """Where a beanie's edge sits (elevation): low on the forehead, over the tops of the ears, low round the
    back of the head."""
    a = abs(az)
    if a < 60:
        return hairline_elev(head, az) - 5.0 + 3.0 * (a / 60) ** 2
    return float(np.interp(a, [60, 75, 95, 115, 140, 180], [hairline_elev(head, 60) - 1.0, 9, 11, 7, -1, -4]))


class Mesh:
    def __init__(self, name, centre):
        self.name = name
        self.centre = centre
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new("uv")
        self.uvs = {}

    def verts(self, pts, uvs):
        vs = [self.bm.verts.new(tuple(float(c) for c in p)) for p in pts]
        for v, t in zip(vs, uvs):
            self.uvs[v] = t
        return vs

    def quad(self, vs, uvs=None):
        f = self.bm.faces.new(vs)
        for lo, v in zip(f.loops, vs):
            lo[self.uv].uv = uvs[vs.index(v)] if uvs else self.uvs[v]
        return f

    def finish(self):
        # A shell open at the bottom: every face looks away from the head's middle (the game culls back faces).
        flip = [f for f in self.bm.faces
                if f.normal_update() or f.normal.dot(f.calc_center_median() - Vector(self.centre)) < 0]
        if flip:
            bmesh.ops.reverse_faces(self.bm, faces=flip)
        me = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(me)
        self.bm.free()
        obj = blend.link(bpy.data.objects.new(self.name, me))
        g = obj.vertex_groups.new(name=rig.gltf_name("head"))
        g.add(list(range(len(me.vertices))), 1.0, "REPLACE")
        return obj


def shell(head, name, lift=0.009, rows=9, cols=32, top_el=None, bottom_drop=0.004, cut_el=None, uv_box=(0, 0, 1, 0.5)):
    """A shell over the scalp, from just below the hairline (tucked in) to the crown, or up to `cut_el`."""
    m = Mesh(name, head.centre)
    u0, v0, u1, v1 = uv_box
    grid = []
    azs = [360 * i / cols - 180 for i in range(cols)]
    lines = [hairline_elev(head, a) for a in azs]
    for k in range(rows + 1):
        row, uvs = [], []
        for i, a in enumerate(azs):
            e0 = lines[i] - 2.0
            e1 = cut_el if cut_el is not None else 88.0
            t = k / rows
            e = e0 + (e1 - e0) * t
            p, n = head.surface(direction(a, e))
            off = lift * (0.45 + 0.55 * smoothstep(0.0, 0.25, t))
            if k == 0:
                off = lift * 0.15
                p = p - np.array([0, 0, bottom_drop])
            row.append(p + n * off)
            uvs.append((u0 + (u1 - u0) * i / cols, v0 + (v1 - v0) * t))
        grid.append(m.verts(row, uvs))
    for k in range(rows):
        for i in range(cols):
            j = (i + 1) % cols
            a, b, c, d = grid[k][i], grid[k][j], grid[k + 1][j], grid[k + 1][i]
            uvq = [m.uvs[a], m.uvs[b], m.uvs[c], m.uvs[d]]
            if j == 0:
                uvq[1] = (u1, uvq[1][1])
                uvq[2] = (u1, uvq[2][1])
            m.quad([a, b, c, d], uvq)
    if cut_el is None:
        top = m.verts([head.surface((0, 0.05, 1))[0] + np.array([0, 0, lift])], [((u0 + u1) / 2, v1)])[0]
        for i in range(cols):
            j = (i + 1) % cols
            a, b = grid[rows][i], grid[rows][j]
            ub = m.uvs[b] if j else (u1, m.uvs[b][1])
            f = m.bm.faces.new([a, b, top])
            for lo, uv in zip(f.loops, [m.uvs[a], ub, m.uvs[top]]):
                lo[m.uv].uv = uv
    return m


def clump(m, root, normal, flow, lift, length, width, depth, seed, cell, sides=5, segs=5):
    """A clump of hair: a flat, tapering lock that leaves the scalp along `flow` (made tangent to it) and lifts
    away by `lift` toward its tip; UVs in `cell` (u0, v0, u1, v1), around then along."""
    rng = np.random.default_rng(seed)
    n = normal / np.linalg.norm(normal)
    f = np.asarray(flow, dtype=np.float64)
    f = f - n * np.dot(f, n)
    f /= np.linalg.norm(f)
    side = np.cross(f, n)
    side /= np.linalg.norm(side)
    u0, v0, u1, v1 = cell
    rings = []
    centre = np.asarray(root, dtype=np.float64) - n * 0.003
    d = f
    for s in range(segs + 1):
        t = s / segs
        if s:
            d = f + n * lift * t * 1.6
            d /= np.linalg.norm(d)
            centre = centre + d * length / segs
        w = width * (1 - t) ** 0.7 + 0.0012
        h = depth * (1 - 0.6 * t) * (1 - t) ** 0.5 + 0.0008
        up = np.cross(side, d)
        up /= np.linalg.norm(up)
        sd = np.cross(d, up)
        twist = rng.uniform(-0.15, 0.15) * t
        ring, uvs = [], []
        for i in range(sides):
            a = 2 * math.pi * i / sides + twist
            # A lens-shaped section: flat underneath, domed on top.
            sa = math.sin(a)
            p = centre + sd * math.cos(a) * w + up * (sa * h if sa > 0 else sa * h * 0.35)
            ring.append(p)
            uvs.append((u0 + (u1 - u0) * i / sides, v0 + (v1 - v0) * t))
        rings.append(m.verts(ring, uvs))
    tip = m.verts([centre + d * length * 0.1], [((u0 + u1) / 2, v1)])[0]
    for s in range(segs):
        a_, b_ = rings[s], rings[s + 1]
        for i in range(sides):
            j = (i + 1) % sides
            uvq = [m.uvs[a_[i]], m.uvs[a_[j]], m.uvs[b_[j]], m.uvs[b_[i]]]
            if j == 0:
                uvq[1] = (u1, uvq[1][1])
                uvq[2] = (u1, uvq[2][1])
            m.quad([a_[i], a_[j], b_[j], b_[i]], uvq)
    for i in range(sides):
        j = (i + 1) % sides
        f_ = m.bm.faces.new([rings[-1][i], rings[-1][j], tip])
        ub = m.uvs[rings[-1][j]] if j else (u1, m.uvs[rings[-1][j]][1])
        for lo, uv in zip(f_.loops, [m.uvs[rings[-1][i]], ub, m.uvs[tip]]):
            lo[m.uv].uv = uv
    base = m.verts([np.asarray(root) - n * 0.008], [((u0 + u1) / 2, v0)])[0]
    for i in range(sides):
        j = (i + 1) % sides
        f_ = m.bm.faces.new([rings[0][j], rings[0][i], base])
        ua = m.uvs[rings[0][j]] if j else (u1, m.uvs[rings[0][j]][1])
        for lo, uv in zip(f_.loops, [ua, m.uvs[rings[0][i]], m.uvs[base]]):
            lo[m.uv].uv = uv


# Spiky (hair 0): spikes by where they rise (azimuth; degrees above the hairline), height (m), radius
# (degrees) and the way their tips lean (a world direction, made tangent to the head).
def _spikes():
    out = []
    # The fringe: locks falling forward over the forehead, the outer ones swept to the sides.
    for az in (-50, -33, -16, 0, 16, 33, 50):
        out.append((az, -7, 0.03 - abs(az) * 0.0001, 12, (az / 60, -0.6, -1.0)))
    for az in range(-168, 180, 24):
        back = abs(az) > 100
        out.append((az, 19, 0.03 if back else 0.04, 19, (0, 0.6, 0.5) if back else (0, -0.3, 1)))
    for az in range(-160, 180, 32):
        back = abs(az) > 100
        out.append((az, 36, 0.028 if back else 0.034, 21, (0, 0.5, 0.7) if back else (0, -0.35, 1)))
    for az in (0, 72, -72, 144, -144):
        out.append((az, 56, 0.026, 23, (0, -0.2, 1)))
    for sgn in (1, -1):
        for az in (70, 92, 114):
            out.append((sgn * az, 4, 0.018, 12, (0, 0.8, -0.45)))
    for az in (146, 180, -146):
        out.append((az, 5, 0.02, 14, (0, 0.3, -1)))
    return out


def _jitter(spikes, seed=7):
    """Messier: each spike a little taller or shorter, a little off its place and its lean."""
    rng = np.random.default_rng(seed)
    out = []
    for az, above, h, w, flow in spikes:
        f = np.array(flow, float) + rng.normal(0, 0.18, 3) * np.array([1, 1, 0.5])
        out.append((az + rng.uniform(-5, 5), above + rng.uniform(-2.5, 2.5), h * rng.uniform(0.78, 1.25),
                    w * rng.uniform(0.85, 1.15), tuple(f)))
    return out


SPIKES = _jitter(_spikes())


# How a helmet of hair is cut (hair 0's, the spiky one, by default): its spikes and how much of their height they
# get; the fringe (hanging over the forehead, fully within `full` degrees of `centre` and not past `none`) cut
# into `locks` over the azimuths `span`, each dropping `drop` degrees below the hairline plus a random `length`
# (more toward one side with `slope`, per 60 degrees) with a pointed tip (`sharp`); the shell's lift off the
# scalp (at its edge, toward the crown, more under the fringe); and past `tuck` degrees the edge tucks in.
SPIKY = {
    "spikes": SPIKES, "height": 0.74,
    "fringe": {"centre": 0.0, "full": 40.0, "none": 62.0, "span": (-60.0, 60.0), "locks": 8, "seed": 100,
               "drop": 9.0, "length": (5.0, 12.0), "sharp": (1.2, 2.2), "slope": 0.0},
    "lift": {"base": 0.009, "fringe": 0.004, "crown": 0.007, "edge": 0.001, "edge_fringe": 0.006},
    "tuck": 60.0,
}


def helmet(head, under_cap=False, cols=80, rows=None, under_beanie=False, cut=SPIKY):
    """A shell over the scalp pushed out into spikes (hair 0's, or as `cut`); under a cap or a beanie, only what
    shows below it (under a beanie, the fringe too)."""
    fr, li = cut["fringe"], cut["lift"]
    name = "cap" if under_cap else "beanie" if under_beanie else "free"
    under = under_cap or under_beanie
    rows = rows or (10 if under else 28)
    m = Mesh(name, head.centre)
    azs = [360 * i / cols - 180 for i in range(cols)]
    lines = [hairline_elev(head, a) for a in azs]
    band = {a: beanie_band(head, a) for a in azs} if under_beanie else {}
    spikes = []
    for az, above, h, w, flow in cut["spikes"]:
        e0 = hairline_elev(head, az)
        el = min(e0 + above, 84)
        if under_cap and (el > 28 or abs(az) < 60):
            continue
        if under_beanie and el > beanie_band(head, az) - 2:
            continue
        spikes.append((direction(az, el), h * (0.5 if under else cut["height"]), math.radians(w),
                       np.array(flow, float)))
    grid = []
    for k in range(rows + 1):
        row, uvs = [], []
        for i, a in enumerate(azs):
            # The fringe hangs onto the forehead; elsewhere the edge tucks in at the hairline.
            top = band[a] + 3.0 if under_beanie else 28.0 if under_cap else 88.0
            fringe = smoothstep(fr["none"], fr["full"], abs(a - fr["centre"]))
            # The fringe comes down over the forehead in pointed locks.
            # Irregular locks: each its own width and length.
            lo, hi = fr["span"]
            lock = (a - lo) / (hi - lo) * fr["locks"]
            which = int(np.floor(lock))
            f = lock - which
            rng = np.random.default_rng(fr["seed"] + which)
            length, sharp = rng.uniform(*fr["length"]), rng.uniform(*fr["sharp"])
            length += fr["slope"] * (a - fr["centre"]) / 60
            saw = abs(f - 0.5) * 2
            e0 = lines[i] - 1.5 - fringe * (fr["drop"] + length * (1 - saw) ** sharp)
            top = max(top, e0 + 2.0)
            t = k / rows
            e = e0 + (top - e0) * t
            # A swept fringe leans sideways the further it falls below the hairline.
            u = direction(a + fr.get("sweep", 0.0) * fringe * max(0.0, lines[i] - e), e)
            p, n = head.surface(u)
            lift = li["base"] + li["fringe"] * fringe + li["crown"] * smoothstep(e0, 70, e)
            if k == 0:
                lift = li["edge"] + li["edge_fringe"] * fringe
                p = p - n * 0.002 * (1 - fringe)
            best, flow, wsum = 0.0, np.zeros(3), 0.0
            for v, h, w, f in spikes:
                d = math.acos(max(-1.0, min(1.0, float(np.dot(u, v)))))
                c = h * max(0.0, 1 - d / w) ** cut.get("profile", 1.8)
                best = max(best, c)
                # The lean blends between neighbouring spikes, so the surface never tears where they meet.
                wk = c**3
                flow = flow + f * wk
                wsum += wk
            flow = flow / wsum if wsum > 0 else None
            # The bottom edge stays tucked in, except where the fringe stands up from it.
            best *= smoothstep(0.0, 0.12, t) if abs(a) > cut["tuck"] else 1.0
            q = p + n * (lift + best)
            if flow is not None:
                ft = flow - n * np.dot(flow, n)
                if np.linalg.norm(ft) > 1e-6:
                    q = q + ft / np.linalg.norm(ft) * best * 0.75
            row.append(q)
            uvs.append(((a / 360 + 0.5) % 1.0, t))
        grid.append(m.verts(row, uvs))
    for k in range(rows):
        for i in range(cols):
            j = (i + 1) % cols
            vs = [grid[k][i], grid[k][j], grid[k + 1][j], grid[k + 1][i]]
            uvq = [m.uvs[v] for v in vs]
            us = [uv[0] for uv in uvq]
            if max(us) - min(us) > 0.5:
                uvq = [(uv[0] + 1 if uv[0] < 0.5 else uv[0], uv[1]) for uv in uvq]
            m.quad(vs, uvq)
    if not under:
        cap = m.verts([np.mean([np.array(v.co[:]) for v in grid[rows]], axis=0)], [(0.5, 1.0)])[0]
        for i in range(cols):
            j = (i + 1) % cols
            f = m.bm.faces.new([grid[rows][i], grid[rows][j], cap])
            uvq = [m.uvs[grid[rows][i]], m.uvs[grid[rows][j]], (m.uvs[grid[rows][i]][0], 1.0)]
            if abs(uvq[1][0] - uvq[0][0]) > 0.5:
                uvq[1] = (uvq[1][0] + 1, uvq[1][1])
            for lo, uv in zip(f.loops, uvq):
                lo[m.uv].uv = uv
    obj = m.finish()
    obj["spikes"] = len(spikes)
    return obj


def paint_hair(maps):
    """Hair colour (mask B): dark at the roots and in the valleys between spikes, lighter up each spike, strands
    running up them, a sheen over the top."""
    inside = maps["inside"]
    pos = maps["pos"]
    ao = np.clip(maps["ao"], 0, 1)
    L = maps["light"]
    ref = np.percentile(L[inside], 85) if inside.any() else 1.0
    s = np.clip(L / ref, 0, 1.4)
    h, w = ao.shape
    v = np.linspace(1, 0, h)[:, None] * np.ones((1, w))
    u = np.linspace(0, 1, w)[None, :] * np.ones((h, 1))
    strands = fbm(np.stack([u * 260, v * 3, np.zeros_like(u)], axis=-1), 1.0, octaves=3, seed=5)
    # Dark partings between locks of strands: the ridges of a second noise, thin.
    part = 1 - np.abs(fbm(np.stack([u * 130, v * 1.6, np.ones_like(u)], axis=-1), 1.0, octaves=2, seed=11) - 0.5) * 2
    partings = smoothstep(0.82, 0.96, part)
    curv = np.clip((maps["curv"] - 0.5) * 6, -1, 1)
    g = 0.27 + 0.15 * np.clip(s, 0, 1.3) + 0.2 * (strands - 0.5)
    g = g * (1 - 0.45 * partings)
    # Valleys (concave) darker, spike ridges (convex) lighter.
    g = g * (1 + 0.35 * np.maximum(curv, 0) - 0.45 * np.maximum(-curv, 0))
    g = g * (0.45 + 0.55 * ao)
    up = np.clip(maps["nrm"][..., 2], 0, 1)
    sheen = smoothstep(0.4, 0.85, up) * (0.4 + 0.6 * strands) * ao * (1 - partings)
    g = g + 0.18 * sheen
    detail = np.repeat(g[..., None], 3, axis=2)
    mask = np.zeros_like(detail)
    mask[..., 2] = 1
    return np.clip(detail, 0, 1), mask

