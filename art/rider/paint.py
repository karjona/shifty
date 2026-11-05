"""Helpers for painting riders in numpy from the baked maps (where each texel sits on the body).

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
