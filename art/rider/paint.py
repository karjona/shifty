"""Painting riders in numpy, from the baked maps (where each texel sits on the body).

Every painter returns two images per part:

- detail: where the mask is set, a tint factor per channel (0.5 keeps the
  tint colour, lower multiplies toward black, higher brightens it, and
  whitens it near 1);
  elsewhere a plain colour (sRGB).
- mask: how much of each tint the texel takes: R main, G second, B accent
  (for skin: R skin, G eyes, B hair).

So one painted texture serves every skin tone and colourway.
"""

import numpy as np


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def _hash(i, j, k, seed):
    h = (i * 374761393 + j * 668265263 + k * 2147483647 + seed * 144269504) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFF) / 65535.0


def noise(p, scale, seed=0):
    """Smooth value noise in 3D, 0-1."""
    q = p * scale
    i = np.floor(q).astype(np.int64)
    f = q - i
    u = f * f * (3 - 2 * f)
    out = 0.0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (u[..., 0] if dx else 1 - u[..., 0]) * (u[..., 1] if dy else 1 - u[..., 1]) * (
                    u[..., 2] if dz else 1 - u[..., 2]
                )
                out = out + w * _hash(i[..., 0] + dx, i[..., 1] + dy, i[..., 2] + dz, seed)
    return out


def fbm(p, scale, octaves=4, seed=0):
    total, amp, norm = 0.0, 1.0, 0.0
    for o in range(octaves):
        total = total + amp * noise(p, scale * 2**o, seed + o)
        norm += amp
        amp *= 0.5
    return total / norm


def blob(p, c, r):
    """1 at `c`, fading to 0 at radii `r` (smooth, compact)."""
    q = (p - np.asarray(c)) / np.asarray(r)
    s = np.clip(1 - np.einsum("...i,...i->...", q, q), 0, 1)
    return s * s


def mix(a, b, t):
    t = np.asarray(t)[..., None] if np.ndim(t) == np.ndim(a) - 1 else t
    return a + (b - a) * t


def srgb(hexcolour):
    return np.array([(hexcolour >> 16) & 255, (hexcolour >> 8) & 255, hexcolour & 255]) / 255.0


class Canvas:
    """A part's detail and mask images, painted in layers."""

    def __init__(self, maps):
        self.m = maps
        h, w = maps["ao"].shape
        self.detail = np.full((h, w, 3), 0.5, np.float32)
        self.mask = np.zeros((h, w, 3), np.float32)

    def tint(self, channel, amount=1.0, where=1.0):
        """Sets how much of tint `channel` (0 main, 1 second, 2 accent) the texels take."""
        w = np.asarray(where, np.float32)[..., None] if np.ndim(where) else where
        target = np.zeros(3, np.float32)
        target[channel] = amount
        self.mask = self.mask + (target - self.mask) * w

    def shade(self, factor, where=1.0):
        """Multiplies the tint factor (below 1 darkens, above lifts): per texel, or per channel."""
        f = np.asarray(factor, np.float32)
        if f.ndim == self.detail.ndim - 1:
            f = f[..., None]
        w = np.asarray(where, np.float32)
        if w.ndim == self.detail.ndim - 1:
            w = w[..., None]
        self.detail = self.detail * (1 + (f - 1) * w)

    def colour(self, rgb, where):
        """Paints a plain colour (no tint) over `where` (0-1)."""
        w = np.asarray(where, np.float32)[..., None]
        self.detail = self.detail + (np.asarray(rgb, np.float32) - self.detail) * w
        self.mask = self.mask * (1 - w)

    def factor(self, rgb, where):
        """Sets the tint factor to `rgb` over `where`, keeping the tint."""
        w = np.asarray(where, np.float32)[..., None]
        self.detail = self.detail + (np.asarray(rgb, np.float32) - self.detail) * w

    def done(self):
        return np.clip(self.detail, 0, 1), np.clip(self.mask, 0, 1)


def form_light(m, strength=1.0, detail_strength=0.9):
    """Painted shading: occlusion, creases, and a soft lift on forms that face up and out.

    `detail_strength` paints in how the detailed surface turns away from the low
    mesh's own normals (folds, grooves); keep it low on smooth curved skin, where
    the difference is mostly the low mesh's facets.
    """
    ao = m["ao"]
    n = m["nrm"]
    base = m["base"]
    curv = m["curv"]
    # Detail the low mesh lost: how much more or less the detailed surface faces a soft key light.
    key = np.array([0.35, -0.55, 0.75])
    key /= np.linalg.norm(key)
    detail = np.einsum("...i,i->...", n, key) - np.einsum("...i,i->...", base, key)
    up = np.clip(n[..., 2], -1, 1)
    c = np.clip((curv - 0.5) * 8, -1, 1)
    f = (0.5 + 0.5 * ao**1.3) * (1 + detail_strength * detail) * (1 + 0.1 * up) * (1 + 0.15 * c)
    return 1 + (f - 1) * strength


def skin(c, m, sk, strength=1.0):
    """Skin over a whole part: occlusion and form, warmer where blood shows, a light mottle."""
    p = m["pos"]
    c.tint(0, 1.0)
    c.shade(form_light(m, strength, detail_strength=0.15))
    mottle = fbm(p, 60, 3, seed=3) - 0.5
    c.shade(1 + 0.05 * mottle)
    warm = np.zeros(p.shape[:2])
    for spot in sk.warm_spots():
        warm = np.maximum(warm, blob(p, *spot))
    # Warmth: more red, a touch less blue.
    c.shade(np.stack([1 + 0.08 * warm, 1 - 0.03 * warm, 1 - 0.07 * warm], -1))
    return warm


def body(maps, sk):
    out = {}
    m = maps["skin"]
    c = Canvas(m)
    skin(c, m, sk)
    for nail in sk.nails():
        c.factor((0.62, 0.53, 0.5), blob(m["pos"], *nail) ** 0.4 * 0.8)
    out["skin"] = c.done()
    m = maps["face"]
    c = Canvas(m)
    skin(c, m, sk, strength=0.75)
    sk.paint_face(c, m)
    out["face"] = c.done()
    return out
