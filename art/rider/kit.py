"""The summer kit, sculpted around the male body: what each catalog model looks like.

Each garment gives its shape (a distance field), how to paint it, and how it
is built (triangles, texture size, a rigid bone if it doesn't bend, its finish).
Colourways tint it at runtime: main, second and accent (see paint.py).
"""

import numpy as np

import logo
import male
from paint import Canvas, blob, fbm, form_light, noise, smoothstep
from sdf import (
    Bump,
    Capsule,
    Displace,
    Ellipsoid,
    Fn,
    Intersect,
    Plane,
    Profile,
    RoundBox,
    Subtract,
    Union,
    rot,
)


class Garment:
    """A catalog model: its pieces (meshes) and the body regions it covers."""

    def __init__(self, model, pieces, hides=()):
        self.model = model
        self.pieces = pieces
        self.hides = hides


class Piece:
    def __init__(self, name, shape, paint, faces, size=1024, rigid=None, finish=None, tints="kit", voxel=0.003,
                 extrusion=0.006):
        self.name = name
        self.shape = shape
        self.paint = paint
        self.faces = faces
        self.size = size
        self.rigid = rigid
        self.finish = finish or {"roughness": 0.7, "rim": 0.5}
        self.tints = tints
        self.voxel = voxel
        # How far bake rays start off the low mesh: less than the thinnest wall.
        self.extrusion = extrusion


# ---------------------------------------------------------------- foam vest

VEST_HEM = 1.03
VEST_PADS = (1.165, 1.27, 1.37)
VEST_STRAPS = (1.11, 1.215)
VEST_SIDE = 0.128


def _vest_profile():
    keys = [
        (0.99, 0.172, 0.118, 0.114, 0.0),
        (1.1, 0.174, 0.12, 0.116, 0.0),
        (1.2, 0.178, 0.124, 0.12, 0.0),
        (1.3, 0.184, 0.128, 0.124, 0.0),
        (1.38, 0.182, 0.12, 0.122, -0.004),
        (1.44, 0.165, 0.1, 0.112, -0.014),
        (1.5, 0.115, 0.074, 0.092, -0.02),
        (1.54, 0.08, 0.06, 0.075, -0.02),
    ]
    z0, z1 = keys[0][0], keys[-1][0]
    lk = [((z - z0) / (z1 - z0), w, f, b, c) for z, w, f, b, c in keys]
    return Profile((0, 0, z0), (0, 0, z1), lk, n=(3.0, 2.8), cap=(0.02, 0.03))


def _vest_cuts():
    """The openings, as shapes to remove: armholes, neck, below the hem."""
    arms = [Ellipsoid((s * 0.215, 0.012, 1.355), (0.085, 0.1, 0.122)) for s in (1, -1)]
    neck = Ellipsoid((0, -0.035, 1.53), (0.076, 0.092, 0.085))
    hem = Plane((0, 0, VEST_HEM), (0, 0, -1))
    return arms, neck, hem


def _grooves(p):
    """How far the foam dips between its pads and panels (m)."""
    x, y, z = p[:, 0], p[:, 1], p[:, 2]
    ax = np.abs(x)
    d = np.zeros(len(p))
    for zp in VEST_PADS:
        d += 0.006 * np.exp(-(((z - zp) / 0.0055) ** 2)) * (ax < VEST_SIDE)
    d += 0.006 * np.exp(-(((ax - VEST_SIDE) / 0.006) ** 2)) * (z < 1.43)
    d += 0.005 * np.exp(-((x / 0.005) ** 2)) * (y < -0.05)
    return d


def _straps(p):
    """The straps across the front stand proud of the foam (m)."""
    x, y, z = p[:, 0], p[:, 1], p[:, 2]
    d = np.zeros(len(p))
    for zs in VEST_STRAPS:
        d += 0.004 * (1 - smoothstep(0.011, 0.014, np.abs(z - zs))) * (y < -0.02)
    return d


