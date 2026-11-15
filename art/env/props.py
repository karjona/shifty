"""Props of Costa Nevada's seafront: stonework, plants, flags and boats. Each is a list of meshes standing on y = 0
at the origin, facing +z unless it says otherwise; things the wind moves fly toward +x."""

import math

import numpy as np

import kit
from kit import RX, RY, RZ, S, T, TAU, ball, blob, box, disc, extrude, grid, lathe, quad, ribbon, rod, slab, taper, tri, tube

# Stone and plaster.
STONE = 0xEFE3CB
STONE_LIGHT = 0xF8F0DF
STONE_DARK = 0xD3C2A2
STONE_DEEP = 0xB5A283
STUCCO = 0xF7F1E5
STUCCO_WARM = 0xF3E3C3
TERRACOTTA = 0xC8663C
TERRACOTTA_DARK = 0xA44E2C
ROOF = 0xCB6A40
# Wood, iron, paint.
WOOD = 0x9A6A40
WOOD_DARK = 0x6B4528
WOOD_PALE = 0xC9A26E
IRON = 0x2C3036
WHITE = 0xF9F6EE
BRASS = 0xE0AE4A
GLOW = 0xFFF1BF
NAVY = 0x1E2C5C
# The four seasons' accents: summer, fall, winter, spring.
SEASONS = [0x2B3FD0, 0xC24A1C, 0xD4262F, 0x24804A]
# Costa Nevada's brands, named after the winds, each with its colours (main, second).
BRANDS = {
    "Tramuntana": (0x1F5FA8, 0xF7F1E5),
    "Garbí": (0x1E9BB0, 0xF7F1E5),
    "Llevant": (0xE8A72C, 0xF7F1E5),
    "Xaloc": (0xD9482E, 0xF7F1E5),
    "Ponent": (0x2F7D5B, 0xF7F1E5),
}
# Plants.
PALM = 0x4C9440
PALM_YOUNG = 0x7DB04A
PALM_OLD = 0x3B7A3A
PALM_DRY = 0xB99855
TRUNK = 0x8A6A48
TRUNK_DARK = 0x6E5238
LEAF = 0x4F8F3C
LEAF_DARK = 0x356E33
OLIVE = 0x7F9A6C
OLIVE_LIGHT = 0xA3B58A
BOUGAINVILLEA = 0xD9308A
BOUGAINVILLEA_DEEP = 0xB01F78
LEMON = 0xF4D43C

BALUSTER_H = 0.62
RAIL_TOP = 0.95


def baluster():
    """A turned stone baluster, to stand between a plinth and a rail."""
    profile = [
        (0.066, 0.0), (0.066, 0.04), (0.066, 0.04), (0.042, 0.055), (0.036, 0.085), (0.052, 0.13), (0.078, 0.2),
        (0.072, 0.27), (0.046, 0.38), (0.033, 0.455), (0.033, 0.455), (0.054, 0.47), (0.054, 0.5), (0.054, 0.5),
        (0.036, 0.515), (0.042, 0.56), (0.066, 0.585), (0.066, 0.585), (0.066, 0.62),
    ]  # fmt: skip
    return [lathe(profile, 8, STONE)]


RAIL = [(0.1, 0.74), (0.1, 0.775), (0.15, 0.8), (0.15, 0.9), (0.11, 0.95), (-0.11, 0.95), (-0.15, 0.9), (-0.15, 0.8), (-0.1, 0.775), (-0.1, 0.74), (0.1, 0.74)]  # fmt: skip
PLINTH = [(0.13, 0.0), (0.13, 0.09), (0.1, 0.12), (-0.1, 0.12), (-0.13, 0.09), (-0.13, 0.0)]


def balustrade(scene, a, b, y=0.0):
    """A stone balustrade from `a` to `b` (x, z): plinth, balusters (the scene's `baluster`) and rail."""
    a3, b3 = np.array([a[0], y, a[1]]), np.array([b[0], y, b[1]])
    scene.add(extrude(RAIL, [a3, b3], STONE_LIGHT))
    scene.add(extrude(PLINTH, [a3, b3], STONE_DARK))
    length = np.linalg.norm(b3 - a3)
    n = max(1, round(length / 0.23))
    for i in range(n):
        p = a3 + (b3 - a3) * (i + 0.5) / n
        scene.place("baluster", T(p[0], y + 0.12, p[2]))


