"""Headwear: the cap, the wrap shades, the beanie and the goggles, fitted to the head by casting rays at it."""

import math

import bmesh
import bpy
import numpy as np
from mathutils import Vector

import blend
import mhhead
import rig
from hair import beanie_band, direction, hairline_elev
from kit import thicken
from paint import noise, smoothstep
from skin import blur


def _mesh(name, P, UV, closed=True):
    """A grid mesh (rows x cols), closed round the columns or not, with UVs per point."""
    rows, cols = P.shape[:2]
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new("uv")
    vs = [[bm.verts.new(tuple(P[i, j])) for j in range(cols)] for i in range(rows)]
    for i in range(rows - 1):
        for j in range(cols if closed else cols - 1):
            j2 = (j + 1) % cols
            f = bm.faces.new([vs[i][j], vs[i][j2], vs[i + 1][j2], vs[i + 1][j]])
            uvs = [tuple(UV[i, j]), tuple(UV[i, j2]), tuple(UV[i + 1, j2]), tuple(UV[i + 1, j])]
            us = [u for u, _ in uvs]
            if max(us) - min(us) > 0.5:
                uvs = [(u + 1.0 if u < 0.5 else u, v) for u, v in uvs]
            for lo, uv in zip(f.loops, uvs):
                lo[uvl].uv = uv
    return bm, vs, uvl


def _object(name, bm, outward=None):
    if outward is not None:
        flip = [f for f in bm.faces if f.normal_update() or f.normal.dot(f.calc_center_median() - Vector(outward)) < 0]
        if flip:
            bmesh.ops.reverse_faces(bm, faces=flip)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = blend.link(bpy.data.objects.new(name, me))
    g = obj.vertex_groups.new(name=rig.gltf_name("head"))
    g.add(list(range(len(me.vertices))), 1.0, "REPLACE")
    return obj


# ---------------------------------------------------------------- cap

def band_elev(head, az):
    """Where the cap's band sits (elevation): across the forehead, over the ears, round the back."""
    a = abs(az)
    above = np.interp(a, [0, 50, 80, 100, 140, 180], [4, 5, 17, 20, 13, 11])
    return hairline_elev(head, az) + above if a < 70 else float(np.interp(a, [70, 100, 140, 180], [24, 28, 16, 10]))


def cap(head, cols=48, rows=12):
    """A six-panel cap: a crown over the head and a curved brim at the front."""
    P = np.zeros((rows + 1, cols, 3))
    UV = np.zeros((rows + 1, cols, 2))
    azs = [360 * j / cols - 180 for j in range(cols)]
    for i in range(rows + 1):
        t = i / rows
        for j, a in enumerate(azs):
            e0 = band_elev(head, a)
            e = e0 + (89.0 - e0) * t
            p, n = head.surface(direction(a, e))
            # Over the short hair at the band, snug over the crown (no hair under it there).
            off = 0.019 - 0.007 * smoothstep(0.0, 0.5, t) + 0.004 * smoothstep(0.5, 1.0, t)
            P[i, j] = p + n * off
            UV[i, j] = ((a / 360 + 0.5) % 1.0, 0.35 + 0.65 * t)
    bm, vs, uvl = _mesh("cap", P, UV)
    top = bm.verts.new(tuple(np.mean(P[rows], axis=0) + np.array([0, 0, 0.003])))
    for j in range(cols):
        j2 = (j + 1) % cols
        f = bm.faces.new([vs[rows][j], vs[rows][j2], top])
        uvs = [tuple(UV[rows, j]), tuple(UV[rows, j2]), (UV[rows, j][0], 1.0)]
        if abs(uvs[1][0] - uvs[0][0]) > 0.5:
            uvs[1] = (uvs[1][0] + 1, uvs[1][1])
        for lo, uv in zip(f.loops, uvs):
            lo[uvl].uv = uv
    crown = _object("cap", bm, outward=head.centre - np.array([0, 0, 0.03]))
    thicken(crown, 0.004, inner_uv=(0.0, 0.0, 1.0, 0.04), rim_uv=(0.0, 0.045, 1.0, 0.06))
    # The brim: from the band at the front out and a little down, round at its edge.
    bcols, brows = 24, 6
    B = np.zeros((brows + 1, bcols, 3))
    BUV = np.zeros((brows + 1, bcols, 2))
    for j in range(bcols):
        a = -66 + 132 * j / (bcols - 1)
        e0 = band_elev(head, a)
        p, n = head.surface(direction(a, e0))
        root = p + n * 0.019
        f = abs(a) / 66
        # A D-shaped brim: out in front of the face, nothing at the temples.
        reach = 0.075 * max(0.0, 1 - f**2) ** 0.55
        out = np.array([math.sin(math.radians(a)) * 0.55, -1.0, 0.0])
        out /= np.linalg.norm(out)
        for i in range(brows + 1):
            t = i / brows
            d = reach * t
            # A gentle curve down across it, and down toward the sides.
            B[i, j] = root + out * d + np.array([0, 0, -0.004 - 0.012 * t - 0.012 * t * f])
            BUV[i, j] = (0.05 + 0.9 * j / (bcols - 1), 0.07 + 0.25 * t)
    bm, _, _ = _mesh("brim", B, BUV, closed=False)
    brim = _object("brim", bm)
    # The brim's top faces up.
    up = sum(p.normal.z for p in brim.data.polygons)
    if up < 0:
        bm = bmesh.new()
        bm.from_mesh(brim.data)
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
        bm.to_mesh(brim.data)
        bm.free()
    thicken(brim, 0.006, inner_uv=(0.0, 0.0, 1.0, 0.04), rim_uv=(0.0, 0.045, 1.0, 0.06))
    blend.deselect()
    crown.select_set(True)
    brim.select_set(True)
    bpy.context.view_layer.objects.active = crown
    bpy.ops.object.join()
    crown.name = crown.data.name = "cap"
    return crown