def vest_shape():
    base = _vest_profile()
    shaped = Fn(lambda p: base.eval(p) + _grooves(p) - _straps(p), *base.bounds())
    arms, neck, hem = _vest_cuts()
    vest = Subtract(shaped, Union(*arms, neck), k=0.012)
    vest = Intersect(vest, hem, k=0.006)
    # Buckles on the straps, at the front.
    buckles = []
    for zs in VEST_STRAPS:
        y = -_front(base, zs) - 0.006
        buckles.append(RoundBox((0, y, zs), (0.026, 0.004, 0.012), 0.003))
    collar = _collar()
    return Union(vest, collar, *buckles, k=0.004)


def _front(shape, z):
    """How far forward the shape's surface is at height z, on the centre line."""
    ys = -np.linspace(0, 0.2, 401)
    p = np.stack([np.zeros_like(ys), ys, np.full_like(ys, z)], 1)
    inside = shape.eval(p) < 0
    return float(-ys[np.nonzero(inside)[0].max()])


def _collar():
    """A padded roll around the back and sides of the neck."""
    ring = Fn(
        lambda p: np.sqrt(
            (np.sqrt(p[:, 0] ** 2 + ((p[:, 1] - 0.022) * 1.05) ** 2) - 0.082) ** 2 + ((p[:, 2] - 1.49) / 1.3) ** 2
        )
        - 0.02,
        (-0.13, -0.09, 1.44),
        (0.13, 0.14, 1.54),
    )
    return Intersect(ring, Plane((0, -0.035, 0), (0, -1, 0)), k=0.01)


def paint_vest(c: Canvas, m):
    p = m["pos"]
    x, y, z = p[..., 0], p[..., 1], p[..., 2]
    ax = np.abs(x)
    c.tint(0, 1.0)
    c.shade(form_light(m, 1.1))
    # Nylon over foam: a fine weave, and a soft sheen along the top of each pad.
    weave = noise(p * np.array([1, 1, 0.35]), 900, seed=2) - 0.5
    c.shade(1 + 0.035 * weave)
    pads = (1.02,) + VEST_PADS + (1.47,)
    for z0, z1 in zip(pads[:-1], pads[1:]):
        mid = (z0 + z1) / 2
        crown = np.exp(-(((z - (mid + (z1 - z0) * 0.18)) / ((z1 - z0) * 0.22)) ** 2)) * (ax < VEST_SIDE)
        under = np.exp(-(((z - (z0 + (z1 - z0) * 0.12)) / ((z1 - z0) * 0.14)) ** 2)) * (ax < VEST_SIDE)
        c.shade(1.0 + 0.22 * crown - 0.2 * under)
    # Side panels, the shoulder straps and the collar: the second colour.
    side = smoothstep(VEST_SIDE - 0.003, VEST_SIDE + 0.003, ax) * (z < 1.44)
    shoulder = smoothstep(1.42, 1.44, z) * (ax > 0.05)
    collar = smoothstep(1.47, 1.49, z) * (y > -0.04)
    second = np.clip(side + shoulder + collar, 0, 1)
    c.tint(1, 1.0, second)
    mesh = (np.sin(x * 900) * np.sin(z * 900) > 0.2) * side
    c.shade(0.86, mesh * 0.6)
    # Straps (second) with their stitching, and plastic buckles.
    for zs in VEST_STRAPS:
        strap = (1 - smoothstep(0.0105, 0.0125, np.abs(z - zs))) * (y < -0.02) * (ax < VEST_SIDE + 0.01)
        c.tint(1, 1.0, strap)
        c.shade(0.75, strap * (1 - smoothstep(0.0075, 0.009, np.abs(z - zs))) * (np.abs(np.abs(z - zs) - 0.0085) < 0.0008))
        buckle = (ax < 0.03) * (np.abs(z - zs) < 0.016) * (y < -0.11)
        c.colour((0.16, 0.17, 0.19), buckle)
        c.shade(1.4, buckle * (np.abs(z - zs) > 0.011) * 0.6)
    # Accent piping along every edge and down the zip.
    arms, neck, hem = _vest_cuts()
    pts = p.reshape(-1, 3)
    edge = np.full(len(pts), 1.0)
    for cut in [*arms, neck]:
        edge = np.minimum(edge, np.abs(cut.eval(pts)))
    edge = np.minimum(edge, np.abs(pts[:, 2] - VEST_HEM))
    edge = edge.reshape(z.shape)
    piping = 1 - smoothstep(0.004, 0.0065, edge)
    zip_line = (1 - smoothstep(0.0025, 0.004, ax)) * (y < -0.05) * (z < 1.45)
    seam = (1 - smoothstep(0.0015, 0.0028, np.abs(ax - VEST_SIDE))) * (z < 1.43)
    c.tint(2, 1.0, np.clip(piping + seam, 0, 1))
    c.colour((0.12, 0.12, 0.13), zip_line)
    c.shade(1.5, zip_line * (np.sin(z * 2400) > 0.3) * 0.5)
    # Stitching just inside the piping.
    stitch = (np.abs(edge - 0.0095) < 0.0007) * (np.sin((x + z) * 1800) > 0)
    c.shade(0.7, stitch * 0.8)
    # The brand: a wordmark on the left chest and big across the back.
    chest = logo.decal(p, "GARBI", centre=(0.075, -0.13, 1.315), normal=(0, -1, 0), width=0.085, up=(0, 0, 1))
    back = logo.decal(p, "GARBI", centre=(0, 0.13, 1.315), normal=(0, 1, 0), width=0.2, up=(0, 0, 1))
    belly = logo.decal(p, "GARBI", centre=(-0.062, -0.13, 1.07), normal=(0, -1, 0), width=0.1, up=(0, 0, 1))
    mark = np.clip(chest * (y < -0.05) + back * (y > 0.05) + belly * (y < -0.05), 0, 1)
    # A racing band across the top pad, front and back.
    band = (np.abs(z - 1.405) < 0.011) * (ax < VEST_SIDE) * (np.abs(y) > 0.05)
    c.tint(2, 1.0, band)
    c.tint(1, 1.0, (np.abs(np.abs(z - 1.405) - 0.013) < 0.0022) * (ax < VEST_SIDE) * (np.abs(y) > 0.05))
    c.tint(2, 1.0, mark)
    c.factor((0.52, 0.52, 0.52), mark)
    return c.done()


