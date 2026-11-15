"""The Tilt's podium, on the town's promenade: three blocks on a base with the seasons' colours, an arch behind
them (two pylons, a header board, a banner hanging either side of each pylon), a carpet, flowers, a pen of
spectators each side behind sponsors' barriers, lamp posts and a palm.

Its origin is the foot of the champion's block; the riders face +z (the town), the quay's edge and the bay are
behind them (-z). Signs whose paper is "accent" are painted in the season's colour by the client.
"""

import math

import numpy as np

import kit
import people
import props as P
from kit import RX, RY, RZ, S, T, TAU, ball, blob, box, lathe, quad, ribbon, rod, taper, tube
from scene import Scene

# The blocks, in the order of their places: across (m), height (m). The client stands the riders on them.
STEPS = [(0.0, 1.1), (-1.56, 0.8), (1.56, 0.56)]
STEP_W, STEP_D = 1.5, 1.4
BASE = 0.1
# The quay's edge, and the line the arch stands on.
EDGE = -2.0
ARCH_Z = -1.62
PYLON_X = 4.0
# Where the breeze blows (x, z).
WIND = (0.9, -0.44)

GOLD = P.BRASS
LACQUER = 0xFBF8F1
PAPER = 0xF6F2EA
CARPET = 0x1E2C5C
FLOWERS = [0xE8483A, 0xFBF6EC, 0xF08FA8, 0xF4D43C, 0xE8483A]


def sign(sc, m, text, w, h, style="display", ink=PAPER, paper=None):
    sc.anchor("sign", m, text=text, w=w, h=h, style=style, ink=ink, paper=paper)


def laurel(radius, leaves=12):
    """Two sprays of leaves curving up round a number, flat, facing +z."""
    parts = []
    for side in (-1, 1):
        for i in range(leaves):
            a = -math.pi / 2 + side * (0.35 + 2.1 * i / (leaves - 1))
            out = np.array([math.cos(a), math.sin(a), 0])
            along = np.array([-math.sin(a), math.cos(a), 0]) * side
            c = out * radius
            l, r = c + out * radius * 0.14, c - out * radius * 0.06
            leaf = kit.tri(r, c + along * radius * 0.24 + out * radius * 0.14, l, GOLD)
            p = leaf.P
            if np.cross(p[1] - p[0], p[2] - p[0])[2] < 0:
                leaf = leaf.flipped()
            parts.append(leaf)
    return parts


def podium(sc):
    # The base, with the four seasons along its front.
    sc.add(box(5.3, BASE - 0.05, 2.1, P.STONE_LIGHT))
    sc.add(box(5.4, 0.05, 2.2, LACQUER).at(0, BASE - 0.05, 0))
    for i, c in enumerate(P.SEASONS):
        sc.add(box(5.3 / 4, 0.06, 0.02, c).at(-5.3 / 2 + 5.3 / 8 + i * 5.3 / 4, 0.025, 1.055))
    for i, (x, h) in enumerate(STEPS):
        body = h - BASE - 0.09
        sc.add(box(STEP_W, body, STEP_D, LACQUER).at(x, BASE, 0))
        sc.add(box(STEP_W + 0.05, 0.03, STEP_D + 0.05, GOLD).at(x, h - 0.09, 0))
        sc.add(box(STEP_W + 0.12, 0.06, STEP_D + 0.12, LACQUER).at(x, h - 0.06, 0))
        # The face: a panel in the season's colour with the place on it.
        ph = body - 0.07
        mid = BASE + 0.035 + ph / 2
        sign(sc, T(x, mid, STEP_D / 2 + 0.012), "", STEP_W - 0.2, ph, paper="accent")
        # A gilt frame round the panel.
        w2 = (STEP_W - 0.2) / 2
        for sx in (-1, 1):
            sc.add(box(0.03, ph + 0.03, 0.022, GOLD).at(x + sx * w2, mid - ph / 2 - 0.015, STEP_D / 2 + 0.008))
        for y in (mid - ph / 2 - 0.015, mid + ph / 2 - 0.015):
            sc.add(box(STEP_W - 0.2, 0.03, 0.022, GOLD).at(x, y, STEP_D / 2 + 0.008))
        size = min(0.56, ph * 0.84)
        sign(sc, T(x, mid, STEP_D / 2 + 0.03), str(i + 1), size * 1.3, size, "display")
        if i == 0:
            sc.add(kit.xf(laurel(0.4), T(x, mid + 0.03, STEP_D / 2 + 0.022)))
        # Stripes of the four seasons down the block's outer side.
        for side in (-1, 1):
            if (i == 1 and side > 0) or (i == 2 and side < 0):
                continue
            for k, c in enumerate(P.SEASONS):
                sc.add(box(0.012, body, 0.09, c).at(x + side * (STEP_W / 2 + 0.002), BASE, 0.5 - k * 0.11))
    # Paper streamers thrown over the blocks.
    rng = np.random.default_rng(4)
    for k in range(7):
        i = k % 3
        x, h = STEPS[i]
        x0 = x + rng.uniform(-0.55, 0.55)
        z0 = STEP_D / 2 + 0.07
        drop = rng.uniform(0.25, 0.6) * min(1.0, h)
        path = [(x0 + rng.uniform(-0.2, 0.2), h + 0.012, z0 - rng.uniform(0.5, 0.9)), (x0, h + 0.03, z0 - 0.1)]
        for j in range(1, 7):
            t = j / 6
            path.append((x0 + math.sin(t * 7 + k) * 0.06, h - drop * t, z0 + 0.02 + 0.03 * math.sin(t * 9 + k)))
        c = (P.SEASONS + [0xF4D43C, PAPER])[k % 6]
        sc.add(ribbon(path, 0.035, (1, 0, 0), c, "cloth").sway(lambda q, top=h, d=drop: 0.25 * np.clip((top - q[:, 1]) / max(d, 0.01), 0, 1)))