def paint_cap(maps):
    inside = maps["inside"]
    pos = maps["pos"]
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    L = blur(maps["light"], inside, 2)
    ref = np.percentile(L[inside], 85) if inside.any() else 1.0
    s = np.clip(L / ref, 0, 1.4) * (0.5 + 0.5 * np.clip(blur(maps["ao"], inside, 2), 0, 1))
    s = s * (1 + 0.04 * (noise(pos, 900, seed=6) - 0.5))
    v = np.linspace(1, 0, inside.shape[0])[:, None] * np.ones((1, inside.shape[1]))
    u = np.linspace(0, 1, inside.shape[1])[None, :] * np.ones((inside.shape[0], 1))
    crown = v > 0.35
    brim = (v > 0.065) & (v < 0.33)
    # Panel seams down the crown (six), and stitching rows round the brim.
    seams = np.zeros_like(s)
    for k in range(6):
        seams += smoothstep(0.004, 0.0015, np.abs(((u - k / 6 + 0.5) % 1.0) - 0.5)) * crown
    s = s * (1 - 0.22 * np.clip(seams, 0, 1))
    stitch = (np.abs(((v - 0.07) / 0.25) * 6 % 1 - 0.5) < 0.06) * brim * (np.sin(u * 900) > 0)
    s = s * (1 - 0.15 * stitch)
    detail = np.repeat((0.5 * s)[..., None], 3, axis=2)
    mask = np.zeros_like(detail)
    mask[..., 0] = 1
    # The brim's underside in the second colour; a button on top and a small front patch in the accent.
    under = brim & (maps["nrm"][..., 2] < -0.2)
    mask = np.where(under[..., None], np.array([0, 1.0, 0]), mask)
    button = smoothstep(0.82, 0.96, maps["nrm"][..., 2]) * crown * (v > 0.95)
    patch = np.exp(-((x / 0.022) ** 2) - ((z - (z[crown].min() if crown.any() else 0) - 0.035) / 0.014) ** 2)
    patch = patch * (y < -0.07) * crown
    acc = np.clip(button + smoothstep(0.5, 0.7, patch), 0, 1)
    mask = mask * (1 - acc[..., None]) + np.array([0, 0, 1.0]) * acc[..., None]
    detail = np.where((v < 0.062)[..., None], detail * 0.45, detail)
    return np.clip(detail, 0, 1), np.clip(mask, 0, 1)


# ---------------------------------------------------------------- shades