def vest():
    return Garment(
        "summer.vest.foam",
        [Piece("vest", vest_shape(), paint_vest, faces=2600, finish={"roughness": 0.42, "rim": 0.6})],
        hides=(),
    )


# ------------------------------------------------------------ boardshorts

SHORTS_TOP = 1.035
SHORTS_HEM = 0.535


def _shorts_solid():
    hips = Profile(
        (0, 0, 0.84),
        (0, 0, SHORTS_TOP + 0.01),
        [(0.0, 0.11, 0.08, 0.08, 0.0), (0.3, 0.165, 0.105, 0.118, 0.0), (0.65, 0.168, 0.106, 0.116, 0.0),
         (1.0, 0.162, 0.104, 0.108, 0.0)],
        n=(2.4, 2.4),
        cap=(0.04, 0.01),
    )
    legs = []
    for s in (1, -1):
        L = "L" if s > 0 else "R"
        hp = male.J[f"thigh.{L}"]
        top = hp + np.array([s * 0.012, -0.002, 0.0])
        hem = np.array([s * 0.108, -0.01, SHORTS_HEM - 0.03])
        legs.append(Profile(top, hem, [(0, 0.108, 0.11, 0.104), (0.5, 0.1, 0.106, 0.098), (1.0, 0.093, 0.096, 0.09)],
                            side=(1, 0, 0), front=(0, -1, 0), n=(2.1, 2.1), cap=(0.01, 0.01)))
    return Union(hips, Union(*legs, k=0.02), k=0.04)


