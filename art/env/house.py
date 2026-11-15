"""The clubhouse: two white storeys under a terracotta roof, a loggia of five arches between the pro shop's window
and the bar's hatch, shuttered windows and balconies above. Built facing +z with its front wall on z = 0 and its
middle on x = 0, standing on y = 0. Also the pergola beside it."""

import math

import numpy as np

import kit
import props as P
from kit import RX, RY, RZ, S, T, TAU, ball, blob, box, extrude, lathe, quad, rod, slab, taper, tube, wall

HALF = 13.0
ARCADE = 7.5
GROUND = 4.0
EAVE = GROUND + 3.3
DEPTH = 9.5
BAY = 3.0
ARCH_HALF = 1.15
SPRING = 2.3
GALLERY = 3.0

SHUTTER = 0x2F7D6B
SHUTTER_LIGHT = 0x3F937F
DOOR = 0x1F5C6B
GLASS = 0x9DB9C6
TILE_BLUE = 0x2B62A8
GERANIUM = 0xD9342B
BOTTLES = [0x3F7F4A, 0x9A5A2A, 0xE9E2C8, 0x2B62A8, 0xC24A1C, 0x6B2A3A]


def arcade_outline(x0, x1, top, arches, steps=8):
    """A wall's outline, (x, y), from x0 to x1 and the ground to `top`, with arched openings cut up from the
    ground: `arches` are (centre, half width, spring height)."""
    pts = [(x0, 0.0)]
    for cx, hw, spring in arches:
        pts.append((cx - hw, 0.0))
        pts += [(cx + hw * math.cos(math.pi - math.pi * i / steps), spring + hw * math.sin(math.pi * i / steps)) for i in range(steps + 1)]
        pts.append((cx + hw, 0.0))
    return pts + [(x1, 0.0), (x1, top), (x0, top)]


def archivolt(hw, spring, band=0.21, steps=8, foot=0.0):
    """The band of stone round an arch (from `foot` up the jambs and over the head), as an outline."""
    outer = [(-(hw + band), foot)] + [((hw + band) * math.cos(math.pi - math.pi * i / steps), spring + (hw + band) * math.sin(math.pi * i / steps)) for i in range(steps + 1)] + [(hw + band, foot)]
    inner = [(hw, foot)] + [(hw * math.cos(math.pi * i / steps), spring + hw * math.sin(math.pi * i / steps)) for i in range(steps + 1)] + [(-hw, foot)]
    return outer + inner


def window(w=1.1, h=1.8, arched=False):
    """A window to set in an opening `w` by `h`, centred on its middle in the wall's face (z = 0): glass set back,
    a white frame with glazing bars, a stone sill."""
    z = -0.16
    parts = [quad((-w / 2, -h / 2, z), (w / 2, -h / 2, z), (w / 2, h / 2, z), (-w / 2, h / 2, z), GLASS, "glass")]
    f = 0.07
    for x in (-w / 2 + f / 2, w / 2 - f / 2, 0):
        parts.append(box(f if x else 0.045, h, 0.06, P.WHITE).at(x, -h / 2, z + 0.03))
    for y in (-h / 2, h / 2 - f, -0.02):
        parts.append(box(w, f if y != -0.02 else 0.04, 0.06, P.WHITE).at(0, y, z + 0.035))
    parts.append(box(w + 0.24, 0.07, 0.2, P.STONE_LIGHT).at(0, -h / 2 - 0.07, -0.02))
    return parts


def shutter(h=1.8, w=0.56, colour=SHUTTER, light=SHUTTER_LIGHT):
    """A louvred shutter folded back against the wall, its hinge edge on x = 0, reaching toward +x."""
    parts = [box(w, h, 0.035, colour).at(w / 2, -h / 2, 0.02)]
    slats = 9
    for i in range(slats):
        y = -h / 2 + 0.1 + (h - 0.2) * (i + 0.5) / slats
        parts.append(box(w - 0.12, (h - 0.2) / slats * 0.55, 0.02, light).at(w / 2, y - 0.03, 0.045).xf(T(0, 0, 0)))
    for y in (-h / 2, h / 2 - 0.06, -0.03):
        parts.append(box(w, 0.06, 0.05, colour).at(w / 2, y, 0.025))
    return parts