# Aviators, sized to the eyes (a body's eyes this far either side of the middle get these): how far each lens
# wraps round (degrees) and tilts in at the bottom, how much it bulges and how far it keeps off the face (m).
AVIATOR = {"eye_x": 0.03, "wrap": 12.0, "tilt": 8.0, "bulge": 0.003, "clear": 0.006}
# The lens's teardrop round its middle (m; u toward the temple, v up): a flat top, a round outer edge, the belly
# deepest a little toward the nose.
TEARDROP = [(0.019, 0.0148), (0.026, 0.0095), (0.0285, 0.0), (0.0265, -0.0085), (0.0205, -0.016), (0.01, -0.0228),
            (-0.004, -0.027), (-0.0145, -0.0262), (-0.0215, -0.0195), (-0.0248, -0.008), (-0.0248, 0.0055),
            (-0.0205, 0.0138), (-0.008, 0.0165), (0.006, 0.0165)]
# The metal: round the lenses, the bridges and the arms (radii, m).
RIM, BRIDGE, ARM = 0.0016, 0.0014, 0.0015
LENS_RINGS, LENS_SEGS = 7, 32


def _teardrop():
    """TEARDROP smoothed (Catmull-Rom) into (angle, radius) round the middle, by angle."""
    P = np.array(TEARDROP)
    n = len(P)
    pts = []
    for i in range(n):
        p0, p1, p2, p3 = P[(i - 1) % n], P[i], P[(i + 1) % n], P[(i + 2) % n]
        for t in np.linspace(0, 1, 16, endpoint=False):
            pts.append(0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                              + (3 * p1 - p0 - 3 * p2 + p3) * t ** 3))
    pts = np.array(pts)
    ang = np.arctan2(pts[:, 1], pts[:, 0]) % (2 * math.pi)
    order = np.argsort(ang)
    return ang[order], np.linalg.norm(pts, axis=1)[order]


_TEAR = _teardrop()


def _lens_outline(th, k):
    """The lens's edge at angle `th` round its middle (from the temple side, up), scaled by `k`: (u, v)."""
    a, r = _TEAR
    th = th % (2 * math.pi)
    rr = float(np.interp(th, np.concatenate([a - 2 * math.pi, a, a + 2 * math.pi]), np.concatenate([r, r, r])))
    return math.cos(th) * rr * k, math.sin(th) * rr * k


class _Lens:
    """Where one lens sits: its middle and frame (u toward the temple, v up, n out of the lens)."""

    def __init__(self, head, s, k):
        eye = mhhead.landmark("eye_l", head.fig.name)
        w, t = math.radians(AVIATOR["wrap"]), math.radians(AVIATOR["tilt"])
        self.k, self.s = k, s
        self.eu = np.array([s * math.cos(w), math.sin(w), 0.0])
        self.ev = np.array([0.0, -math.sin(t), math.cos(t)])
        n = np.cross(self.eu, self.ev)
        self.n = n if n[1] < 0 else -n
        self.c = np.array([s * (abs(eye[0]) + 0.004 * k), eye[1] - 0.012, eye[2] - 0.003 * k])
        # Out from the face until every part of the lens clears it.
        for _ in range(3):
            short = 0.0
            for th in np.linspace(0, 2 * math.pi, 24, endpoint=False):
                for r in (0.0, 0.5, 1.0):
                    q = self.at(r, th)
                    loc, nrm, _, d = head.tree.find_nearest(Vector(q))
                    if loc is None:
                        continue
                    if np.dot(q - np.array(loc), np.array(nrm)) < 0:
                        d = -d
                    short = max(short, AVIATOR["clear"] - d)
            self.c = self.c + self.n * short

    def at(self, r, th, out=0.0):
        """The point `r` (0 middle, 1 edge) of the way out at angle `th`, `out` off the lens's face."""
        u, v = _lens_outline(th, self.k)
        u, v = u * r, v * r
        bulge = AVIATOR["bulge"] * self.k * (1 - r * r)
        return self.c + self.eu * u + self.ev * v + self.n * (bulge + out)