def pylon(sign_text=None):
    """One of the arch's pylons: a tapering white tower banded in the seasons' colours, on a stone foot."""
    h = 5.0
    w = lambda y: 0.62 - 0.2 * y / h  # noqa: E731
    parts = [
        box(0.92, 0.2, 0.92, P.STONE_DARK),
        taper(0.8, 0.8, 0.66, 0.66, 0.1, P.STONE).at(0, 0.2, 0),
        taper(w(0), w(0), w(h), w(h), h, LACQUER).at(0, 0.3, 0),
        box(w(h) + 0.14, 0.08, w(h) + 0.14, LACQUER).at(0, h + 0.3, 0),
        taper(w(h) + 0.14, w(h) + 0.14, 0.12, 0.12, 0.2, CARPET).at(0, h + 0.38, 0),
        ball(0.09, 8, 5, GOLD).at(0, h + 0.64, 0),
    ]
    for k, c in enumerate(P.SEASONS):
        y = 0.62 + k * 0.2
        parts.append(box(w(y) + 0.02, 0.16, w(y) + 0.02, c).at(0, y, 0))
    return parts


def banner(colour, length=2.15, width=0.62):
    """A banner hanging from a pylon's arm (at the origin: its top edge's inner end), leaning with the breeze."""
    cloth = kit.xf(P.flag(length, width, colour), RZ(-math.pi / 2))
    weight = [box(width + 0.06, 0.035, 0.035, P.WOOD_DARK).at(width / 2, 0.0, 0)]
    return cloth + weight


def arch(sc):
    sc.define("pylon", pylon())
    for side in (-1, 1):
        x = side * PYLON_X
        sc.place("pylon", T(x, 0, ARCH_Z))
        # "COSTA NEVADA" up the pylon's face.
        sign(sc, T(x, 2.9, ARCH_Z + 0.275) @ RZ(math.pi / 2), "COSTA NEVADA", 2.2, 0.13, "caps", CARPET)
        # An arm each side, a season's banner hanging from each.
        colours = P.SEASONS[:2] if side < 0 else P.SEASONS[2:]
        for k, way in enumerate((-1, 1)):
            y = 4.25
            sc.add(rod((x, y, ARCH_Z), (x + way * 1.08, y, ARCH_Z), 0.03, 6, GOLD))
            sc.add(ball(0.05, 6, 4, GOLD).at(x + way * 1.1, y, ARCH_Z))
            inner = x + way * 0.36 if way > 0 else x + way * 0.36 - 0.62
            sc.add(banner(colours[k]), T(inner, y - 0.05, ARCH_Z))
    # The header: a board arched along its top, with a pale edge behind it.
    half = PYLON_X - 0.2
    y0, y1, crown = 4.42, 5.02, 0.42

    def outline(grow):
        top = [(half * math.cos(a), y1 + grow + crown * math.sin(a)) for a in np.linspace(0, math.pi, 17)]
        return [(-half - grow, y0 - grow), (half + grow, y0 - grow)] + [(x * (half + grow) / half, y) for x, y in top]

    sc.add(kit.wall(outline(0.0), 0.12, CARPET).at(0, 0, ARCH_Z + 0.1))
    sc.add(kit.wall(outline(0.07), 0.1, LACQUER).at(0, 0, ARCH_Z + 0.07))
    for i, c in enumerate(P.SEASONS):
        sc.add(box(2 * half / 4, 0.07, 0.02, c).at(-half + half / 4 + i * half / 2, y0 + 0.03, ARCH_Z + 0.105))
    # Garlands of leaves and flowers swagged under the header.
    rng = np.random.default_rng(2)
    for k in range(4):
        x0, x1 = -half + 0.25 + k * (2 * half - 0.5) / 4, -half + 0.25 + (k + 1) * (2 * half - 0.5) / 4
        line = kit.catenary((x0, y0 - 0.02, ARCH_Z + 0.06), (x1, y0 - 0.02, ARCH_Z + 0.06), 0.34, 8)
        sc.add(tube(line, 0.075, 5, P.LEAF, "foliage", caps=False).sway(0.04))
        for q in line[1:-1:2]:
            c = FLOWERS[int(rng.integers(len(FLOWERS)))]
            sc.add(blob(0.085, int(rng.integers(99)), c, "foliage", 0.2, 0.8, 0).at(q[0], q[1] - 0.01, q[2] + 0.06).sway(0.05))
        sc.add(blob(0.13, k, P.LEAF_DARK, "foliage", 0.3, 0.9, 0).at(x0, y0 - 0.04, ARCH_Z + 0.07).sway(0.03))
    z = ARCH_Z + 0.118
    sign(sc, T(0, 5.02, z), "THE TILT", 3.3, 0.6)
    sign(sc, T(2.75, 4.86, z), "23.4° SHIFTY", 1.6, 0.2, "brand")
    sign(sc, T(0, 4.56, z), "TRAMUNTANA   ·   GARBÍ   ·   LLEVANT   ·   XALOC   ·   PONENT", 6.6, 0.12, "caps")