def balcony(w=1.9, d=0.55):
    """A small balcony: a stone slab on two brackets with a wrought-iron rail. Its floor's back edge is on z = 0."""
    parts = [box(w, 0.1, d, P.STONE_LIGHT).at(0, -0.1, d / 2), box(w + 0.06, 0.04, d + 0.03, P.STONE).at(0, -0.14, d / 2)]
    for x in (-w / 2 + 0.25, w / 2 - 0.25):
        parts.append(taper(0.14, d * 0.9, 0.14, 0.12, 0.34, P.STONE).xf(T(x, -0.14, d * 0.45) @ RX(math.pi)).at(0, 0, 0))
    rail = [(-w / 2 + 0.03, 0), (-w / 2 + 0.03, d - 0.03), (w / 2 - 0.03, d - 0.03), (w / 2 - 0.03, 0)]
    for y in (0.08, 0.92):
        for (x0, z0), (x1, z1) in zip(rail[:-1], rail[1:]):
            parts.append(rod((x0, y, z0), (x1, y, z1), 0.018, 4, P.IRON))
    n = 9
    for i in range(n + 1):
        x = -w / 2 + 0.03 + (w - 0.06) * i / n
        parts.append(rod((x, 0.0, d - 0.03), (x, 0.92, d - 0.03), 0.012, 3, P.IRON))
        # Every other bar swells into a belly, as wrought iron does.
        if i % 2:
            parts.append(lathe([(0.0, 0.3), (0.04, 0.42), (0.0, 0.56)], 4, P.IRON).at(x, 0, d - 0.03))
    for z in (0.18, 0.38):
        for x in (-w / 2 + 0.03, w / 2 - 0.03):
            parts.append(rod((x, 0.0, z), (x, 0.92, z), 0.012, 3, P.IRON))
    return parts


def flower_box(sc, w=1.2, colour=GERANIUM, seed=0):
    """A terracotta trough of geraniums in flower."""
    rng = np.random.default_rng(seed)
    parts = [taper(w * 0.94, 0.2, w, 0.26, 0.2, P.TERRACOTTA).at(0, 0, 0.13)]
    n = max(3, round(w / 0.22))
    for i in range(n):
        x = -w / 2 + w * (i + 0.5) / n
        parts.append(P.clumps(sc, (x, 0.25, 0.13), 0.15 + rng.uniform(0, 0.04), P.LEAF if i % 3 else P.LEAF_DARK, seed * 10 + i, 0.7, 1))
        if rng.uniform() < 0.8:
            at = (x + rng.uniform(-0.05, 0.05), 0.34 + rng.uniform(0, 0.05), 0.15 + rng.uniform(-0.03, 0.07))
            parts.append(P.clumps(sc, at, 0.085, colour, seed * 10 + i + 50, 0.8, 1))
    return parts


def wall_lamp():
    """A lantern on an iron bracket, to hang on a wall (its back on z = 0)."""
    parts = [
        box(0.1, 0.28, 0.025, P.IRON).at(0, -0.14, 0.012),
        tube([(0, 0.05, 0.02), (0, 0.16, 0.2), (0, 0.1, 0.32)], 0.014, 4, P.IRON),
        taper(0.12, 0.12, 0.2, 0.2, 0.26, P.GLOW).at(0, -0.22, 0.32),
        taper(0.25, 0.25, 0.04, 0.04, 0.1, P.IRON).at(0, 0.04, 0.32),
        box(0.14, 0.02, 0.14, P.IRON).at(0, -0.24, 0.32),
    ]
    for sx in (-1, 1):
        for sz in (-1, 1):
            parts.append(rod((sx * 0.06, -0.22, 0.32 + sz * 0.06), (sx * 0.1, 0.04, 0.32 + sz * 0.1), 0.01, 3, P.IRON))
    return parts