def _wire(bm, uvl, points, r, box, closed=False, sides=6):
    """A round wire along `points`, its UVs in `box` (round it, along it)."""
    u0, v0, u1, v1 = box
    pts = [np.asarray(p, dtype=np.float64) for p in points]
    n = len(pts)
    rings_ = []
    prev = None
    for i, c in enumerate(pts):
        a, b = pts[(i - 1) % n if closed else max(i - 1, 0)], pts[(i + 1) % n if closed else min(i + 1, n - 1)]
        d = (b - a) / (np.linalg.norm(b - a) + 1e-12)
        side = np.cross(d, (0, 0, 1)) if prev is None else prev - d * np.dot(prev, d)
        if np.linalg.norm(side) < 1e-6:
            side = np.cross(d, (1, 0, 0))
        side = side / np.linalg.norm(side)
        prev = side
        up = np.cross(side, d)
        rings_.append([bm.verts.new(tuple(c + (side * math.cos(2 * math.pi * q / sides) + up *
                                               math.sin(2 * math.pi * q / sides)) * r)) for q in range(sides)])
    segs = n if closed else n - 1
    for i in range(segs):
        i2 = (i + 1) % n
        for q in range(sides):
            q2 = (q + 1) % sides
            f = bm.faces.new([rings_[i][q], rings_[i][q2], rings_[i2][q2], rings_[i2][q]])
            ua, ub = u0 + (u1 - u0) * q / sides, u0 + (u1 - u0) * (q + 1) / sides
            va, vb = v0 + (v1 - v0) * i / segs, v0 + (v1 - v0) * (i + 1) / segs
            for lo, uv in zip(f.loops, [(ua, va), (ub, va), (ub, vb), (ua, vb)]):
                lo[uvl].uv = uv
    if not closed:
        for end in (rings_[0], rings_[-1]):
            bm.faces.new(end)


def shades(head):
    """Aviators: a teardrop lens before each eye, a thin metal rim round each, the double bridge over the nose,
    and wire arms back over the ears."""
    eye = mhhead.landmark("eye_l", head.fig.name)
    k = abs(eye[0]) / AVIATOR["eye_x"]
    lenses = {s: _Lens(head, s, k) for s in (1, -1)}
    # The lenses: a disc of rings each, mirrored on the second colour.
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new("uv")
    for s, L in lenses.items():
        u0 = 0.0 if s > 0 else 0.5
        rows = []
        for i in range(1, LENS_RINGS + 1):
            r = i / LENS_RINGS
            rows.append([bm.verts.new(tuple(L.at(r, 2 * math.pi * q / LENS_SEGS))) for q in range(LENS_SEGS)])
        mid = bm.verts.new(tuple(L.at(0.0, 0.0)))

        def uv_of(r, th):
            u, v = _lens_outline(th, 1.0)
            return (u0 + 0.25 + 0.22 * s * r * u / 0.028, 0.5 + 0.45 * r * v / 0.026)

        for q in range(LENS_SEGS):
            q2 = (q + 1) % LENS_SEGS
            th, th2 = 2 * math.pi * q / LENS_SEGS, 2 * math.pi * q2 / LENS_SEGS
            f = bm.faces.new([mid, rows[0][q], rows[0][q2]])
            for lo, uv in zip(f.loops, [uv_of(0, 0), uv_of(1 / LENS_RINGS, th), uv_of(1 / LENS_RINGS, th2)]):
                lo[uvl].uv = uv
            for i in range(LENS_RINGS - 1):
                r, r2 = (i + 1) / LENS_RINGS, (i + 2) / LENS_RINGS
                f = bm.faces.new([rows[i][q], rows[i + 1][q], rows[i + 1][q2], rows[i][q2]])
                for lo, uv in zip(f.loops, [uv_of(r, th), uv_of(r2, th), uv_of(r2, th2), uv_of(r, th2)]):
                    lo[uvl].uv = uv
    # (One sheet each: an inner face this close behind would shadow it.)
    lens = _object("lens", bm, outward=head.centre)
    # The frame: the rims, the bridges between the lenses' inner tops (a straight bar over a curved one), the
    # arms from the outer top corners back to the ears, hooking down behind them.
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new("uv")
    ths = np.linspace(0, 2 * math.pi, 36, endpoint=False)
    for s, L in lenses.items():
        u0 = 0.0 if s > 0 else 0.5
        _wire(bm, uvl, [L.at(1.03, th, out=-0.0004) for th in ths], RIM * k, (u0, 0.0, u0 + 0.5, 0.3), closed=True)
    inner = {s: lenses[s].at(1.0, math.radians(150)) for s in (1, -1)}
    top = {s: lenses[s].at(1.0, math.radians(112)) for s in (1, -1)}
    bar = [top[1] + (top[-1] - top[1]) * t + np.array([0, -0.0015, 0.0025 * k]) * math.sin(math.pi * t) * 0.3
           for t in np.linspace(0, 1, 9)]
    _wire(bm, uvl, bar, BRIDGE * k, (0.0, 0.3, 0.5, 0.4))
    arch = [inner[1] + (inner[-1] - inner[1]) * t + np.array([0, -0.003, 0.0045 * k]) * math.sin(math.pi * t)
            for t in np.linspace(0, 1, 9)]
    _wire(bm, uvl, arch, BRIDGE * k, (0.5, 0.3, 1.0, 0.4))
    for s, L in lenses.items():
        start = L.at(1.02, math.radians(25))
        ear = head.ear * np.array([s, 1.0, 1.0]) + np.array([-s * 0.004, 0.008, 0.009])
        # Along the side of the head, a little out from it, then down behind the ear.
        pts = []
        for t in np.linspace(0, 1, 10):
            p = start + (ear - start) * t
            pts.append(p + np.array([s * 0.003, 0, 0.002]) * math.sin(math.pi * t))
        back = ear + np.array([0, 0.012, -0.004])
        pts += [ear + (back - ear) * 0.5 + np.array([0, 0, 0.001]), back, back + np.array([-s * 0.002, 0.004, -0.012])]
        u0 = 0.0 if s > 0 else 0.5
        _wire(bm, uvl, pts, ARM * k, (u0, 0.4, u0 + 0.5, 1.0))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    frame = _object("frame", bm)
    return {"frame": frame, "lens": lens}