def _folds(p):
    """Creases in loose cloth: soft vertical folds toward the hem, a few pulled across the front of the hips."""
    x, y, z = p[:, 0], p[:, 1], p[:, 2]
    ang = np.arctan2(y, np.abs(x) - 0.1)
    hang = smoothstep(0.85, 0.6, z)
    n1 = fbm(p * np.array([1, 1, 0.25]), 14, 2, seed=7)
    vertical = np.sin(ang * 9 + n1 * 6) * 0.0035 * hang
    pull = np.sin((z + np.abs(x) * 0.7) * 140 + n1 * 3) * 0.0018 * smoothstep(0.84, 0.95, z) * (y < -0.04)
    return vertical + pull


def shorts_shape():
    solid = _shorts_solid()
    folded = Fn(lambda p: solid.eval(p) - _folds(p), *solid.bounds())
    hollow = Subtract(folded, Fn(lambda p: solid.eval(p) + 0.007, *solid.bounds()))
    cut = Plane((0, 0, SHORTS_HEM), (0, 0, -1))
    top = Plane((0, 0, SHORTS_TOP), (0, 0, 1))
    shorts = Intersect(Intersect(hollow, cut, k=0.002), top, k=0.002)
    # The waistband stands a little proud.
    band = Fn(lambda p: solid.eval(p) - 0.004, *solid.bounds())
    band = Intersect(Intersect(band, Plane((0, 0, SHORTS_TOP - 0.038), (0, 0, -1))), top, k=0.003)
    band = Subtract(band, Fn(lambda p: solid.eval(p) + 0.006, *solid.bounds()))
    cords = []
    for s in (1, -1):
        a = np.array([s * 0.012, -_front(solid, SHORTS_TOP - 0.02) - 0.005, SHORTS_TOP - 0.022])
        cords.append(Capsule(a, a + np.array([s * 0.008, -0.004, -0.075]), 0.0028))
    return Union(shorts, band, *cords, k=0.003)


def _flames(theta, h):
    """Hot-rod flames licking up from the hem around the outer leg: (inside the flames, inside the outline).

    `theta` runs around the leg (0 = straight out), `h` is the height above the hem.
    """
    tongues = [(-1.3, 0.09, 0.34), (-0.75, 0.16, 0.4), (-0.1, 0.2, 0.42), (0.5, 0.15, 0.38), (1.05, 0.11, 0.34),
               (1.55, 0.06, 0.28)]
    body = np.zeros_like(h, dtype=bool)
    outline = np.zeros_like(h, dtype=bool)
    for centre, height, width in tongues:
        # Each tongue leans back as it rises and tapers to a point.
        u = (theta - centre - 1.6 * h) / width
        reach = height * np.clip(1 - np.abs(u), 0, 1) ** 1.7
        body |= (h < reach) & (np.abs(u) < 1)
        outline |= (h < reach + 0.007) & (np.abs(u) < 1.12)
    base = h < 0.018
    return body | base, outline | (h < 0.025)


