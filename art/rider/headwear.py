"""Hair, caps and shades for the male head (all rigid on the head bone)."""

import math

import numpy as np

import logo
from kit import Garment, Piece
from paint import Canvas, fbm, form_light, noise, smoothstep
from sdf import (
    Ellipsoid,
    Fn,
    Intersect,
    Plane,
    RoundCone,
    Shell,
    Sphere,
    Subtract,
    Union,
    normalize,
)

CRANIUM = (np.array([0.0, 0.022, 1.668]), np.array([0.076, 0.098, 0.106]))
HEAD_C = np.array([0.0, 0.02, 1.665])


def _azimuth(p):
    """Angle around the head from the front (0) to the back (pi), either side."""
    return np.arctan2(np.abs(p[:, 0]), -(p[:, 1] - 0.02))


def _hairline(phi):
    """How high the hair starts at each azimuth: the forehead, the temples, over the ears, the nape."""
    keys_phi = np.array([0.0, 0.5, 0.9, 1.25, 1.6, 2.2, math.pi])
    keys_z = np.array([1.706, 1.7, 1.682, 1.66, 1.64, 1.6, 1.585])
    return np.interp(phi, keys_phi, keys_z)


def _scalp(grow):
    c, r = CRANIUM
    cap = Ellipsoid(c + np.array([0, 0.002, 0.003]), r + grow)
    line = Fn(lambda p: _hairline(_azimuth(p)) - p[:, 2], c - 0.2, c + 0.2)
    return Intersect(cap, line, k=0.006)


def _surface_point(direction):
    """Where a ray from the head's centre leaves the cranium."""
    c, r = CRANIUM
    d = normalize(direction)
    t = 1.0 / np.sqrt(np.sum((d / r) ** 2))
    return c + d * t


def _clumps(seed=3):
    """Spiky clumps: swept up and back over the top, back over the sides, down at the nape."""
    rng = np.random.default_rng(seed)
    out = []
    rows = [(1.55, 9, 0.024), (1.25, 11, 0.04), (0.95, 12, 0.052), (0.62, 10, 0.06), (0.32, 6, 0.064), (0.0, 1, 0.06)]
    for polar, count, length in rows:
        for i in range(count):
            az = (i + 0.5 * (polar < 1.0)) / count * 2 * math.pi + rng.uniform(-0.12, 0.12)
            pol = polar + rng.uniform(-0.08, 0.08)
            # Direction from the centre: polar 0 = straight up.
            d = np.array([math.sin(pol) * math.sin(az), -math.sin(pol) * math.cos(az), math.cos(pol)])
            base = _surface_point(d)
            front = -(base[1] - 0.02)
            if base[2] < _hairline(np.array([math.atan2(abs(base[0]), front)]))[0] + 0.004:
                continue
            n = normalize(base - CRANIUM[0])
            # Comb: up and back, more upright toward the front.
            fwd = max(0.0, -d[1])
            comb = normalize(np.array([d[0] * 0.25, 0.85 - 0.5 * fwd, 0.35 + 0.9 * fwd]))
            dirn = normalize(n * (0.55 + 0.25 * fwd) + comb * 0.75 + rng.normal(0, 0.12, 3))
            ln = length * rng.uniform(0.8, 1.15) * (0.65 if pol > 1.35 else 1.0)
            tip = base + dirn * ln
            mid = base + dirn * ln * 0.45 + n * 0.006
            r0 = rng.uniform(0.014, 0.019)
            out.append((base - n * 0.006, mid, tip, r0))
    return out


def hair_shape(clumps=None):
    scalp = _scalp(0.007)
    clumps = clumps or _clumps()
    spikes = []
    for base, mid, tip, r0 in clumps:
        spikes += [RoundCone(base, mid, r0, r0 * 0.55), RoundCone(mid, tip, r0 * 0.55, 0.0018)]
    return Union(scalp, Union(*spikes, k=0.006), k=0.012)


def _clump_axes(clumps, p):
    """Per point: the direction of the nearest clump (strands run along it) and how far along it is (0-1)."""
    pts = p.reshape(-1, 3)
    best = np.full(len(pts), 1e9)
    axis = np.zeros_like(pts)
    along = np.zeros(len(pts))
    for base, _mid, tip, _r in clumps:
        ab = tip - base
        t = np.clip((pts - base) @ ab / (ab @ ab), 0, 1)
        d = np.linalg.norm(pts - (base + t[:, None] * ab), axis=1)
        closer = d < best
        best = np.where(closer, d, best)
        axis[closer] = normalize(ab)
        along = np.where(closer, t, along)
    return axis.reshape(p.shape), along.reshape(p.shape[:-1]), best.reshape(p.shape[:-1])