def paint_frame(maps):
    inside = maps["inside"]
    L = blur(maps["light"], inside, 1)
    ref = np.percentile(L[inside], 85) if inside.any() else 1.0
    s = np.clip(L / ref, 0, 1.4) * (0.55 + 0.45 * np.clip(maps["ao"], 0, 1))
    up = np.clip(maps["nrm"][..., 2], 0, 1)
    s = s * (1 + 0.4 * smoothstep(0.6, 0.95, up))
    detail = np.repeat((0.5 * s)[..., None], 3, axis=2)
    mask = np.zeros_like(detail)
    mask[..., 0] = 1
    return np.clip(detail, 0, 1), mask


def paint_lens(maps):
    """Mirrored lenses (the second colour), dark at the top fading lighter down them, the sky caught in a
    streak across the top."""
    pos = maps["pos"]
    z = pos[..., 2]
    zc = mhhead.landmark("eye_l", maps["fig"].name)[2]
    t = np.clip((z - (zc - 0.028)) / 0.045, 0, 1)
    g = 0.42 - 0.24 * smoothstep(0.15, 0.85, t)
    streak = np.exp(-(((t - 0.78) / 0.07) ** 2)) * 0.32 * (0.6 + 0.4 * np.sin(pos[..., 0] * 300) ** 2)
    g = g + streak
    detail = np.repeat(g[..., None], 3, axis=2)
    mask = np.zeros_like(detail)
    mask[..., 1] = 1
    return np.clip(detail, 0, 1), mask


# ---------------------------------------------------------------- beanie

# The beanie's rows up from its edge: (degrees above the edge, out from the head in m, v in the texture).
# The cuff is folded up (thicker) to a step, then the knit runs up over the crown.
BEANIE_ROWS = [(0, 0.017, 0.08), (5, 0.0185, 0.13), (11, 0.019, 0.18), (17, 0.0195, 0.23), (21.5, 0.02, 0.27),
               (23, 0.0158, 0.29), (32, 0.0172, 0.4), (44, 0.0205, 0.53), (56, 0.024, 0.66), (68, 0.027, 0.79),
               (79, 0.029, 0.9), (86, 0.03, 0.97)]
BEANIE_CUFF_V = (0.08, 0.275)