def awning(width, reach, drop, colours, scallop=0.18, valance=0.24):
    """A striped canvas awning sloping out from a wall (its top edge on z = 0 at y = 0), with a scalloped valance
    that moves in the breeze, on iron arms."""
    stripes = max(4, round(width / 0.42))
    parts = []
    for i in range(stripes):
        x0 = -width / 2 + width * i / stripes
        x1 = x0 + width / stripes
        c = colours[i % len(colours)]
        parts.append(quad((x0, -drop, reach), (x1, -drop, reach), (x1, 0, 0), (x0, 0, 0), c, "cloth"))
        # The valance: a flap with a rounded tongue.
        xm = (x0 + x1) / 2
        y0 = -drop
        flap = kit.Mesh(
            [(x0, y0, reach), (x1, y0, reach), (x1, y0 - valance + scallop * 0.5, reach), (xm, y0 - valance, reach), (x0, y0 - valance + scallop * 0.5, reach)],
            [(0, 4, 3), (0, 3, 1), (1, 3, 2)],
            c,
            "cloth",
        )
        flap.W = np.array([0, 0, 0.5, 0.7, 0.5], dtype=np.float32)
        parts.append(flap)
    for x in (-width / 2 + 0.04, width / 2 - 0.04):
        parts.append(rod((x, -drop - 0.02, reach - 0.02), (x, -drop - 0.5, 0.02), 0.016, 4, P.IRON))
        parts.append(rod((x, -drop - 0.02, reach - 0.02), (x, -0.02, 0.02), 0.014, 4, P.IRON))
    parts.append(rod((-width / 2, -drop - 0.01, reach - 0.01), (width / 2, -drop - 0.01, reach - 0.01), 0.018, 4, P.IRON))
    return parts


def hip_roof(half_x, half_z, eave_y, ridge_y, courses=10, colours=(P.ROOF, 0xBE5E38)):
    """A hipped roof of tile courses over a rectangle centred on the origin: each course steps out over the one
    below, with round caps along the ridge and the hips."""
    ridge_half = half_x - half_z
    rise = ridge_y - eave_y
    parts = []

    def edge(f, lift):
        """The roof's outline at fraction `f` up the slope (0 the eave, 1 the ridge), lifted off the slope."""
        hx = half_x - half_z * f
        hz = half_z * (1 - f)
        y = eave_y + rise * f + lift
        return [(-hx, y, hz), (hx, y, hz), (hx, y, -hz), (-hx, y, -hz)]

    step = 0.07
    for k in range(courses):
        lower = edge(k / courses, step)
        upper = edge((k + 1) / courses, 0.0)
        under = edge(k / courses, 0.0)
        c = colours[k % 2]
        for i in range(4):
            j = (i + 1) % 4
            parts.append(quad(lower[i], lower[j], upper[j], upper[i], c))
            parts.append(quad(under[i], under[j], lower[j], lower[i], kit.shade(c, 0.8)))
    # Soffit under the eaves.
    e = edge(0, 0)
    parts.append(quad(e[3], e[2], e[1], e[0], P.STONE_DARK))
    cap = 0xD27A4C
    parts.append(tube([(-ridge_half - 0.1, ridge_y + 0.06, 0), (ridge_half + 0.1, ridge_y + 0.06, 0)], 0.13, 6, cap))
    for sx in (-1, 1):
        for sz in (-1, 1):
            parts.append(tube([(sx * ridge_half, ridge_y + 0.05, 0), (sx * half_x, eave_y + 0.1, sz * half_z)], 0.11, 6, cap))
    return [m.clean() for m in parts]


def door(w=1.7, h=2.5, colour=DOOR):
    """Glazed double doors in an opening `w` by `h`, standing on y = 0, set back from the wall's face."""
    z = -0.14
    parts = [quad((-w / 2, 0.25, z), (w / 2, 0.25, z), (w / 2, h, z), (-w / 2, h, z), GLASS, "glass")]
    parts.append(box(w, 0.28, 0.06, colour).at(0, 0, z + 0.02))
    for x in (-w / 2 + 0.05, -0.05, 0.05, w / 2 - 0.05):
        parts.append(box(0.1, h, 0.07, colour).at(x, 0, z + 0.025))
    for y in (h - 0.1, h * 0.55):
        parts.append(box(w, 0.08 if y > h * 0.6 else 0.05, 0.07, colour).at(0, y, z + 0.025))
    for x in (-0.14, 0.14):
        parts.append(box(0.03, 0.3, 0.05, P.BRASS).at(x, 1.0, z + 0.07))
    return parts