def barrier(colour, second=PAPER):
    """A crowd barrier under a sponsor's cover, 2.3 m long, facing +z."""
    parts = [
        box(2.3, 0.82, 0.05, colour).at(0, 0.22, 0),
        box(2.3, 0.09, 0.06, second).at(0, 0.22, 0),
        box(2.3, 0.05, 0.06, second).at(0, 0.99, 0),
        rod((-1.15, 1.07, 0), (1.15, 1.07, 0), 0.028, 6, 0xC9CED6),
    ]
    for x in (-1.12, 1.12):
        parts.append(rod((x, 0.02, 0), (x, 1.07, 0), 0.028, 6, 0xC9CED6))
        parts.append(box(0.07, 0.03, 0.6, 0xC9CED6).at(x, 0, 0))
    return parts


def flowers(seed, spread=0.3, count=12, height=0.0):
    """A bunch of flowers: a mound of leaves with small blooms over it."""
    rng = np.random.default_rng(seed)
    parts = [blob(spread * 0.95, seed, P.LEAF, "foliage", 0.3, 0.7).at(0, height, 0).sway(0.03)]
    for i in range(count):
        a = TAU * i / count + rng.uniform(-0.3, 0.3)
        r = spread * rng.uniform(0.25, 0.95)
        c = FLOWERS[int(rng.integers(len(FLOWERS)))]
        y = height + spread * 0.62 * (1 - (r / spread) ** 2) + rng.uniform(0.0, 0.05)
        parts.append(blob(rng.uniform(0.05, 0.08), seed * 10 + i, c, "foliage", 0.2, 0.8, 0).at(math.cos(a) * r, y, math.sin(a) * r).sway(0.04))
    return parts


def lamp_post():
    """A promenade lamp post: a fluted iron post, two arms with lanterns and a basket of flowers under each."""
    green = 0x24463C
    parts = [
        lathe([(0.2, 0.0), (0.2, 0.12), (0.2, 0.12), (0.13, 0.2), (0.11, 0.7), (0.14, 0.76), (0.14, 0.76), (0.08, 0.84)], 8, green),
        tube([(0, 0.8, 0), (0, 2.4, 0), (0, 4.0, 0)], [0.075, 0.062, 0.05], 8, green),
        lathe([(0.05, 3.3), (0.09, 3.34), (0.09, 3.4), (0.05, 3.44)], 8, green),
        ball(0.07, 6, 4, GOLD).at(0, 4.42, 0),
        tube([(0, 4.0, 0), (0, 4.36, 0)], [0.05, 0.02], 6, green),
    ]
    for side in (-1, 1):
        arm = [(0, 3.42, 0)] + [(side * (0.2 + 0.5 * math.sin(a)), 3.42 + 0.34 * (1 - math.cos(a)), 0) for a in np.linspace(0.3, math.pi * 0.62, 6)]
        parts.append(tube(arm, 0.03, 5, green))
        end = arm[-1]
        parts += kit.xf(P.lantern(), T(end[0] + side * 0.04, end[1] - 0.02, 0))
        # A basket of flowers hanging from the arm.
        bx = side * 0.42
        parts.append(rod((bx, 3.5, 0), (bx, 3.02, 0), 0.012, 3, green))
        parts.append(lathe([(0.05, 2.74), (0.2, 2.9), (0.22, 3.02)], 8, P.WOOD_DARK))
        parts += kit.xf(flowers(3 + side, 0.2, 8), T(bx, 3.0, 0))
    return parts