def paint_shorts(c: Canvas, m):
    p = m["pos"]
    x, y, z = p[..., 0], p[..., 1], p[..., 2]
    ax = np.abs(x)
    c.tint(0, 1.0)
    c.shade(form_light(m, 1.25))
    twill = noise(p * np.array([1, 1, 1]), 1500, seed=4) - 0.5
    c.shade(1 + 0.03 * twill)
    # Waistband and drawstrings.
    band = smoothstep(SHORTS_TOP - 0.04, SHORTS_TOP - 0.036, z)
    c.tint(1, 1.0, band)
    c.shade(0.8, band * (np.abs(z - (SHORTS_TOP - 0.03)) < 0.0012) * (np.sin(ax * 2500) > 0))
    cord = (ax < 0.03) * (y < -0.09) * (z < SHORTS_TOP - 0.018) * (z > SHORTS_TOP - 0.1) * (1 - band) * 0
    eyelet = np.zeros_like(z)
    for s in (1, -1):
        eyelet = np.maximum(eyelet, blob(p, (s * 0.012, -0.11, SHORTS_TOP - 0.022), (0.004, 0.03, 0.004)))
    c.colour((0.75, 0.75, 0.76), np.clip(eyelet * 3, 0, 1))
    cords = (ax < 0.024) * (z < SHORTS_TOP - 0.02) * (y < -0.1) * (z > SHORTS_TOP - 0.11)
    cords = cords * (np.abs(m["nrm"][..., 1]) < 2)
    near_cord = np.zeros_like(z, dtype=bool)
    for s in (1, -1):
        a = np.array([s * 0.012, -0.112, SHORTS_TOP - 0.022])
        b = a + np.array([s * 0.008, -0.004, -0.075])
        ab = b - a
        t = np.clip(((p - a) @ ab) / (ab @ ab), 0, 1)
        dist = np.linalg.norm(p - (a + t[..., None] * ab), axis=-1)
        near_cord |= dist < 0.0045
    c.tint(2, 1.0, near_cord)
    # Side panels down the outer leg in the second colour, with accent flames licking up from the hem.
    side = smoothstep(0.117, 0.123, ax + 0.03 * (z - 0.8)) * (z < SHORTS_TOP - 0.04)
    c.tint(1, 1.0, side)
    edge = (1 - smoothstep(0.0, 0.0035, np.abs(ax + 0.03 * (z - 0.8) - 0.12))) * (z < SHORTS_TOP - 0.04)
    pin = (1 - smoothstep(0.0, 0.0018, np.abs(ax + 0.03 * (z - 0.8) - 0.129))) * (z < SHORTS_TOP - 0.04)
    c.tint(2, 1.0, np.clip(edge + pin, 0, 1))
    cx = np.where(x > 0, 0.1, -0.1)
    theta = np.arctan2(y, x - cx)
    h = z - SHORTS_HEM
    out = np.where(x > 0, theta, np.pi - theta)
    out = (out + np.pi) % (2 * np.pi) - np.pi
    inside, outline = _flames(out, h)
    c.tint(2, 1.0, outline & ~inside)
    c.tint(1, 1.0, inside)
    c.shade(1.12, inside & (h < 0.05))
    hemline = (1 - smoothstep(0.004, 0.007, h))
    c.tint(1, 1.0, hemline)
    c.shade(0.75, (np.abs(h - 0.009) < 0.0009) * 1.0)
    # Seams: inside leg and the fly.
    fly = (1 - smoothstep(0.001, 0.0025, np.abs(x - 0.012 * smoothstep(0.92, 0.98, z)))) * (y < -0.05) * (z > 0.86)
    c.shade(0.7, fly * (z < SHORTS_TOP - 0.04))
    # A shadow inside the hem.
    c.shade(0.55, smoothstep(0.0, 0.03, -(m["nrm"][..., 2])) * (h < 0.02) * 0)
    c.tint(2, 1.0, logo.decal(p, "GARBI", centre=(0.15, -0.075, 0.6), normal=(0.6, -0.8, 0), width=0.07,
                               up=(0, 0, 1)) * (x > 0))
    return c.done()


def shorts():
    return Garment(
        "summer.bottom.boardshorts",
        [Piece("shorts", shorts_shape(), paint_shorts, faces=2400, finish={"roughness": 0.65, "rim": 0.5},
               voxel=0.0024)],
        hides=("hips", "thighs"),
    )


# ------------------------------------------------------------ water shoes