def clubhouse():
    """The clubhouse (in its own frame: see the module's notes): its parts, the props it places as (name, matrix)
    pairs, and its signs as (text, matrix, width, height, style, ink, paper)."""
    parts, placed, signs = [], [], []
    arches = [(BAY * k, ARCH_HALF, SPRING) for k in range(-2, 3)]

    # The arcade, and the stone round each arch.
    parts.append(wall(arcade_outline(-ARCADE, ARCADE, GROUND, arches), 0.55, P.STUCCO, reveal=P.STUCCO_WARM))
    for cx, hw, spring in arches:
        parts.append(wall(archivolt(hw, spring, foot=spring), 0.06, 0xE4D0A8, back=False).at(cx, 0, 0.06))
        parts.append(taper(0.26, 0.1, 0.36, 0.12, 0.34, P.STONE_LIGHT).at(cx, spring + hw - 0.04, 0.07))
    for k in range(-3, 3):
        x = BAY * (k + 0.5)
        w = BAY - 2 * ARCH_HALF
        parts.append(box(w + 0.14, 0.14, 0.7, P.STONE_LIGHT).at(x, SPRING - 0.14, -0.26))
        parts.append(box(w + 0.1, 0.5, 0.66, P.STONE_DARK).at(x, 0, -0.27))
        placed.append(("wall-lamp", T(x, SPRING + 0.75, 0.0)))
    # The gallery behind: its back wall with the doors, its ceiling.
    back = [(-ARCADE, 0), (-0.95, 0)] + [(0.95 * math.cos(math.pi - math.pi * i / 8), 2.0 + 0.95 * math.sin(math.pi * i / 8)) for i in range(9)] + [(0.95, 0), (ARCADE, 0), (ARCADE, GROUND), (-ARCADE, GROUND)]
    holes = [kit.rect(x - 0.65, x + 0.65, 1.15, 2.75) for x in (-6, -3, 3, 6)]
    parts.append(wall(back, 0.3, P.STUCCO_WARM, holes=holes, back=False).at(0, 0, -GALLERY))
    parts += kit.xf(door(1.9, 2.5), T(0, 0, -GALLERY))
    half_moon = [(0.95 * math.cos(math.pi * i / 8), 2.5 + 0.45 * math.sin(math.pi * i / 8)) for i in range(9)]
    parts.append(wall(half_moon, 0.01, GLASS, "glass", back=False).at(0, 0, -GALLERY - 0.14))
    for x in (-6, -3, 3, 6):
        placed.append(("window.low", T(x, 1.95, -GALLERY)))
    parts.append(box(2 * ARCADE, 0.12, GALLERY, P.STUCCO_WARM).at(0, GROUND - 0.12, -GALLERY / 2))
    for x in np.arange(-ARCADE + 1.5, ARCADE, 1.5):
        parts.append(box(0.14, 0.16, GALLERY - 0.3, P.WOOD_DARK).at(x, GROUND - 0.28, -GALLERY / 2 - 0.1))
    for x in (-ARCADE + 0.2, ARCADE - 0.2):
        parts.append(box(0.3, GROUND, GALLERY, P.STUCCO_WARM).at(x, 0, -GALLERY / 2 - 0.25))

    # The wings: the pro shop (toward -x) and the bar (toward +x).
    shop = kit.rect(-12.4, -9.2, 0.75, 2.85)
    wing = [(-HALF, 0), (-8.7, 0), (-8.7, 2.45), (-7.85, 2.45), (-7.85, 0), (-ARCADE, 0), (-ARCADE, GROUND), (-HALF, GROUND)]
    parts.append(wall(wing, 0.4, P.STUCCO, holes=[shop], reveal=P.STUCCO_WARM))
    hatch = kit.rect(8.2, 12.3, 1.08, 2.85)
    wing = [(ARCADE, 0), (HALF, 0), (HALF, GROUND), (ARCADE, GROUND)]
    parts.append(wall(wing, 0.4, P.STUCCO, holes=[hatch], reveal=P.STUCCO_WARM))
    # The shop's window: a lit recess with a frame, a door beside it.
    parts.append(quad((-12.4, 0.75, -1.1), (-9.2, 0.75, -1.1), (-9.2, 2.85, -1.1), (-12.4, 2.85, -1.1), 0xF0C46A))
    parts.append(quad((-12.4, 0.75, -1.1), (-12.4, 0.75, -0.4), (-9.2, 0.75, -0.4), (-9.2, 0.75, -1.1), P.WOOD_PALE))
    parts.append(quad((-12.4, 2.85, -0.4), (-12.4, 2.85, -1.1), (-9.2, 2.85, -1.1), (-9.2, 2.85, -0.4), P.STUCCO_WARM))
    parts.append(quad((-12.4, 0.75, -0.4), (-12.4, 0.75, -1.1), (-12.4, 2.85, -1.1), (-12.4, 2.85, -0.4), 0xE3B55C))
    parts.append(quad((-9.2, 0.75, -1.1), (-9.2, 0.75, -0.4), (-9.2, 2.85, -0.4), (-9.2, 2.85, -1.1), 0xE3B55C))
    for x in (-12.4, -9.2, -10.8):
        parts.append(box(0.09 if x != -10.8 else 0.05, 2.1, 0.08, P.NAVY).at(x, 0.75, -0.06))
    for y in (0.75, 2.77):
        parts.append(box(3.2, 0.08, 0.08, P.NAVY).at(-10.8, y, -0.06))
    parts.append(box(3.5, 0.08, 0.26, P.STONE_LIGHT).at(-10.8, 0.67, -0.02))
    # Glints on the glass: two slanting bars of light.
    for x, w in ((-11.9, 0.22), (-11.5, 0.09)):
        parts.append(quad((x, 0.95, -0.05), (x + w, 0.95, -0.05), (x + w + 0.9, 2.65, -0.05), (x + 0.9, 2.65, -0.05), 0xFFFFFF, "cloth"))
    shop_leaf = door(0.85, 2.45, P.NAVY)
    parts += kit.xf(shop_leaf, T(-8.275, 0, 0))
    # The bar's hatch: a counter in the opening, shelves of bottles behind.
    parts.append(box(4.5, 0.09, 0.75, 0xEFE7DA).at(10.25, 1.05, 0.05))
    parts.append(box(4.3, 0.06, 0.6, P.WOOD_DARK).at(10.25, 0.99, 0.02))
    parts.append(quad((8.2, 1.08, -1.6), (12.3, 1.08, -1.6), (12.3, 2.85, -1.6), (8.2, 2.85, -1.6), 0x2F5F6B))
    parts.append(quad((8.2, 2.85, -0.4), (8.2, 2.85, -1.6), (12.3, 2.85, -1.6), (12.3, 2.85, -0.4), P.STUCCO_WARM))
    parts.append(quad((8.2, 1.08, -0.4), (8.2, 1.08, -1.6), (8.2, 2.85, -1.6), (8.2, 2.85, -0.4), 0x2A5560))
    parts.append(quad((12.3, 1.08, -1.6), (12.3, 1.08, -0.4), (12.3, 2.85, -0.4), (12.3, 2.85, -1.6), 0x2A5560))
    for y in (1.75, 2.25):
        parts.append(box(3.7, 0.04, 0.22, P.WOOD_PALE).at(10.25, y, -1.48))
    rng = np.random.default_rng(4)
    for y in (1.79, 2.29):
        for i in range(16):
            x = 8.55 + 3.4 * i / 15 + rng.uniform(-0.03, 0.03)
            placed.append((f"bottle.{int(rng.integers(len(BOTTLES)))}", T(x, y, -1.46) @ S(1, rng.uniform(0.8, 1.2), 1)))
    parts += kit.xf(awning(3.7, 1.5, 0.55, [P.BRANDS["Garbí"][0], P.STUCCO]), T(-10.8, 3.15, 0.02))
    parts += kit.xf(awning(4.6, 1.7, 0.6, [P.BRANDS["Xaloc"][0], P.STUCCO]), T(10.25, 3.2, 0.02))
    # Above the wings' openings.
    signs.append(("PRO SHOP", T(-10.8, GROUND - 0.45, 0.03), 2.6, 0.36, "caps", P.NAVY, None))
    signs.append(("BAR · TERRASSA", T(10.25, GROUND - 0.45, 0.03), 3.0, 0.34, "caps", P.NAVY, None))

    # The upper storey: windows with shutters, balconies in the middle, flowers on the sills.
    xs = [-10.8, -6.0, -3.0, 0.0, 3.0, 6.0, 10.25]
    holes = [kit.rect(x - 0.55, x + 0.55, GROUND + 0.85, GROUND + 2.65) for x in xs]
    parts.append(wall([(-HALF, GROUND), (HALF, GROUND), (HALF, EAVE), (-HALF, EAVE)], 0.4, P.STUCCO, holes=holes, reveal=P.STUCCO_WARM))
    for i, x in enumerate(xs):
        placed.append(("window", T(x, GROUND + 1.75, 0)))
        placed.append(("shutter", T(x + 0.58, GROUND + 1.75, 0)))
        placed.append(("shutter", T(x - 0.58, GROUND + 1.75, 0) @ S(-1, 1, 1)))
        if abs(x) < 4:
            placed.append(("balcony", T(x, GROUND + 0.8, 0)))
        else:
            placed.append((f"flowers.{i % 2}", T(x, GROUND + 0.8, 0.02)))
    # Mouldings: a plinth, a string course between the storeys, a tiled frieze and the cornice.
    run = [np.array([-HALF - 0.02, 0, 0.0]), np.array([HALF + 0.02, 0, 0.0])]
    parts.append(extrude([(0.0, GROUND - 0.1), (-0.07, GROUND - 0.06), (-0.1, GROUND + 0.06), (-0.04, GROUND + 0.12), (0.0, GROUND + 0.12)], run, P.STONE_LIGHT))
    parts.append(extrude([(0.0, EAVE - 0.28), (-0.1, EAVE - 0.2), (-0.16, EAVE - 0.06), (-0.3, EAVE), (0.0, EAVE)], run, P.STONE_LIGHT))
    for wing_x in (-1, 1):
        x0, x1 = (ARCADE, HALF) if wing_x > 0 else (-HALF, -ARCADE)
        parts.append(box(x1 - x0, 0.5, 0.06, P.STONE_DARK).at((x0 + x1) / 2, 0, 0.03))
    tiles = 86
    for i in range(tiles):
        x = -HALF + 2 * HALF * (i + 0.5) / tiles
        parts.append(box(2 * HALF / tiles, 0.3, 0.02, TILE_BLUE if i % 2 else 0xF4F1E6).at(x, EAVE - 0.6, 0.01))
    for i in range(44):
        x = -HALF + 0.3 + (2 * HALF - 0.6) * i / 43
        placed.append(("corbel", T(x, EAVE - 0.02, 0)))
    signs.append(("COSTA NEVADA COUNTRY CLUB", T(0, GROUND + 0.42, 0.03), 11.5, 0.42, "caps", P.NAVY, None))

    # The rest of the house: side and back walls, the roof, a chimney.
    side = [(0.0, 0.0), (DEPTH, 0.0), (DEPTH, EAVE), (0.0, EAVE)]
    for sx in (-1, 1):
        m = T(sx * HALF, 0, 0) @ RY(sx * math.pi / 2) @ T(-DEPTH if sx < 0 else 0, 0, 0)
        parts.append(wall(side, 0.4, P.STUCCO, holes=[kit.rect(2.5, 3.6, GROUND + 0.85, GROUND + 2.65), kit.rect(6.0, 7.1, GROUND + 0.85, GROUND + 2.65)], reveal=P.STUCCO_WARM).xf(m))
        for wx in (3.05, 6.55):
            placed.append(("window", m @ T(wx, GROUND + 1.75, 0)))
            placed.append(("shutter", m @ T(wx + 0.58, GROUND + 1.75, 0)))
            placed.append(("shutter", m @ T(wx - 0.58, GROUND + 1.75, 0) @ S(-1, 1, 1)))
    parts.append(box(2 * HALF, EAVE, 0.4, P.STUCCO).at(0, 0, -DEPTH + 0.2))
    parts += kit.xf(hip_roof(HALF + 0.55, DEPTH / 2 + 0.55, EAVE + 0.02, EAVE + 2.5), T(0, 0, -DEPTH / 2))
    parts.append(box(0.9, 1.5, 0.7, P.STUCCO).at(-7.5, EAVE + 1.2, -DEPTH / 2 - 1.0))
    parts.append(taper(1.1, 0.9, 0.5, 0.3, 0.3, P.ROOF).at(-7.5, EAVE + 2.7, -DEPTH / 2 - 1.0))
    return parts, placed, signs