def beanie(head, cols=48):
    """A cuffed knit beanie, pulled down to the brows and over the tops of the ears."""
    rows = len(BEANIE_ROWS)
    P = np.zeros((rows, cols, 3))
    UV = np.zeros((rows, cols, 2))
    azs = [360 * j / cols - 180 for j in range(cols)]
    bands = [beanie_band(head, a) for a in azs]
    for i, (above, off, v) in enumerate(BEANIE_ROWS):
        for j, a in enumerate(azs):
            e0 = bands[j]
            # The rows close in over the crown whatever the edge's height.
            e = e0 + above if above < 23 else e0 + 23 + (89.0 - e0 - 23) * (above - 23) / (89 - 23)
            p, n = head.surface(direction(a, min(e, 88.5)))
            # The knit slouches a little at the back of the crown.
            slouch = 0.007 * smoothstep(80, 170, abs(a)) * math.sin(math.pi * min(1.0, max(0.0, (above - 23) / 63)))
            P[i, j] = p + n * (off + slouch)
            UV[i, j] = ((a / 360 + 0.5) % 1.0, v)
    bm, vs, uvl = _mesh("beanie", P, UV)
    top = bm.verts.new(tuple(np.mean(P[-1], axis=0) + np.array([0, 0, 0.004])))
    for j in range(cols):
        j2 = (j + 1) % cols
        f = bm.faces.new([vs[-1][j], vs[-1][j2], top])
        uvs = [tuple(UV[-1, j]), tuple(UV[-1, j2]), (UV[-1, j][0], 1.0)]
        if abs(uvs[1][0] - uvs[0][0]) > 0.5:
            uvs[1] = (uvs[1][0] + 1, uvs[1][1])
        for lo, uv in zip(f.loops, uvs):
            lo[uvl].uv = uv
    obj = _object("beanie", bm, outward=head.centre - np.array([0, 0, 0.03]))
    thicken(obj, 0.004, inner_uv=(0.0, 0.0, 1.0, 0.04), rim_uv=(0.0, 0.045, 1.0, 0.06))
    return obj


def paint_beanie(maps):
    inside = maps["inside"]
    L = blur(maps["light"], inside, 2)
    ref = np.percentile(L[inside], 85) if inside.any() else 1.0
    s = np.clip(L / ref, 0, 1.4) * (0.45 + 0.55 * np.clip(blur(maps["ao"], inside, 2), 0, 1))
    h, w = inside.shape
    v = np.linspace(1, 0, h)[:, None] * np.ones((1, w))
    u = np.linspace(0, 1, w)[None, :] * np.ones((h, 1))
    c0, c1 = BEANIE_CUFF_V
    cuff = (v > c0) & (v < c1)
    crown = v >= c1
    # Knit: ribs round the cuff, a finer rib up the crown, gathered at the top.
    rib = np.sin(u * 2 * np.pi * 72) * 0.5 + 0.5
    s = s * (1 - 0.1 * rib * cuff) * (1 - 0.05 * (np.sin(u * 2 * np.pi * 120) * 0.5 + 0.5) * crown)
    s = s * (1 - 0.12 * smoothstep(0.92, 1.0, v) * (np.sin(u * 2 * np.pi * 12) * 0.5 + 0.5))
    # The cuff's top edge folds over: a dark line under it.
    s = s * (1 - 0.35 * smoothstep(0.012, 0.0, np.abs(v - (c1 + 0.006))))
    detail = np.repeat((0.5 * s)[..., None], 3, axis=2)
    mask = np.zeros_like(detail)
    mask[..., 0] = 1
    # Two stripes round the cuff in the second colour, a woven label at the front in the accent.
    for vc in (c0 + 0.06, c0 + 0.11):
        stripe = smoothstep(0.016, 0.012, np.abs(v - vc)) * cuff
        mask = mask * (1 - stripe[..., None]) + np.array([0, 1.0, 0]) * stripe[..., None]
    label = smoothstep(0.03, 0.026, np.abs(u - 0.43)) * smoothstep(0.05, 0.044, np.abs(v - (c0 + 0.12))) * cuff
    mask = mask * (1 - label[..., None]) + np.array([0, 0, 1.0]) * label[..., None]
    detail = np.where((v < 0.062)[..., None], detail * 0.45, detail)
    return np.clip(detail, 0, 1), np.clip(mask, 0, 1)


# ---------------------------------------------------------------- goggles

GOGGLE_LENS = 68.0
GOGGLE_FRAME = 74.0
GOGGLE_HALF = 0.03
GOGGLE_FRAME_HALF = 0.038
GOGGLE_CLEAR = 0.016
STRAP_HALF = 0.017


def _goggle_front(head):
    """The goggles' front, round the face at the eyes' height: for an azimuth (degrees), how far out from the
    head's middle it sits (the face's furthest point over the brows, the eyes and the cheekbones, smoothed)."""
    keys = np.arange(-100, 101, 2)
    reach = []
    for a in keys:
        out = 0.0
        for e in np.linspace(-11, 16, 10):
            p, _ = head.surface(direction(a, e))
            out = max(out, float(np.hypot(p[0] - head.centre[0], p[1] - head.centre[1])))
        reach.append(out)
    reach = np.array(reach)
    k = np.exp(-((np.arange(-8, 9) / 4.0) ** 2))
    smooth = np.convolve(np.pad(reach, 8, mode="edge"), k / k.sum(), mode="valid")
    return lambda a: float(np.interp(a, keys, smooth))