def pier(top="ball"):
    """A square stone pier at the end of a balustrade, with a ball or a lantern on top."""
    parts = [
        box(0.6, 0.16, 0.6, STONE_DARK),
        box(0.48, 0.86, 0.48, STONE).at(0, 0.16, 0),
        taper(0.48, 0.48, 0.64, 0.64, 0.05, STONE_LIGHT).at(0, 1.02, 0),
        box(0.64, 0.07, 0.64, STONE_LIGHT).at(0, 1.07, 0),
        taper(0.64, 0.64, 0.34, 0.34, 0.09, STONE_LIGHT).at(0, 1.14, 0),
    ]
    # A sunk panel on each face.
    for k in range(4):
        parts.append(box(0.3, 0.56, 0.012, STONE_DARK).at(0, 0.32, 0.24).xf(RY(k * TAU / 4)))
    if top == "ball":
        parts.append(lathe([(0.1, 1.23), (0.07, 1.26), (0.07, 1.26), (0.07, 1.28)], 8, STONE_LIGHT))
        parts.append(ball(0.16, 10, 7, STONE_LIGHT).at(0, 1.42, 0))
    elif top == "lantern":
        parts += kit.xf(lantern(), T(0, 1.23, 0))
    return parts


def lantern():
    """A wrought-iron lantern on a short stem, its glass lit."""
    parts = [
        lathe([(0.09, 0.0), (0.09, 0.025), (0.09, 0.025), (0.03, 0.05), (0.022, 0.2), (0.05, 0.24), (0.11, 0.26), (0.11, 0.26), (0.11, 0.285)], 8, IRON),
        taper(0.17, 0.17, 0.27, 0.27, 0.32, GLOW).at(0, 0.285, 0),
        taper(0.34, 0.34, 0.05, 0.05, 0.15, IRON).at(0, 0.605, 0),
        box(0.31, 0.02, 0.31, IRON).at(0, 0.6, 0),
        ball(0.035, 6, 4, BRASS).at(0, 0.79, 0),
    ]
    for sx in (-1, 1):
        for sz in (-1, 1):
            parts.append(rod((sx * 0.085, 0.285, sz * 0.085), (sx * 0.135, 0.605, sz * 0.135), 0.013, 4, IRON))
    return parts


def urn(plant=True):
    """A terracotta urn, with an agave in it."""
    profile = [(0.16, 0.0), (0.18, 0.04), (0.13, 0.1), (0.2, 0.2), (0.3, 0.42), (0.31, 0.56), (0.25, 0.66), (0.25, 0.66), (0.3, 0.7), (0.3, 0.74), (0.3, 0.74), (0.24, 0.74), (0.22, 0.68)]
    parts = [lathe(profile, 10, TERRACOTTA), disc(0.23, 10, 0x4A3828).at(0, 0.69, 0)]
    if plant:
        parts += kit.xf(agave(), T(0, 0.66, 0))
    return parts


def pot(radius=0.42, height=0.62, colour=TERRACOTTA):
    """A big flowerpot with a rolled rim, earth in it."""
    r, h = radius, height
    profile = [(r * 0.62, 0.0), (r * 0.66, h * 0.06), (r * 0.9, h * 0.86), (r * 0.9, h * 0.86), (r, h * 0.88), (r, h), (r, h), (r * 0.86, h), (r * 0.84, h * 0.93)]
    return [lathe(profile, 12, colour), disc(r * 0.85, 12, 0x4A3828).at(0, h * 0.94, 0)]


def agave(size=0.55, leaves=11, colour=0x5E9A7A, seed=1):
    """A rosette of pointed, fleshy leaves."""
    rng = np.random.default_rng(seed)
    parts = []
    for i in range(leaves):
        az = TAU * i / leaves + rng.uniform(-0.2, 0.2)
        tilt = 0.5 + 0.75 * ((i * 7) % leaves) / leaves
        length = size * rng.uniform(0.8, 1.15)
        path, widths = [], []
        for k in range(6):
            t = k / 5
            out = math.sin(tilt) * length * t + 0.25 * length * t * t * math.sin(tilt)
            up = math.cos(tilt) * length * t - 0.2 * length * t * t
            path.append((math.cos(az) * out, up, math.sin(az) * out))
            widths.append(0.16 * size * 2 * (math.sin(math.pi * min(1, 0.25 + 0.75 * t)) ** 0.8) * (1 - t) ** 0.35 + 0.004)
        c = kit.blend(colour, 0x8FBF8A, rng.uniform(0, 0.4))
        parts.append(ribbon(path, widths, (-math.sin(az), 0, math.cos(az)), c, "foliage", fold=0.05 * size).sway(lambda P: 0.08 * np.clip(P[:, 1] / size, 0, 1)))
    return parts


