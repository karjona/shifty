"""Headwear: the cap and the wrap shades, fitted to the head by casting rays at it."""

import math

import bmesh
import bpy
import numpy as np
from mathutils import Vector

import blend
import male
import mhhead
import rig
from hair import CENTRE, direction, hairline_elev
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