def _goggle_outline(u, half_az, half_v, p=3.4):
    """A rounded rectangle in (azimuth, height) round the eyes, dipping up over the nose."""
    c, s = math.cos(u), math.sin(u)
    a = half_az * math.copysign(abs(c) ** (2 / p), c)
    v = half_v * math.copysign(abs(s) ** (2 / p), s)
    if v < 0:
        v *= 1 - 0.5 * math.exp(-((a / 15.0) ** 2))
    return a, v


def goggles(head, cols=56):
    """Snow goggles over the eyes: one big lens curving round the face, a frame round it standing out of it, and
    a strap round the head (over a beanie)."""
    reach = _goggle_front(head)
    zc = head.eye_z + 0.003

    def at(a, v, out):
        ar = math.radians(a)
        r = reach(a) + GOGGLE_CLEAR + out
        return np.array([head.centre[0] + math.sin(ar) * r, head.centre[1] - math.cos(ar) * r, zc + v])

    us = [2 * math.pi * j / cols for j in range(cols)]
    # The lens: rings in from its edge to its middle, bulging forward in the middle.
    rows = [1.0, 0.8, 0.6, 0.4, 0.2]
    P = np.zeros((len(rows), cols, 3))
    UV = np.zeros((len(rows), cols, 2))
    for i, t in enumerate(rows):
        for j, u in enumerate(us):
            a, v = _goggle_outline(u, GOGGLE_LENS * t, GOGGLE_HALF * t)
            bulge = 0.005 * (1 - (a / GOGGLE_LENS) ** 2) * (1 - (v / GOGGLE_HALF) ** 2)
            P[i, j] = at(a, v, bulge)
            UV[i, j] = (0.5 + 0.48 * a / GOGGLE_LENS, 0.62 + 0.36 * v / GOGGLE_HALF * 0.5 + 0.18)
    bm, vs, uvl = _mesh("lens", P, UV)
    mid = bm.verts.new(tuple(at(0.0, 0.0, 0.005)))
    for j in range(cols):
        j2 = (j + 1) % cols
        f = bm.faces.new([vs[-1][j], vs[-1][j2], mid])
        for lo, uv in zip(f.loops, [tuple(UV[-1, j]), tuple(UV[-1, j2]), (0.5, 0.8)]):
            lo[uvl].uv = uv
    lens = _object("lens", bm, outward=head.centre)
    thicken(lens, 0.002, inner_uv=(0.0, 0.0, 1.0, 0.2), rim_uv=(0.0, 0.22, 1.0, 0.3))
    # The frame: from the lens's edge out, standing proud of it and rounded over, then back to the face.
    profile = [(0.0, 0.0015), (0.35, 0.0034), (0.75, 0.003), (1.0, 0.0008)]
    F = np.zeros((len(profile), cols, 3))
    FUV = np.zeros((len(profile), cols, 2))
    for i, (t, out) in enumerate(profile):
        for j, u in enumerate(us):
            a0, v0 = _goggle_outline(u, GOGGLE_LENS, GOGGLE_HALF)
            a1, v1 = _goggle_outline(u, GOGGLE_FRAME, GOGGLE_FRAME_HALF)
            F[i, j] = at(a0 + (a1 - a0) * t, v0 + (v1 - v0) * t, out)
            FUV[i, j] = (j / cols, 0.6 + 0.38 * t)
    bm, _, _ = _mesh("frame", F, FUV)
    frame = _object("frame", bm, outward=head.centre)
    thicken(frame, 0.013, inner_uv=(0.0, 0.0, 1.0, 0.05), rim_uv=(0.0, 0.06, 1.0, 0.12))
    # The strap: from the frame's sides round the back of the head, over a beanie, a little higher behind.
    scols = 40
    S = np.zeros((3, scols, 3))
    SUV = np.zeros((3, scols, 2))
    for j in range(scols):
        t = j / (scols - 1)
        a = GOGGLE_FRAME - 3 + (360 - 2 * (GOGGLE_FRAME - 3)) * t
        a = a - 360 if a > 180 else a
        rise = 0.01 * smoothstep(80, 170, abs(a))
        off = 0.0175 + 0.0095 * smoothstep(GOGGLE_FRAME, 100, abs(a))
        for i, v in enumerate((-STRAP_HALF, 0.0, STRAP_HALF)):
            z = zc + v + rise
            e = math.degrees(math.atan2(z - head.centre[2], 0.095))
            p, _ = head.surface(direction(a, e))
            ar = math.radians(a)
            radial = np.array([math.sin(ar), -math.cos(ar), 0.0])
            S[i, j] = np.array([p[0], p[1], z]) + radial * off
            SUV[i, j] = (0.02 + 0.96 * t, 0.14 + 0.36 * i / 2)
    bm, _, _ = _mesh("strap", S, SUV, closed=False)
    strap = _object("strap", bm, outward=head.centre)
    thicken(strap, 0.003, inner_uv=(0.0, 0.0, 1.0, 0.05), rim_uv=(0.0, 0.06, 1.0, 0.12))
    blend.deselect()
    frame.select_set(True)
    strap.select_set(True)
    bpy.context.view_layer.objects.active = frame
    bpy.ops.object.join()
    frame.name = frame.data.name = "frame"
    return {"frame": frame, "lens": lens}