def frond(length, tilt, az, droop, width=0.95, colour=PALM, tip=PALM_YOUNG, teeth=11, seed=0, sway=1.0, fold=0.2):
    """A palm frond from the origin: a feather of leaflets either side of its rib (a folded blade with a deeply
    toothed edge), arching out and drooping. `fold` lifts the leaflets into a V (or, negative, hangs them)."""
    rng = np.random.default_rng(seed)
    side = rng.uniform(-0.12, 0.12)
    segments = teeth * 2
    path, widths, colours = [], [], []
    for k in range(segments + 1):
        t = k / segments
        out = length * (math.sin(tilt) * t + 0.12 * t * t)
        up = length * (math.cos(tilt) * t - droop * t * t)
        swing = side * length * t * t
        path.append((math.cos(az) * out - math.sin(az) * swing, up, math.sin(az) * out + math.cos(az) * swing))
        w = width * (math.sin(math.pi * min(1.0, 0.06 + 0.98 * t)) ** 0.5) * (1.0 - 0.45 * t)
        # Leaflets: every other station is cut in to near the rib.
        widths.append(max(0.03, w * (1.0 if k % 2 else 0.42)))
        colours.append(kit.blend(colour, tip, t * t))
    mesh = ribbon(path, widths, (-math.sin(az), 0, math.cos(az)), 0xFFFFFF, "foliage", fold=fold * width)
    c = np.repeat(np.array(colours), 3, axis=0)
    # The rib is paler.
    c[1::3] = c[1::3] * 0.55 + kit.srgb(0xC9D27E) * 0.45
    mesh.C = c.astype(np.float32)
    reach = np.linalg.norm(mesh.P, axis=1) / length
    mesh.W = np.clip(reach, 0, 1) ** 2 * sway
    return mesh


def palm_fronds(sc):
    """The fronds palms are crowned with, as props of the scene (each reaching toward +x from the origin): their
    names by tier (upright, arching, drooping, dry), two of each."""
    tiers = {}
    specs = (("up", 0.42, 0.12, 0.82, PALM_YOUNG, 0xA6C85A, 0.55, 0.22), ("out", 0.95, 0.3, 1.0, PALM, PALM_YOUNG, 0.8, 0.12), ("down", 1.38, 0.52, 0.95, PALM_OLD, PALM, 1.0, -0.14))
    for name, tilt, droop, length, colour, tip, sway, fold in specs:
        tiers[name] = []
        for v in range(2):
            key = f"frond.{name}.{v}"
            if key not in sc.defs:
                sc.define(key, [frond(length * (1.0 + 0.08 * v), tilt + 0.08 * v, 0.0, droop - 0.03 * v, 0.95, colour, tip, seed=len(name) * 10 + v, sway=sway, fold=fold)])
            tiers[name].append(key)
    tiers["dry"] = []
    for v in range(2):
        key = f"frond.dry.{v}"
        if key not in sc.defs:
            sc.define(key, [frond(0.62, 2.1 + 0.1 * v, 0.0, 0.12, 0.6, PALM_DRY, 0xA98C52, 6, 40 + v, 0.6, -0.15)])
        tiers["dry"].append(key)
    return tiers