def paint_hair(clumps):
    def paint(c: Canvas, m):
        p = m["pos"]
        c.tint(0, 1.0)
        c.shade(form_light(m, 1.35))
        axis, along, _ = _clump_axes(clumps, p)
        # Strands: noise stretched along each clump.
        side = np.cross(axis, normalize(np.array([0.3, -0.5, 0.8])))
        u = np.einsum("...i,...i->...", p, side)
        v = np.einsum("...i,...i->...", p, axis)
        strands = noise(np.stack([u * 1.0, v * 0.08, np.zeros_like(u)], -1), 900, seed=13)
        fine = noise(np.stack([u * 1.0, v * 0.1, u * 0.3], -1), 2600, seed=14)
        c.shade(0.78 + 0.32 * strands + 0.12 * (fine - 0.5))
        # Darker at the roots, sun-lifted toward the tips, a band of shine across the top.
        c.shade(0.72 + 0.28 * smoothstep(0.0, 0.7, along))
        sheen = np.exp(-(((p[..., 2] - 1.75) / 0.018) ** 2)) * (0.6 + 0.4 * strands)
        c.shade(1 + 0.25 * sheen)
        return c.done()

    return paint


# -------------------------------------------------------------------- cap

CAP_LINE = (np.array([0.0, -0.08, 1.697]), normalize(np.array([0.0, 0.3, 0.954])))


def _cap_crown():
    c, r = CRANIUM
    dome = Ellipsoid(c + np.array([0, -0.002, 0.008]), r + np.array([0.011, 0.012, 0.01]))
    above = Plane(CAP_LINE[0], -CAP_LINE[1])
    return Intersect(dome, above, k=0.004)


def _brim():
    c = np.array([0.0, -0.128, 1.694])

    def d(p):
        q = p - c
        qz = q[:, 2] + 2.6 * q[:, 0] ** 2 + 0.22 * q[:, 1]
        k0 = np.sqrt((q[:, 0] / 0.084) ** 2 + (np.minimum(q[:, 1], 0) / 0.068) ** 2 + (q[:, 1].clip(0) / 0.04) ** 2)
        flat = (k0 - 1) * 0.06
        return np.maximum(flat, np.abs(qz) - 0.0035)

    return Fn(d, c - np.array([0.1, 0.08, 0.04]), c + np.array([0.1, 0.06, 0.04]))


def cap_shape():
    crown = _cap_crown()
    shell = Subtract(crown, Ellipsoid(CRANIUM[0], CRANIUM[1] + 0.004))
    vent = Ellipsoid((0, 0.128, 1.645), (0.032, 0.03, 0.022))
    shell = Subtract(shell, vent, k=0.004)
    button = Sphere((0, 0.016, 1.79), 0.0075)
    return Union(shell, _brim(), button, k=0.004)


def paint_cap(c: Canvas, m):
    p = m["pos"]
    x, y, z = p[..., 0], p[..., 1], p[..., 2]
    c.tint(0, 1.0)
    c.shade(form_light(m, 1.25))
    c.shade(1 + 0.04 * (noise(p, 1600, seed=21) - 0.5))
    # Six panels sewn from the button: seams with stitching beside them.
    az = np.arctan2(x, -(y - 0.016))
    seam = np.abs(((az / (2 * np.pi / 6)) % 1.0) - 0.5) * (2 * np.pi / 6) * np.hypot(x, y - 0.016)
    crown = z > 1.7
    c.shade(0.72, (seam < 0.0012) * crown)
    c.shade(0.85, (np.abs(seam - 0.0035) < 0.0006) * crown)
    # The brim: second colour underneath, accent piping on the edge; stitched rows on top.
    brim = (y < -0.075) & (z < 1.705) & (z > 1.67)
    under = m["nrm"][..., 2] < -0.2
    c.tint(1, 1.0, brim & under)
    for k in range(4):
        rows = brim & ~under & (np.abs(np.hypot(x / 0.084, (y + 0.128) / 0.068) - (0.55 + 0.12 * k)) < 0.012)
        c.shade(0.8, rows)
    c.tint(2, 1.0, (np.hypot(x / 0.084, (y + 0.128) / 0.068) > 0.95) & brim)
    # Eyelets, the button, the front logo.
    for a in np.arange(6) * (2 * np.pi / 6) + np.pi / 6:
        e = np.array([0.08 * math.sin(a), 0.016 - 0.098 * math.cos(a), 1.752])
        e = HEAD_C + normalize(e - HEAD_C) * 0.115
        c.shade(0.4, (np.linalg.norm(p - e, axis=-1) < 0.003))
    c.tint(1, 1.0, z > 1.784)
    c.tint(2, 1.0, logo.decal(p, "GARBI", centre=(0, -0.1, 1.735), normal=(0, -1, 0.35), width=0.07) * (y < -0.04))
    return c.done()


