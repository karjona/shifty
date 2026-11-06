"""Headwear: the cap, the wrap shades, the beanie and the goggles, fitted to the head by casting rays at it."""

import math

import bmesh
import bpy
import numpy as np
from mathutils import Vector

import blend
import male
import mhhead
import rig
from hair import CENTRE, beanie_band, direction, hairline_elev
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
    crown = _object("cap", bm, outward=CENTRE - np.array([0, 0, 0.03]))
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

def shades(head):
    """Wraparound shades: a lens band curving round the face, a frame along its top, arms back to the ears."""
    cols, rows = 28, 4
    # The lens follows a smooth curve in front of the eyes (not the face's every bump).
    zc = mhhead.landmark("eye_l")[2] + 0.002
    half_h = 0.0155 * male.HEAD_SCALE
    P = np.zeros((rows + 1, cols, 3))
    UV = np.zeros((rows + 1, cols, 2))
    for j in range(cols):
        a = -82 + 164 * j / (cols - 1)
        p, n = head.surface(direction(a, 4))
        ar = math.radians(a)
        out = np.array([math.sin(ar), -math.cos(ar), 0.0])
        # Clear of the brow and the nose: further out in front.
        clear = 0.009 + 0.004 * math.cos(ar) ** 2
        base = np.array([p[0], p[1], zc]) + out * clear
        for i in range(rows + 1):
            t = i / rows
            # Taller in front, narrower round the sides; a dip over the nose.
            h = half_h * (1 - 0.35 * (abs(a) / 82) ** 2)
            dz = (t * 2 - 1) * h
            nose = 0.007 * math.exp(-((a / 9) ** 2)) * (1 - t)
            P[i, j] = base + np.array([0, 0, dz + nose + 0.003 * (1 - (a / 82) ** 2)])
            UV[i, j] = (0.02 + 0.96 * j / (cols - 1), 0.5 + 0.45 * t)
    bm, _, _ = _mesh("lens", P, UV, closed=False)
    lens = _object("lens", bm, outward=CENTRE)
    thicken(lens, 0.002, inner_uv=(0.0, 0.0, 1.0, 0.2), rim_uv=(0.0, 0.22, 1.0, 0.3))
    # The frame: a bar along the top of the lens and the arms back over the ears.
    frame_pts = []
    for j in range(cols):
        frame_pts.append(P[rows, j] + np.array([0, 0, 0.002]))
    arms = []
    for sgn in (1, -1):
        start = P[rows, -1 if sgn > 0 else 0]
        ear = mhhead.landmark("ear") * np.array([sgn, 1.0, 1.0]) + np.array([-sgn * 0.004, 0.012, 0.008])
        arms.append((start, ear))
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new("uv")

    def bar(points, w, h, v0, v1):
        rings_ = []
        for k, c in enumerate(points):
            nxt = points[min(k + 1, len(points) - 1)] - points[max(k - 1, 0)]
            nxt = nxt / (np.linalg.norm(nxt) + 1e-9)
            up = np.array([0, 0, 1.0])
            side = np.cross(nxt, up)
            side /= np.linalg.norm(side) + 1e-9
            ring = [bm.verts.new(tuple(c + side * sx * w + up * sz * h))
                    for sx, sz in ((1, 1), (-1, 1), (-1, -1), (1, -1))]
            rings_.append(ring)
        for k in range(len(rings_) - 1):
            for q in range(4):
                q2 = (q + 1) % 4
                f = bm.faces.new([rings_[k][q], rings_[k][q2], rings_[k + 1][q2], rings_[k + 1][q]])
                for lo, uv in zip(f.loops, [(q / 4, v0 + (v1 - v0) * k / len(rings_)),
                                            (q2 / 4 or 1.0, v0 + (v1 - v0) * k / len(rings_)),
                                            (q2 / 4 or 1.0, v0 + (v1 - v0) * (k + 1) / len(rings_)),
                                            (q / 4, v0 + (v1 - v0) * (k + 1) / len(rings_))]):
                    lo[uvl].uv = uv
        for end in (rings_[0], rings_[-1]):
            bm.faces.new(end)

    bar(frame_pts, 0.0025, 0.0028, 0.32, 0.6)
    for start, ear in arms:
        pts = [start + (ear - start) * t for t in np.linspace(0, 1, 6)]
        bar(pts, 0.0018, 0.0035, 0.62 if start[0] > 0 else 0.81, 0.79 if start[0] > 0 else 0.98)
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
    """Mirrored lenses (the second colour): a sky above, the dark sea below, a bright streak."""
    pos = maps["pos"]
    z = pos[..., 2]
    zc = mhhead.landmark("eye_l")[2] + 0.002
    t = np.clip((z - (zc - 0.017)) / 0.034, 0, 1)
    g = 0.22 + 0.5 * smoothstep(0.35, 0.75, t)
    streak = np.exp(-(((t - 0.72) / 0.06) ** 2)) * 0.35
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
    obj = _object("beanie", bm, outward=CENTRE - np.array([0, 0, 0.03]))
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
            out = max(out, float(np.hypot(p[0] - CENTRE[0], p[1] - CENTRE[1])))
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
    zc = mhhead.landmark("eye_l")[2] + 0.003

    def at(a, v, out):
        ar = math.radians(a)
        r = reach(a) + GOGGLE_CLEAR + out
        return np.array([CENTRE[0] + math.sin(ar) * r, CENTRE[1] - math.cos(ar) * r, zc + v])

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
    lens = _object("lens", bm, outward=CENTRE)
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
    frame = _object("frame", bm, outward=CENTRE)
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
            e = math.degrees(math.atan2(z - CENTRE[2], 0.095))
            p, _ = head.surface(direction(a, e))
            ar = math.radians(a)
            radial = np.array([math.sin(ar), -math.cos(ar), 0.0])
            S[i, j] = np.array([p[0], p[1], z]) + radial * off
            SUV[i, j] = (0.02 + 0.96 * t, 0.14 + 0.36 * i / 2)
    bm, _, _ = _mesh("strap", S, SUV, closed=False)
    strap = _object("strap", bm, outward=CENTRE)
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
    zc = mhhead.landmark("eye_l")[2] + 0.003
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
    zc = mhhead.landmark("eye_l")[2] + 0.003
    t = np.clip((z - (zc - GOGGLE_HALF)) / (2 * GOGGLE_HALF), 0, 1)
    g = 0.3 + 0.42 * smoothstep(0.45, 0.85, t) + 0.12 * smoothstep(0.3, 0.0, t)
    streak = np.exp(-(((t - 0.62 + 0.35 * pos[..., 0] / 0.09) / 0.07) ** 2)) * 0.3
    g = g + streak
    detail = np.repeat(g[..., None], 3, axis=2)
    mask = np.zeros_like(detail)
    mask[..., 0] = 1
    return np.clip(detail, 0, 1), mask