def palm(sc, height=7.0, lean=0.5, seed=0, fronds=20, reach=3.4):
    """A date palm: a ringed trunk with a swollen head, a full crown of arching fronds and a skirt of dry ones."""
    rng = np.random.default_rng(seed)
    az0 = rng.uniform(0, TAU)
    steps = max(6, round(height / 0.34))
    profile, colours = [], []
    for k in range(steps + 1):
        t = k / steps
        y = height * t
        r = 0.34 - 0.07 * t + 0.1 * math.exp(-t * 14) + 0.12 * math.exp(-((1 - t) * 9) ** 2)
        # Ring scars: each band steps out under the one above.
        profile += [(r * 1.07, y), (r * 0.93, y + height / steps * 0.98)]
        c = kit.blend(TRUNK, TRUNK_DARK, 0.5 + 0.5 * math.sin(k * 2.4)) if k % 2 else kit.srgb(TRUNK)
        colours += [c, c * 0.92]
    trunk = lathe(profile, 9, TRUNK, colours=colours)
    # The trunk leans in a slow curve.
    bend = trunk.P[:, 1] / height
    trunk.P[:, 0] += math.cos(az0) * lean * bend * bend
    trunk.P[:, 2] += math.sin(az0) * lean * bend * bend
    top = np.array([math.cos(az0) * lean, height, math.sin(az0) * lean])
    parts = [trunk]
    # The head: old frond bases, a pineapple of orange-brown stubs.
    head = lathe([(0.3, -0.5), (0.43, -0.15), (0.47, 0.15), (0.36, 0.5), (0.14, 0.75)], 9, 0xA9713A, colours=[TRUNK, 0xA9713A, 0xC08A42, 0xB88A45, PALM_OLD])
    parts.append(head.xf(T(*top)))
    tiers = palm_fronds(sc)
    crown = T(top[0], top[1] + 0.35, top[2])
    for i in range(fronds):
        name = ("up", "out", "down")[i % 3]
        az = TAU * i / fronds + rng.uniform(-0.12, 0.12)
        parts.append((tiers[name][int(rng.integers(2))], crown @ RY(-az) @ S(reach * rng.uniform(0.92, 1.08))))
    for i in range(4):
        az = TAU * i / 4 + rng.uniform(-0.3, 0.3)
        parts.append((tiers["dry"][i % 2], crown @ RY(-az) @ S(reach)))
    return parts


def flag(length, height, colour, slash=0xFFFFFF, nu=9, nv=3):
    """A flag flying from its hoist (the y axis, from y = 0 up to `height`) toward +x, rippled, with the game's
    tilted slash across it."""
    lean = math.tan(math.radians(23.4)) * height / length
    band = 0.13

    def point(u, v):
        x = u * length
        ripple = math.sin(u * 7.5 + v * 1.3) * 0.07 * length * u
        y = v * height - 0.16 * length * u * u * (1.2 - v * 0.4)
        return (x, y, ripple)

    def region(u0, u1, c, n):
        # Edges lean with the slash: u at the bottom differs from u at the top.
        def p(a, v):
            l0 = u0(v)
            l1 = u1(v)
            return point(l0 + (l1 - l0) * a, v)

        return grid(n, nv, p, c, "cloth")

    mid = 0.42
    left = lambda v: mid - band / 2 + (v - 0.5) * lean  # noqa: E731
    right = lambda v: mid + band / 2 + (v - 0.5) * lean  # noqa: E731
    parts = [
        region(lambda v: 0.0, left, colour, 3),
        region(left, right, slash, 1),
        region(right, lambda v: 1.0, colour, nu - 4),
    ]
    return [p.sway(lambda P: np.clip(P[:, 0] / length, 0, 1) ** 1.2) for p in parts]


def pennant(length, height, colour):
    """A long triangular pennant flying from the y axis toward +x."""

    def point(u, v):
        x = u * length
        y = (v - 0.5) * height * (1 - u) + height / 2 - 0.1 * length * u * u
        return (x, y, math.sin(u * 6) * 0.06 * length * u)

    return [grid(6, 1, point, colour, "cloth").sway(lambda P: np.clip(P[:, 0] / length, 0, 1) ** 1.2)]