def corbel():
    """A bracket under the cornice."""
    return [taper(0.12, 0.26, 0.12, 0.08, 0.2, P.STONE_LIGHT).xf(T(0, 0, 0.13) @ RX(math.pi))]


def define(sc):
    """The props the clubhouse places."""
    sc.define("window", window())
    sc.define("window.low", window(1.3, 1.6))
    sc.define("shutter", shutter())
    sc.define("flowers", flower_box(sc, 1.5, GERANIUM, 3))
    sc.define("balcony", balcony() + [("flowers", T(0, 0.0, 0.3))])
    sc.define("flowers.0", flower_box(sc, 1.2, GERANIUM, 1))
    sc.define("flowers.1", flower_box(sc, 1.2, 0xE85D8A, 2))
    sc.define("wall-lamp", wall_lamp())
    sc.define("corbel", corbel())
    for i, c in enumerate(BOTTLES):
        sc.define(f"bottle.{i}", [lathe([(0.04, 0), (0.04, 0.17), (0.015, 0.22), (0.015, 0.28)], 5, c)])


def bougainvillea(sc, points, spread=0.55, seed=0, hang=0.0):
    """Bougainvillea massed along a line of points: clumps of flower over darker leaf, some trailing down."""
    rng = np.random.default_rng(seed)
    parts = []
    for p in points:
        p = np.asarray(p, dtype=float)
        for k in range(5):
            o = rng.normal(size=3) * spread * np.array([0.7, 0.35, 0.7])
            r = spread * rng.uniform(0.42, 0.7)
            flower = k < 3 or rng.uniform() < 0.3
            c = (P.BOUGAINVILLEA if rng.uniform() < 0.65 else P.BOUGAINVILLEA_DEEP) if flower else P.LEAF_DARK
            parts.append(P.clumps(sc, p + o + np.array([0, 0.08 if flower else -0.05, 0]), r, c, int(rng.integers(1 << 30)), 0.72, 2))
        if hang and rng.uniform() < 0.7:
            # A spray trailing down: clumps on a line, smaller toward its end.
            q = p + rng.normal(size=3) * spread * np.array([0.5, 0.0, 0.5])
            length = hang * rng.uniform(0.5, 1.0)
            for k in range(3):
                at = q + np.array([rng.uniform(-0.06, 0.06), -length * (0.25 + 0.36 * k), rng.uniform(-0.06, 0.06)])
                parts.append(P.clumps(sc, at, spread * (0.46 - 0.11 * k), P.BOUGAINVILLEA if k else P.BOUGAINVILLEA_DEEP, int(rng.integers(1 << 30)), 1.1, 1))
    return parts


def pergola(x0, x1, z0, z1, height=2.9, bays=2):
    """A pergola over a rectangle: plastered columns, timber beams and rafters with shaped ends."""
    parts = []
    xs = [x0 + (x1 - x0) * i / bays for i in range(bays + 1)]
    for x in xs:
        for z in (z0, z1):
            parts.append(box(0.52, 0.16, 0.52, P.STONE_DARK).at(x, 0, z))
            parts.append(box(0.4, height - 0.3, 0.4, P.STUCCO).at(x, 0.16, z))
            parts.append(box(0.5, 0.14, 0.5, P.STONE_LIGHT).at(x, height - 0.14, z))
    for z in (z0, z1):
        parts.append(box(x1 - x0 + 1.2, 0.26, 0.18, P.WOOD).at((x0 + x1) / 2, height, z))
    n = round((x1 - x0 + 0.6) / 0.75)
    for i in range(n + 1):
        x = x0 - 0.3 + (x1 - x0 + 0.6) * i / n
        parts.append(box(0.1, 0.2, z1 - z0 + 1.3, P.WOOD_DARK if i % 2 else P.WOOD).at(x, height + 0.26, (z0 + z1) / 2))
    return parts