# ------------------------------------------------------------------ shades

LENS = (np.array([0.0, 0.004, 1.649]), np.array([0.09, 0.106, 0.07]))


def _lens_region(p):
    """Inside the shield's outline (negative): a band across the eyes, deeper at the outer ends."""
    x, z = p[:, 0], p[:, 2]
    ax = np.abs(x)
    top = 1.667 + 0.004 * smoothstep(0.0, 0.05, ax) - 0.012 * smoothstep(0.055, 0.082, ax)
    bottom = 1.631 + 0.004 * smoothstep(0.0, 0.03, ax) + 0.006 * smoothstep(0.05, 0.08, ax)
    nose = 0.012 - 0.02 * np.abs(x) / 0.012
    bottom = np.maximum(bottom, 1.631 + np.clip(nose, 0, None))
    return np.maximum.reduce([z - top, bottom - z, ax - 0.083, p[:, 1] + 0.035])


def shades_shape():
    c, r = LENS
    shield = Intersect(Shell(Ellipsoid(c, r), 0.0016), Fn(_lens_region, c - 0.12, c + 0.12), k=0.002)
    return shield


def frame_shape():
    c, r = LENS
    outline = Fn(lambda p: np.abs(_lens_region(p)) - 0.0028, c - 0.12, c + 0.12)
    rim = Intersect(Shell(Ellipsoid(c, r + 0.0008), 0.0035), outline, k=0.001)
    arms = []
    for s in (1, -1):
        a = np.array([s * 0.08, -0.045, 1.66])
        arms.append(RoundCone(a, np.array([s * 0.083, 0.035, 1.654]), 0.0042, 0.003))
    return Union(rim, *arms, k=0.004)


def paint_lens(c: Canvas, m):
    p = m["pos"]
    z = p[..., 2]
    t = np.clip((z - 1.631) / 0.036, 0, 1)
    # A mirror coat: deep blue at the top through violet to amber at the bottom, with a sky streak.
    top = np.array([0.06, 0.16, 0.42])
    mid = np.array([0.32, 0.12, 0.42])
    low = np.array([0.95, 0.55, 0.12])
    col = np.where(t[..., None] > 0.5, mid + (top - mid) * ((t[..., None] - 0.5) * 2), low + (mid - low) * (t[..., None] * 2))
    streak = np.exp(-(((z - 1.656 + 0.25 * p[..., 0]) / 0.004) ** 2)) * 0.5
    c.colour(np.clip(col + streak[..., None], 0, 1), np.ones_like(z))
    return c.done()


def paint_frame(c: Canvas, m):
    c.tint(0, 1.0)
    c.shade(form_light(m, 1.0))
    p = m["pos"]
    c.tint(2, 1.0, (np.abs(p[..., 0]) > 0.079) * (p[..., 1] > -0.04) * (p[..., 1] < -0.02))
    return c.done()


# ------------------------------------------------------------------ models

def hair_models():
    clumps = _clumps()
    free = hair_shape(clumps)
    under_cap = Subtract(free, Union(_cap_crown(), Plane(CAP_LINE[0] + np.array([0, 0, 0.004]), -CAP_LINE[1])), k=0.003)
    paint = paint_hair(clumps)
    finish = {"roughness": 0.5, "rim": 0.75}
    return Garment(
        "hair.0",
        [
            Piece("free", free, paint, faces=2200, size=512, rigid="head", finish=finish, tints="hair", voxel=0.0018),
            Piece("cap", under_cap, paint, faces=1200, size=512, rigid="head", finish=finish, tints="hair",
                  voxel=0.0018),
        ],
    )


def cap():
    return Garment(
        "summer.head.cap",
        [Piece("cap", cap_shape(), paint_cap, faces=1400, size=512, rigid="head",
               finish={"roughness": 0.7, "rim": 0.55}, voxel=0.0016, extrusion=0.002)],
    )


def shades():
    return Garment(
        "summer.eyes.shades",
        [
            Piece("lens", shades_shape(), paint_lens, faces=500, size=256, rigid="head",
                  finish={"roughness": 0.08, "metalness": 0.4, "rim": 0.3}, voxel=0.0011, extrusion=0.0008),
            Piece("frame", frame_shape(), paint_frame, faces=700, size=256, rigid="head",
                  finish={"roughness": 0.3, "rim": 0.4}, voxel=0.0011, extrusion=0.0012),
        ],
    )


MODELS = {"hair.0": hair_models, "summer.head.cap": cap, "summer.eyes.shades": shades}