def mast(height=8.0, flags=SEASONS):
    """A signal mast: a white pole with a yard, the four seasons' flags hoisted one under another, and the club's
    pennant at the masthead."""
    parts = [
        tube([(0, 0, 0), (0, height * 0.5, 0), (0, height, 0)], [0.1, 0.085, 0.05], 8, WHITE),
        lathe([(0.2, 0.0), (0.2, 0.08), (0.2, 0.08), (0.13, 0.12), (0.12, 0.5), (0.12, 0.5), (0.1, 0.52)], 8, STONE_DARK),
        ball(0.09, 8, 5, BRASS).at(0, height + 0.07, 0),
        rod((0, height * 0.8, -1.25), (0, height * 0.8, 1.25), 0.035, 6, WHITE),
        ball(0.045, 6, 4, BRASS).at(0, height * 0.8, -1.27),
        ball(0.045, 6, 4, BRASS).at(0, height * 0.8, 1.27),
    ]
    # Stays from the yard's ends to the masthead.
    for side in (-1, 1):
        parts.append(rod((0, height * 0.8, side * 1.25), (0, height - 0.1, 0), 0.012, 3, IRON))
    y = height - 0.5
    parts += kit.xf(pennant(1.3, 0.34, NAVY), T(0.05, height - 0.38, 0))
    y -= 0.2
    for c in flags:
        y -= 0.72
        parts += kit.xf(flag(1.02, 0.62, c), T(0.06, y, 0))
    # The halyard the flags are hoisted on.
    parts.append(rod((0.06, y - 0.2, 0), (0.06, height - 0.6, 0), 0.01, 3, STONE_DEEP))
    return parts


def bunting(a, b, sag, count, colours, size=0.26):
    """A line of small pennants from `a` to `b`, hanging `sag` in the middle."""
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    line = kit.catenary(a, b, sag, 14)
    parts = [tube(line, 0.012, 3, STONE_DEEP, caps=False)]
    along = (b - a) / np.linalg.norm(b - a)
    for i in range(count):
        t = (i + 0.5) / count
        p = a + (b - a) * t
        p[1] -= sag * 4 * t * (1 - t)
        w = along * size * 0.5
        tip = p + np.array([0.05, -size * 1.25, 0.0])
        mesh = tri(p - w, p + w, tip, colours[i % len(colours)], "cloth")
        mesh.W = np.array([0, 0, 1.0], dtype=np.float32) * 0.5
        parts.append(mesh)
    return parts


def string_lights(a, b, sag, count):
    """A string of lamps from `a` to `b` (the scene's `lamp`)."""
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    parts = [tube(kit.catenary(a, b, sag, 12), 0.011, 3, IRON, caps=False)]
    for i in range(count):
        t = (i + 0.5) / count
        p = a + (b - a) * t
        p[1] -= sag * 4 * t * (1 - t)
        parts.append(("lamp", T(*p)))
    return parts


def lamp():
    """A lamp of a string of lights, hanging from the origin."""
    return [box(0.035, 0.05, 0.035, IRON).at(0, -0.05, 0), ball(0.055, 6, 4, GLOW, squash=1.25).at(0, -0.12, 0)]


def hull(length=6.0, beam=2.0, colour=WHITE, stripe=NAVY):
    """A small sailing boat's hull and deck, its bow toward +x, floating with its waterline at y = 0."""
    half = length / 2

    def side(sign):
        def point(u, v):
            x = -half + length * u
            fore = max(0.0, (x / half)) ** 2.2
            aft = max(0.0, (-x / half)) ** 3
            b = beam / 2 * (1 - fore) * (1 - 0.25 * aft)
            sheer = 0.55 + 0.25 * fore + 0.05 * aft
            # v: 0 at the keel, 1 at the gunwale.
            y = -0.45 * (1 - fore * 0.6) + (sheer + 0.45 * (1 - fore * 0.6)) * v**1.6
            z = sign * b * (math.sin(v * math.pi / 2) ** 0.7)
            return (x, y, z)

        m = grid(10, 4, point, colour, "solid")
        m.C[m.P[:, 1] < 0.12] = kit.srgb(stripe)
        m.C[m.P[:, 1] < -0.05] = kit.srgb(0x8A2B22)
        return m if sign > 0 else m.flipped()

    deck = []
    for i in range(11):
        x = -half + length * i / 10
        fore = max(0.0, (x / half)) ** 2.2
        aft = max(0.0, (-x / half)) ** 3
        deck.append((x, beam / 2 * (1 - fore) * (1 - 0.25 * aft), 0.55 + 0.25 * fore + 0.05 * aft))
    outline = [(x, b) for x, b, _ in deck] + [(x, -b) for x, b, _ in reversed(deck)]
    top = kit.plate(outline, 0.6, WOOD_PALE)
    cabin = taper(length * 0.3, beam * 0.55, length * 0.24, beam * 0.45, 0.32, colour).at(0.2, 0.6, 0)
    return [side(1), side(-1), top, cabin]