def paint_goggle_frame(maps):
    """The frame and its strap in the second colour: vents along the frame's top, the foam dark against the face,
    the brand printed along the strap in the accent."""
    inside = maps["inside"]
    pos = maps["pos"]
    L = blur(maps["light"], inside, 1)
    ref = np.percentile(L[inside], 85) if inside.any() else 1.0
    s = np.clip(L / ref, 0, 1.4) * (0.5 + 0.5 * np.clip(maps["ao"], 0, 1))
    h, w = inside.shape
    v = np.linspace(1, 0, h)[:, None] * np.ones((1, w))
    u = np.linspace(0, 1, w)[None, :] * np.ones((h, 1))
    frame = v >= 0.58
    strap = (v > 0.13) & (v < 0.52)
    foam = v < 0.13
    zc = mhhead.landmark("eye_l", maps["fig"].name)[2] + 0.003
    top = frame & (pos[..., 2] > zc + GOGGLE_HALF + 0.002)
    vents = top * (np.abs(((u * 14) % 1) - 0.5) < 0.18) * (np.abs(v - 0.8) < 0.08)
    s = s * (1 - 0.5 * vents)
    detail = np.repeat((0.5 * s)[..., None], 3, axis=2)
    detail = np.where(foam[..., None], detail * 0.35, detail)
    mask = np.zeros_like(detail)
    mask[..., 1] = 1
    # Along the strap: a line near each edge, and the brand's blocks every few centimetres.
    sv = (v - 0.14) / 0.36
    edges = (np.abs(sv - 0.14) < 0.05) | (np.abs(sv - 0.86) < 0.05)
    blocks = (np.abs(((u * 9) % 1) - 0.5) < 0.2) & (np.abs(sv - 0.5) < 0.22)
    acc = strap & (edges | blocks)
    mask = np.where(acc[..., None], np.array([0, 0, 1.0]), mask)
    # A small mark on each side of the frame.
    side = frame & (np.abs(pos[..., 0]) > 0.07) & (np.abs(pos[..., 2] - zc) < 0.008) & (np.abs(v - 0.78) < 0.1)
    mask = np.where(side[..., None], np.array([0, 0, 1.0]), mask)
    return np.clip(detail, 0, 1), np.clip(mask, 0, 1)


def paint_goggle_lens(maps):
    """A mirrored lens in the main colour: the sky bright across its top, a dark horizon, the snow's glare below,
    a streak of light across it."""
    pos = maps["pos"]
    z = pos[..., 2]
    zc = mhhead.landmark("eye_l", maps["fig"].name)[2] + 0.003
    t = np.clip((z - (zc - GOGGLE_HALF)) / (2 * GOGGLE_HALF), 0, 1)
    g = 0.3 + 0.42 * smoothstep(0.45, 0.85, t) + 0.12 * smoothstep(0.3, 0.0, t)
    streak = np.exp(-(((t - 0.62 + 0.35 * pos[..., 0] / 0.09) / 0.07) ** 2)) * 0.3
    g = g + streak
    detail = np.repeat(g[..., None], 3, axis=2)
    mask = np.zeros_like(detail)
    mask[..., 0] = 1
    return np.clip(detail, 0, 1), mask