def _shoe(s):
    L = "L" if s > 0 else "R"
    an = male.J[f"foot.{L}"]
    x0 = an[0]
    sole = Profile(
        (x0, 0.076, 0.015),
        (x0 + s * 0.013, -0.214, 0.018),
        [(0.0, 0.05, 0.017, 0.017), (0.3, 0.056, 0.017, 0.017), (0.62, 0.064, 0.017, 0.017),
         (0.86, 0.063, 0.017, 0.017), (1.0, 0.05, 0.015, 0.015)],
        side=(1, 0, 0), front=(0, 0, 1), n=(4.0, 4.0), cap=(0.022, 0.03),
    )
    upper = Profile(
        (x0, 0.064, 0.032),
        (x0 + s * 0.013, -0.204, 0.03),
        [(0.0, 0.047, 0.088, 0.02), (0.2, 0.053, 0.092, 0.02), (0.45, 0.058, 0.074, 0.02), (0.7, 0.061, 0.054, 0.02),
         (0.9, 0.057, 0.04, 0.02), (1.0, 0.044, 0.029, 0.018)],
        side=(1, 0, 0), front=(0, 0, 1), n=(2.4, 3.0), cap=(0.02, 0.024),
    )
    ankle = np.array([x0, 0.022, 0.105])
    collar = Fn(
        lambda p: np.sqrt((np.sqrt((p[:, 0] - ankle[0]) ** 2 + ((p[:, 1] - ankle[1]) * 0.85) ** 2) - 0.042) ** 2
                          + ((p[:, 2] - ankle[2]) * 1.2) ** 2) - 0.011,
        ankle - 0.07, ankle + 0.07,
    )
    opening = Capsule(ankle + np.array([0, 0, -0.01]), ankle + np.array([0, -0.01, 0.2]), 0.036)
    straps = [Bump((x0 + s * 0.004, -0.04 - 0.045 * i, 0.075 - 0.012 * i), (0.06, 0.016, 0.06), 0.004)
              for i in range(2)]
    toe = Ellipsoid((x0 + s * 0.012, -0.175, 0.03), (0.045, 0.035, 0.024))
    heel = RoundBox((x0, 0.083, 0.085), (0.012, 0.006, 0.022), 0.004)
    shoe = Union(Displace(upper, *straps), collar, toe, k=0.01)
    shoe = Subtract(shoe, opening, k=0.006)
    return Union(shoe, sole, heel, k=0.006)


def shoes_shape():
    return Union(_shoe(1), _shoe(-1))


def paint_shoes(c: Canvas, m):
    p = m["pos"]
    x, y, z = p[..., 0], p[..., 1], p[..., 2]
    ax = np.abs(x)
    lx = ax - 0.1
    c.tint(0, 1.0)
    c.shade(form_light(m, 1.2))
    # A breathable mesh over the upper.
    cells = (np.sin(y * 1300 + z * 300) * np.sin(z * 1300 - y * 300)) > 0.35
    c.shade(0.82, cells * (z > 0.03))
    # The sole: a pale side wall with an accent stripe, dark rubber underneath.
    wall = 1 - smoothstep(0.03, 0.034, z)
    c.colour((0.9, 0.89, 0.86), wall)
    c.shade(form_light(m, 0.8), wall)
    c.tint(2, 1.0, (np.abs(z - 0.019) < 0.004) * wall)
    c.colour((0.13, 0.13, 0.14), 1 - smoothstep(0.003, 0.006, z))
    # Toe cap, straps, collar: the second colour; the heel tab in the accent.
    toe = (y < -0.15) * (z < 0.055) * (z > 0.026)
    c.tint(1, 1.0, toe)
    for i in range(2):
        cy, cz = -0.04 - 0.045 * i, 0.075 - 0.012 * i
        strap = (np.abs((y - cy) + (z - cz) * 0.25) < 0.013) * (z > 0.04)
        c.tint(1, 1.0, strap)
        c.shade(0.7, strap * (np.abs(np.abs((y - cy) + (z - cz) * 0.25) - 0.0105) < 0.0008))
    collar = smoothstep(0.088, 0.094, z) * (y > -0.04)
    c.tint(1, 1.0, collar)
    c.tint(2, 1.0, (y > 0.072) * (z > 0.06))
    for s in (1, -1):
        mark = logo.decal(p, "LLEVANT", centre=(s * 0.152, -0.05, 0.045), normal=(s, 0, 0), width=0.06,
                          up=(0, 0, 1), depth=0.03)
        c.tint(2, 1.0, mark * (x * s > 0))
    return c.done()


def shoes():
    return Garment(
        "summer.feet.watershoes",
        [Piece("shoes", shoes_shape(), paint_shoes, faces=1800, size=512, finish={"roughness": 0.6, "rim": 0.4},
               voxel=0.002)],
        hides=("feet",),
    )


GARMENTS = {
    "summer.vest.foam": vest,
    "summer.bottom.boardshorts": shorts,
    "summer.feet.watershoes": shoes,
}