def sailboat(length=6.0, mast_height=7.6, colour=WHITE, stripe=NAVY, sail=0xF3EAD6, flag=0xD4262F):
    """A moored sailing boat: sail furled on the boom, a pennant at the masthead."""
    parts = hull(length, length / 3, colour, stripe)
    mx = length * 0.12
    parts += [
        tube([(mx, 0.6, 0), (mx, mast_height, 0)], [0.07, 0.045], 6, STONE_LIGHT),
        rod((mx, 1.5, 0), (mx - length * 0.48, 1.42, 0), 0.05, 6, STONE_LIGHT),
        tube([(mx - 0.1, 1.62, 0), (mx - length * 0.24, 1.6, 0), (mx - length * 0.46, 1.52, 0)], [0.13, 0.12, 0.07], 6, sail),
        rod((mx, mast_height * 0.62, -0.5), (mx, mast_height * 0.62, 0.5), 0.022, 4, STONE_LIGHT),
        rod((mx, mast_height * 0.62, -0.5), (mx, mast_height - 0.05, 0), 0.01, 3, IRON),
        rod((mx, mast_height * 0.62, 0.5), (mx, mast_height - 0.05, 0), 0.01, 3, IRON),
        rod((length / 2 - 0.1, 0.85, 0), (mx, mast_height - 0.05, 0), 0.01, 3, IRON),
    ]
    parts += kit.xf(pennant(0.7, 0.22, flag), T(mx + 0.03, mast_height - 0.3, 0))
    return parts


def far_sail(height=9.0, colour=0xFFFFFF, hull_colour=0xF2F0EA):
    """A boat under sail, to see from far away: a hull, a mainsail and a jib. It sails toward +x."""
    return [
        slab([(-3.2, -0.9), (2.4, -0.9), (4.2, 0.0), (2.4, 0.9), (-3.2, 0.9)], 0, 1.1, hull_colour),
        tri((0.2, 1.2, 0), (0.2, height, 0), (-3.4, 1.4, 0.3), colour, "cloth"),
        tri((0.5, 1.2, 0), (3.9, 1.2, 0), (0.5, height * 0.86, 0), colour, "cloth"),
        rod((0.3, 1.0, 0), (0.3, height + 0.3, 0), 0.07, 4, 0x6B4528),
    ]


def clump(sc, colour, variant=0, detail=2, sway=0.08):
    """A clump of leaves or flowers of unit radius, as a prop of the scene (defined on first use): its name. A
    rounded mass with leaves standing out of it all round, so its outline is ragged. Trees and climbers are placed
    clumps."""
    name = f"clump.{colour:06x}.{variant}.{detail}"
    if name not in sc.defs:
        rng = np.random.default_rng(100 + variant)
        parts = [blob(1.0, 11 + variant * 7, colour, "foliage", 0.32, 1.0, detail).sway(sway)]
        light = kit.shade(colour, 1.18)
        for k in range(10 + 6 * detail):
            d = rng.normal(size=3)
            d[1] = d[1] * 0.8 + 0.25
            d /= np.linalg.norm(d)
            side = np.cross(d, rng.normal(size=3))
            side /= np.linalg.norm(side)
            lift = np.cross(side, d)
            tip = d * rng.uniform(1.22, 1.42) + lift * rng.uniform(-0.2, 0.3)
            w = rng.uniform(0.14, 0.22)
            leaf = tri(d * 0.86 - side * w, d * 0.86 + side * w, tip, light if k % 3 == 0 else colour, "foliage")
            parts.append(leaf.sway(sway * 1.6))
        sc.define(name, parts)
    return name


def clumps(sc, centre, radius, colour, seed=0, squash=0.8, detail=2):
    """A clump placed: (name, matrix), turned at random."""
    rng = np.random.default_rng(seed)
    m = T(*centre) @ RY(rng.uniform(0, TAU)) @ RZ(rng.uniform(-0.3, 0.3)) @ S(radius, radius * squash, radius)
    return (clump(sc, colour, int(rng.integers(2)), detail), m)