def crowd(sc):
    """A pen each side of the podium: sponsors' barriers and people behind them, in groups that swap poses."""
    sc.define("barrier.a", barrier(CARPET))
    sc.define("barrier.b", barrier(P.BRANDS["Tramuntana"][0]))
    sc.define("barrier.c", barrier(P.BRANDS["Xaloc"][0]))
    sc.define("barrier.d", barrier(P.BRANDS["Llevant"][0], CARPET))
    rows = [
        # across (toward the outside), z, pair, group
        (4.8, -0.78, "cheer", 0),
        (4.15, -0.72, "photo", 1),
        (3.5, -0.78, "clap", 0),
        (5.15, -1.4, "phone", 1),
        (3.12, -1.42, "wave", 0),
        (4.95, -1.52, "fist", 0),
    ]
    groups = {k: ([], []) for k in range(2)}
    seed = 0
    for side in (-1, 1):
        sc.place("barrier.a" if side < 0 else "barrier.c", T(side * 3.87, 0, -0.3))
        sc.place("barrier.b" if side < 0 else "barrier.d", T(side * 2.72, 0, -1.45) @ RY(side * -math.pi / 2))
        if side < 0:
            sign(sc, T(-3.72, 0.66, -0.27), "23.4° SHIFTY", 1.75, 0.3, "brand")
            sign(sc, T(-2.69, 0.66, -1.45) @ RY(math.pi / 2), "Tramuntana", 1.9, 0.3, "brand")
        else:
            sign(sc, T(3.87, 0.66, -0.27), "Xaloc", 1.6, 0.36, "brand")
            sign(sc, T(2.69, 0.66, -1.45) @ RY(-math.pi / 2), "Llevant", 1.7, 0.32, "brand", CARPET)
        for across, z, name, group in rows:
            seed += 1
            lk = people.look(seed * 3 + 1)
            # They face the podium, turned a little to the town.
            m = T(side * across, 0, z) @ RY(side * -0.75)
            body, a, b = people.pair(lk, name)
            sc.add(body, m)
            groups[group][0].extend(kit.xf(a, m))
            groups[group][1].extend(kit.xf(b, m))
            if name in ("photo", "phone"):
                at = np.array(people.POSES[people.PAIRS[name][0]]["at"]) * lk["height"] / 1.7
                p = m @ np.array([at[0], at[1], at[2] + 0.12, 1.0])
                sc.anchor("flash", T(*p[:3]))
    for k, (a, b) in groups.items():
        sc.anim(f"crowd{k}.a", a)
        sc.anim(f"crowd{k}.b", b)


def ground(sc):
    """The apron of paving round the podium, the carpet before it, and confetti already down."""
    sc.add(kit.plate([(-8.5, EDGE + 0.04), (8.5, EDGE + 0.04), (8.5, 7.7), (-8.5, 7.7)], 0.02, 0xE9DCC2, "paving"))
    sc.add(box(1.8, 0.02, 4.6, CARPET).at(0, 0.02, 3.4))
    for x in (-0.82, 0.82):
        sc.add(box(0.07, 0.024, 4.6, GOLD).at(x, 0.02, 3.4))
    rng = np.random.default_rng(11)
    colours = P.SEASONS + [PAPER, 0xF2C14E]
    for i in range(170):
        x, z = rng.uniform(-5.2, 5.2), rng.uniform(-1.2, 6.2)
        y = 0.048 if abs(x) < 0.95 and 1.1 < z < 5.7 else 0.026
        if abs(x) < 2.75 and abs(z) < 1.1:
            continue
        a = rng.uniform(0, TAU)
        w, d = rng.uniform(0.03, 0.045), rng.uniform(0.05, 0.08)
        c, s = math.cos(a), math.sin(a)
        pts = [(x + c * w * sx - s * d * sz, y, z + s * w * sx + c * d * sz) for sx, sz in ((-1, -1), (-1, 1), (1, 1), (1, -1))]
        sc.add(quad(*pts, colours[int(rng.integers(len(colours)))]))


def build():
    sc = Scene()
    sc.anchor("wind", T(), dir=list(WIND))
    ground(sc)
    podium(sc)
    arch(sc)
    crowd(sc)
    # Flowers: an urn by the base, and a bunch at each front corner of it.
    sc.add(P.urn(False) + flowers(21, 0.3, 14, 0.7), T(3.05, 0, 0.75))
    for side in (-1, 1):
        sc.add(flowers(40 + side, 0.17, 9, 0.0), T(side * 2.48, BASE, 0.86))
    sc.define("lamp", lamp_post())
    sc.place("lamp", T(-5.75, 0, EDGE + 0.4))
    sc.place("lamp", T(5.75, 0, EDGE + 0.4))
    sc.add(P.palm(sc, 5.9, 0.6, 5), T(7.2, 0, -1.0) @ RY(0.8))
    return sc
