"""What stands on the club's terrace: café tables and chairs, parasols, sun loungers, trees in pots, the pro shop's
boards and a jetski on its trailer, a gull, a cat and a ceiling fan. Each is a list of meshes standing on y = 0 at
the origin."""

import math

import numpy as np

import kit
import props as P
from kit import RX, RY, RZ, S, T, TAU, ball, blob, box, disc, grid, lathe, quad, ribbon, rod, slab, taper, tri, tube

CANVAS = 0xF4ECD8
RATTAN = 0xD9B77A
MARBLE = 0xF3EFE6
TEAK = 0xB07A45
CUSHION = 0xF7F3EA
RUBBER = 0x2A2B30
STEEL = 0xAEB6BC


def cafe_table(radius=0.42, height=0.74):
    """A round marble-topped table on a cast-iron foot."""
    foot = [(0.24, 0.0), (0.24, 0.03), (0.24, 0.03), (0.1, 0.07), (0.04, 0.12), (0.035, height - 0.1), (0.07, height - 0.04), (0.07, height - 0.04), (0.12, height - 0.03)]
    top = [(radius - 0.02, height - 0.03), (radius, height - 0.02), (radius, height + 0.01), (radius, height + 0.01), (0.0, height + 0.01)]
    return [lathe(foot, 8, P.IRON), lathe(top, 14, MARBLE, colours=[P.BRASS, P.BRASS, MARBLE, MARBLE, MARBLE])]


def table_setting(seed=0):
    """What is left on a café table: a carafe, glasses, a cup."""
    rng = np.random.default_rng(seed)
    parts = [lathe([(0.045, 0.0), (0.055, 0.1), (0.03, 0.17), (0.035, 0.22)], 6, 0xCDE7EC).at(0.08, 0, -0.06)]
    for i in range(2):
        a = rng.uniform(0, TAU)
        parts.append(lathe([(0.02, 0.0), (0.032, 0.1), (0.032, 0.1), (0.0, 0.1)], 6, (0xF6C453, 0xE8743B)[i]).at(math.cos(a) * 0.2, 0, math.sin(a) * 0.2))
    return parts


def bistro_chair(colour=P.NAVY, weave=CANVAS):
    """A rattan bistro chair with a woven seat and back in two colours, facing +z."""
    parts = []
    seat_h = 0.46
    legs = [(-0.19, 0.17), (0.19, 0.17), (-0.17, -0.19), (0.17, -0.19)]
    for x, z in legs:
        back = z < 0
        top = 0.92 if back else seat_h
        parts.append(tube([(x * 1.08, 0.0, z * 1.1), (x, seat_h, z), (x * 0.95, top, z - (0.08 if back else 0.0))], 0.017, 5, RATTAN))
    parts.append(lathe([(0.2, seat_h - 0.03), (0.23, seat_h), (0.23, seat_h), (0.0, seat_h + 0.015)], 8, weave, colours=[RATTAN, RATTAN, weave, colour]))
    # The back: a hoop with a woven panel.
    hoop = [(-0.165, 0.52, -0.22), (-0.17, 0.8, -0.27), (-0.1, 0.93, -0.28), (0.1, 0.93, -0.28), (0.17, 0.8, -0.27), (0.165, 0.52, -0.22)]
    parts.append(tube(hoop, 0.017, 5, RATTAN))
    n = 4
    for i in range(n):
        for j in range(3):
            x0 = -0.15 + 0.3 * i / n
            y0 = 0.56 + 0.33 * j / 3
            c = colour if (i + j) % 2 else weave
            z = -0.245 - 0.03 * (j + 0.5) / 3
            parts.append(quad((x0, y0, z), (x0 + 0.3 / n, y0, z), (x0 + 0.3 / n, y0 + 0.11, z - 0.01), (x0, y0 + 0.11, z - 0.01), c))
            parts.append(quad((x0 + 0.3 / n, y0, z - 0.004), (x0, y0, z - 0.004), (x0, y0 + 0.11, z - 0.014), (x0 + 0.3 / n, y0 + 0.11, z - 0.014), c))
    parts.append(tube([(-0.2, 0.22, 0.18), (0.2, 0.22, 0.18)], 0.012, 4, RATTAN))
    return parts


def parasol(colour, second=CANVAS, radius=1.55, height=2.55, gores=8, tilt=0.0):
    """A café parasol: a canopy of gores in two colours with a valance that flutters, on a wooden pole with ribs
    and a heavy foot."""
    parts = [
        lathe([(0.3, 0.0), (0.3, 0.05), (0.3, 0.05), (0.2, 0.09), (0.06, 0.12), (0.045, 0.3)], 8, P.STONE_DEEP),
        rod((0, 0.1, 0), (0, height + 0.18, 0), 0.03, 6, P.WOOD),
        ball(0.05, 6, 4, P.WOOD_DARK).at(0, height + 0.2, 0),
    ]
    top = np.array([0.0, height, 0.0])
    rim_y = height - 0.42
    canopy = []
    for i in range(gores):
        a0, a1 = TAU * i / gores, TAU * (i + 1) / gores
        am = (a0 + a1) / 2
        c = colour if i % 2 == 0 else second
        p0 = np.array([radius * math.cos(a0), rim_y, radius * math.sin(a0)])
        p1 = np.array([radius * math.cos(a1), rim_y, radius * math.sin(a1)])
        # The canvas sags a little between the ribs.
        pm = np.array([radius * 0.6 * math.cos(am), rim_y + 0.22, radius * 0.6 * math.sin(am)])
        canopy.append(kit.Mesh([top, p0, p1, pm], [(0, 3, 1), (0, 2, 3), (3, 2, 1)], c, "cloth"))
        # The valance: a tongue hanging from the rim.
        drop = np.array([0.0, -0.2, 0.0])
        mid = (p0 + p1) / 2
        flap = kit.Mesh([p0, p1, p1 + drop * 0.6, mid * 1.01 + drop, p0 + drop * 0.6], [(0, 1, 2), (0, 2, 3), (0, 3, 4)], second if i % 2 == 0 else colour, "cloth")
        flap.W = np.array([0, 0, 0.45, 0.7, 0.45], dtype=np.float32)
        canopy.append(flap)
        parts.append(rod((0, height - 0.75, 0), tuple(top + (p0 - top) * 0.6), 0.012, 3, P.WOOD_DARK))
        parts.append(rod(tuple(top - np.array([0, 0.02, 0])), tuple(p0), 0.013, 3, P.WOOD_DARK))
    if tilt:
        m = T(0, height - 0.6, 0) @ RZ(tilt) @ T(0, -(height - 0.6), 0)
        canopy = kit.xf(canopy, m)
    return parts + canopy


def lounger(cushion=CUSHION, stripe=0x1F5FA8, towel=None):
    """A teak sun lounger with a striped cushion, its back raised; the head is toward -z."""
    parts = []
    for x in (-0.3, 0.3):
        parts.append(box(0.05, 0.06, 1.95, TEAK).at(x, 0.26, 0.0))
        for z in (-0.8, 0.8):
            parts.append(box(0.05, 0.26, 0.06, TEAK).at(x, 0, z))
    back = 0.62
    rise = math.radians(38)
    # The bed, then the back raised from its hinge.
    n = 6
    for i in range(n):
        z0 = -0.32 + 1.27 * i / n
        c = stripe if i % 2 else cushion
        parts.append(box(0.62, 0.09, 1.27 / n, c).at(0, 0.32, z0 + 1.27 / n / 2))
    for i in range(3):
        d0 = back * i / 3
        c = cushion if i % 2 else stripe
        seg = box(0.62, 0.09, back / 3, c).at(0, 0, -(d0 + back / 6))
        parts.append(seg.xf(T(0, 0.32, -0.32) @ RX(rise)))
    parts.append(rod((0, 0.3, -0.75), (0, 0.32 + math.sin(rise) * back * 0.7, -0.32 - math.cos(rise) * back * 0.7), 0.02, 4, TEAK))
    if towel is not None:
        parts.append(box(0.5, 0.05, 0.5, towel).at(0.02, 0.41, 0.55))
        parts.append(lathe([(0.0, -0.2), (0.07, -0.2), (0.07, 0.2), (0.0, 0.2)], 6, towel).xf(T(0.0, 0.48, 0.2) @ RZ(math.pi / 2)))
    return parts


def olive_tree(sc, height=2.4, seed=0):
    """An olive tree for a pot: a twisting grey trunk forking into boughs, clouds of silvery leaves."""
    rng = np.random.default_rng(seed)
    parts = []
    trunk = [(0, 0, 0), (0.06, height * 0.2, 0.03), (-0.05, height * 0.38, -0.04), (0.02, height * 0.52, 0.02)]
    parts.append(tube(trunk, [0.11, 0.09, 0.075, 0.06], 6, 0x8C8170, colours=[0x7A6F60, 0x8C8170, 0x93897A, 0x8C8170]))
    fork = np.array(trunk[-1])
    for i in range(4):
        az = TAU * i / 4 + rng.uniform(-0.4, 0.4)
        reach = height * rng.uniform(0.2, 0.3)
        tip = fork + np.array([math.cos(az) * reach, height * rng.uniform(0.2, 0.3), math.sin(az) * reach])
        mid = (fork + tip) / 2 + np.array([0, height * 0.06, 0])
        parts.append(tube([fork, mid, tip], [0.05, 0.035, 0.02], 4, 0x8C8170))
        parts.append(P.clumps(sc, tip, height * rng.uniform(0.2, 0.25), P.OLIVE, seed * 10 + i, 0.74))
    parts.append(P.clumps(sc, (fork[0], height * 0.88, fork[2]), height * 0.24, P.OLIVE, seed + 77, 0.78))
    # The sunlit top is paler.
    parts.append(P.clumps(sc, (fork[0] - 0.12, height * 0.99, fork[2] + 0.1), height * 0.15, P.OLIVE_LIGHT, seed + 78, 0.7))
    return parts


def lemon_tree(sc, height=1.9, seed=0):
    """A lemon tree for a pot: a slim trunk, a round glossy crown hung with lemons."""
    rng = np.random.default_rng(seed)
    parts = [tube([(0, 0, 0), (0.03, height * 0.3, 0.0), (0.0, height * 0.55, 0.02)], [0.05, 0.04, 0.035], 5, 0x7A5A3C)]
    centre = np.array([0.0, height * 0.72, 0.0])
    r = height * 0.3
    parts.append(P.clumps(sc, centre, r, P.LEAF, seed, 0.92))
    for i in range(4):
        d = rng.normal(size=3)
        d /= np.linalg.norm(d)
        d[1] = abs(d[1]) * 0.5
        parts.append(P.clumps(sc, centre + d * r * 0.62, r * 0.6, P.LEAF, seed + i + 1, 0.85))
    parts.append(P.clumps(sc, centre + np.array([-0.1, r * 0.62, 0.08]), r * 0.5, 0x6DAE4C, seed + 9, 0.7))
    for i in range(9):
        d = rng.normal(size=3)
        d /= np.linalg.norm(d)
        d[1] = -abs(d[1]) * 0.5 + 0.1
        p = centre + d * r * 1.02
        parts.append(ball(0.055, 6, 4, P.LEMON, "foliage", squash=1.25).xf(T(*p)).sway(0.06))
    return parts


def fan_palm(size=1.1, seed=0, fans=9):
    """A dwarf fan palm for a pot: stiff pleated fans on slender stalks."""
    rng = np.random.default_rng(seed)
    parts = [lathe([(0.1, 0.0), (0.13, 0.12), (0.09, 0.3), (0.0, 0.34)], 6, 0x7A5A3C)]
    for i in range(fans):
        az = TAU * i / fans + rng.uniform(-0.25, 0.25)
        tilt = rng.uniform(0.25, 1.05)
        reach = size * rng.uniform(0.75, 1.0)
        d = np.array([math.cos(az) * math.sin(tilt), math.cos(tilt), math.sin(az) * math.sin(tilt)])
        hub = np.array([0, 0.25, 0]) + d * reach * 0.62
        parts.append(tube([(0, 0.25, 0), hub], [0.018, 0.012], 3, 0x6F9A4A, "foliage").sway(lambda Q: 0.05 * np.clip(Q[:, 1] / size, 0, 1)))
        side = np.cross(d, [0, 1, 0])
        side /= np.linalg.norm(side)
        up = np.cross(side, d)
        blades = 9
        pts = [hub]
        for k in range(blades + 1):
            a = -1.25 + 2.5 * k / blades
            r = reach * 0.42 * (1.0 if k % 2 else 0.78)
            pts.append(hub + (d * math.cos(a) + side * math.sin(a)) * r + up * 0.05 * reach * (1 if k % 2 else -1))
        c = (P.PALM, P.PALM_OLD, 0x5FA044)[i % 3]
        fan = kit.Mesh(pts, [(0, k + 1, k + 2) for k in range(blades)], c, "foliage", False)
        parts.append(fan.sway(lambda Q, h=hub: 0.12 * np.clip(np.linalg.norm(Q - h, axis=1) / (reach * 0.42), 0, 1)))
    return parts


def snowboard(colours, length=1.52, shape="twin"):
    """A snowboard lying on y = 0 along x, base down: its outline with a sidecut, a painted topsheet with the
    game's slash across it, and bindings."""
    main, second, accent = colours
    half = length / 2

    def width(x):
        t = abs(x) / half
        w = 0.125 + 0.022 * t * t
        if t > 0.8:
            k = (t - 0.8) / 0.2
            if shape == "swallow" and x < 0:
                w *= math.sqrt(max(0.0, 1 - (k * 0.75) ** 2))
            else:
                w *= math.sqrt(max(0.0, 1 - k * k))
        return max(w, 0.004)

    xs = np.linspace(-half, half, 25)

    def zone(x0, x1, c, y):
        seg = [x for x in xs if x0 <= x <= x1]
        if seg[0] > x0:
            seg = [x0] + seg
        if seg[-1] < x1:
            seg = seg + [x1]
        outline = [(x, width(x)) for x in seg] + [(x, -width(x)) for x in reversed(seg)]
        return kit.plate(outline, y, c)

    outline = [(x, width(x)) for x in xs] + [(x, -width(x)) for x in reversed(xs)]
    parts = [slab(outline, 0.0, 0.012, 0x23252B, top=main)]
    parts.append(zone(-0.16, 0.2, second, 0.0135))
    parts.append(zone(0.02, 0.09, accent, 0.0145))
    for x in (-0.24, 0.26):
        parts.append(box(0.1, 0.035, 0.22, 0x23252B).at(x, 0.012, 0))
        parts.append(box(0.07, 0.11, 0.05, 0x33363D).at(x, 0.02, -0.1))
    return parts


def board_rack(boards):
    """A timber rack with snowboards standing in it, tails down, topsheets to the front (+z)."""
    n = len(boards)
    width = 0.36 * n + 0.3
    parts = [
        box(width, 0.08, 0.5, P.WOOD).at(0, 0.0, -0.05),
        box(width, 0.07, 0.07, P.WOOD).at(0, 0.95, -0.3),
        box(width + 0.1, 0.05, 0.12, P.WOOD_DARK).at(0, 1.02, -0.3),
    ]
    for x in (-width / 2 + 0.04, width / 2 - 0.04):
        parts.append(box(0.07, 1.0, 0.07, P.WOOD).at(x, 0.0, -0.3))
        parts.append(rod((x, 0.06, 0.18), (x, 0.9, -0.28), 0.025, 4, P.WOOD_DARK))
    for i, b in enumerate(boards):
        x = -width / 2 + 0.33 + 0.36 * i
        lean = 0.2
        m = T(x, 0.08, 0.0) @ RX(-lean) @ T(0, b["length"] / 2, 0) @ RZ(math.pi / 2) @ RX(math.pi / 2)
        parts += kit.xf(snowboard(b["colours"], b["length"], b.get("shape", "twin")), m)
    return parts


def jetski(colours=(0x1E9BB0, 0xF7F1E5, 0xE8A72C)):
    """A sit-down jetski, its bow toward +x, resting with its keel on y = 0."""
    main, second, accent = colours
    half = 1.6

    def side(sign):
        def point(u, v):
            x = -half + 2 * half * u
            fore = max(0.0, x / half) ** 2.0
            aft = max(0.0, -x / half) ** 4
            beam = 0.58 * (1 - fore * 0.92) * (1 - 0.12 * aft)
            keel = 0.22 * fore
            deck = 0.62 + 0.1 * fore - 0.04 * aft
            # v: 0 the keel, 0.45 the chine, 0.75 the bumper, 1 the middle of the deck.
            if v < 0.45:
                k = v / 0.45
                return (x, keel + 0.2 * k, sign * beam * 0.85 * k)
            if v < 0.75:
                k = (v - 0.45) / 0.3
                return (x, keel + 0.2 + (deck - 0.2 - keel) * k * 0.82, sign * beam * (0.85 + 0.15 * math.sin(k * math.pi / 2)))
            k = (v - 0.75) / 0.25
            return (x, deck - (deck - keel - 0.2) * 0.18 * (1 - k) + 0.07 * k, sign * beam * (1 - k) ** 0.8)

        m = grid(12, 8, point, main, "solid", True)
        v = np.repeat(np.arange(9) / 8, 13)
        m.C[v < 0.47] = kit.srgb(second)
        m.C[(v > 0.6) & (v < 0.78)] = kit.srgb(0x23252B)
        return m if sign > 0 else m.flipped()

    parts = [side(1), side(-1)]
    # The stern's flat.
    parts.append(quad((-half, 0.0, -0.5), (-half, 0.0, 0.5), (-half, 0.62, 0.5), (-half, 0.62, -0.5), second).clean())
    # Seat, hood, bars.
    seat = lathe([(0.0, -0.75), (0.17, -0.7), (0.2, 0.0), (0.17, 0.55), (0.0, 0.62)], 8, 0x2B2D33)
    parts.append(seat.xf(T(-0.45, 0.66, 0) @ RZ(-math.pi / 2) @ S(1, 1, 1.05)))
    hood = blob(0.4, 5, main, "solid", 0.1, 0.55).xf(T(0.55, 0.72, 0) @ S(1.5, 1, 0.95))
    hood.C[hood.P[:, 0] > 0.9] = kit.srgb(accent)
    parts.append(hood)
    parts.append(rod((0.42, 0.85, 0), (0.3, 1.08, 0), 0.04, 5, 0x2B2D33))
    parts.append(rod((0.3, 1.08, -0.34), (0.3, 1.08, 0.34), 0.022, 5, 0x2B2D33))
    for z in (-0.3, 0.3):
        parts.append(rod((0.3, 1.08, z - 0.06 * np.sign(z)), (0.3, 1.08, z + 0.07 * np.sign(z)), 0.03, 5, accent))
    return parts


def trailer():
    """A boat trailer: a galvanized frame on two wheels with bunks and a drawbar, its tongue toward +x; a hull
    resting on it sits with its keel at y = 0.46."""
    parts = []
    for z in (-0.5, 0.5):
        parts.append(box(3.0, 0.07, 0.07, STEEL).at(-0.2, 0.34, z))
        parts.append(box(2.2, 0.07, 0.14, 0x3A3F47).at(-0.3, 0.44, z * 0.72))
        wheel = lathe([(0.12, -0.08), (0.27, -0.08), (0.3, -0.04), (0.3, 0.04), (0.27, 0.08), (0.12, 0.08)], 10, RUBBER)
        hub = lathe([(0.0, -0.085), (0.13, -0.085), (0.13, 0.085), (0.0, 0.085)], 8, STEEL)
        for part in (wheel, hub):
            parts.append(part.xf(T(-0.5, 0.3, z * 1.42) @ RX(math.pi / 2)))
        parts.append(box(0.5, 0.05, 0.24, STEEL).at(-0.5, 0.62, z * 1.42))
    for x in (-1.6, -0.5, 0.8):
        parts.append(box(0.07, 0.07, 1.5 if x == -0.5 else 1.07, STEEL).at(x, 0.34, 0))
    parts.append(tube([(1.3, 0.37, -0.5), (2.5, 0.37, 0)], 0.04, 4, STEEL))
    parts.append(tube([(1.3, 0.37, 0.5), (2.5, 0.37, 0)], 0.04, 4, STEEL))
    parts.append(rod((2.5, 0.37, 0), (3.0, 0.37, 0), 0.04, 4, STEEL))
    parts.append(rod((2.6, 0.02, 0), (2.6, 0.7, 0), 0.03, 4, STEEL))
    parts.append(lathe([(0.0, -0.03), (0.09, -0.03), (0.09, 0.03), (0.0, 0.03)], 8, RUBBER).xf(T(2.6, 0.09, 0.05) @ RX(math.pi / 2)))
    parts.append(box(0.1, 0.5, 0.1, STEEL).at(1.75, 0.37, 0))
    return parts


def gull(pose="stand"):
    """A gull standing, facing +x: white with grey folded wings, black wingtips, a yellow bill."""
    body = lathe([(0.0, -0.2), (0.07, -0.15), (0.095, 0.0), (0.08, 0.12), (0.045, 0.2)], 7, 0xFFFFFF)
    parts = [body.xf(T(0, 0.2, 0) @ RZ(-math.pi / 2 + 0.25) @ S(1, 1, 0.9))]
    head = np.array([0.17, 0.33, 0.0])
    parts.append(tube([(0.11, 0.24, 0), (0.15, 0.29, 0), tuple(head)], [0.05, 0.045, 0.04], 6, 0xFFFFFF))
    parts.append(ball(0.052, 7, 5, 0xFFFFFF).at(*head))
    parts.append(tube([tuple(head + np.array([0.04, -0.005, 0])), tuple(head + np.array([0.1, -0.02, 0])), tuple(head + np.array([0.125, -0.035, 0]))], [0.02, 0.014, 0.004], 4, 0xF2B632))
    for sz in (-1, 1):
        parts.append(ball(0.011, 4, 3, 0x1D1B17).at(head[0] + 0.028, head[1] + 0.012, sz * 0.04))
        wing = grid(3, 1, lambda u, v, s=sz: (0.08 - 0.34 * u, 0.25 - 0.07 * u + (v - 0.5) * 0.12 * (1 - u * 0.75), s * (0.09 - 0.05 * u)), 0x9AA6B4, "solid", True)
        wing.C[wing.P[:, 0] < -0.17] = kit.srgb(0x24262B)
        parts.append(wing if sz > 0 else wing.flipped())
        parts.append(rod((0.0, 0.1, sz * 0.035), (0.01, 0.0, sz * 0.035), 0.008, 3, 0xF2B632))
        parts.append(tri((-0.01, 0.002, sz * 0.035 - 0.025), (0.06, 0.002, sz * 0.035), (-0.01, 0.002, sz * 0.035 + 0.025), 0xF2B632))
    parts.append(tri((-0.2, 0.2, -0.04), (-0.3, 0.17, 0.0), (-0.2, 0.2, 0.04), 0xFFFFFF))
    return parts


def cat(colour=0xE8923A, second=0xF7EAD2):
    """A cat sitting upright, facing +x, its tail curled round on the ground (the tail's sway weight moves its
    tip)."""
    parts = [
        lathe([(0.0, 0.0), (0.12, 0.01), (0.13, 0.1), (0.1, 0.24), (0.07, 0.32), (0.0, 0.36)], 8, colour).xf(T(0, 0, 0) @ S(1.15, 1, 0.95)),
        blob(0.085, 3, colour, "solid", 0.05, 0.92, 1).at(0.05, 0.4, 0),
        lathe([(0.0, 0.05), (0.07, 0.07), (0.06, 0.2), (0.0, 0.24)], 6, second).xf(T(0.085, 0.02, 0) @ S(0.6, 1, 0.9)),
    ]
    for sz in (-1, 1):
        parts.append(kit.Mesh([(0.03, 0.46, sz * 0.03), (0.07, 0.46, sz * 0.075), (0.05, 0.56, sz * 0.06), (0.02, 0.46, sz * 0.07)], [(0, 1, 2), (1, 3, 2), (3, 0, 2)], colour).outward())
        parts.append(rod((0.1, 0.0, sz * 0.05), (0.1, 0.16, sz * 0.045), 0.026, 5, second))
        parts.append(ball(0.012, 4, 3, 0x1D1B17).at(0.125, 0.42, sz * 0.035))
    parts.append(tri((0.135, 0.39, -0.012), (0.145, 0.375, 0.0), (0.135, 0.39, 0.012), 0xD9707A))
    tail = [(-0.12, 0.03, 0.0), (-0.2, 0.03, 0.08), (-0.16, 0.03, 0.2), (-0.02, 0.03, 0.24), (0.1, 0.04, 0.2)]
    t = tube(tail, [0.03, 0.028, 0.026, 0.024, 0.016], 5, colour)
    t.W = np.clip((t.P[:, 0] + 0.1) / 0.2, 0, 1) * np.clip(t.P[:, 2] / 0.2, 0, 1) * 0.25
    return parts + [t.as_("foliage")]


def ceiling_fan(span=1.5):
    """A ceiling fan hanging from y = 0: the rod and motor (still), and the blades (to spin about y)."""
    still = [rod((0, 0, 0), (0, -0.4, 0), 0.02, 4, P.IRON), lathe([(0.0, -0.52), (0.09, -0.5), (0.11, -0.44), (0.09, -0.4), (0.0, -0.39)], 8, P.BRASS)]
    blades = []
    for i in range(4):
        blade = box(span / 2 - 0.1, 0.012, 0.14, P.WOOD).at(span / 4 + 0.08, -0.47, 0).xf(RX(0.12))
        blades.append(blade.xf(RY(TAU * i / 4)))
        blades.append(box(0.12, 0.014, 0.05, P.BRASS).at(0.1, -0.47, 0).xf(RY(TAU * i / 4)))
    return still, blades


def bar_stool():
    return [
        lathe([(0.19, 0.0), (0.19, 0.03), (0.19, 0.03), (0.03, 0.06), (0.025, 0.7), (0.06, 0.74)], 8, P.IRON),
        lathe([(0.17, 0.74), (0.19, 0.76), (0.19, 0.8), (0.19, 0.8), (0.0, 0.82)], 10, 0xB8452E),
        lathe([(0.15, 0.28), (0.16, 0.29), (0.15, 0.3)], 8, P.BRASS),
    ]


def hedge(sc, length, height=0.5, depth=0.5, seed=0):
    """A clipped hedge in a stone trough, along x."""
    parts = [box(length, 0.34, depth, P.STONE).at(0, 0, 0), box(length + 0.06, 0.05, depth + 0.06, P.STONE_LIGHT).at(0, 0.34, 0)]
    n = max(2, round(length / 0.45))
    for i in range(n):
        x = -length / 2 + length * (i + 0.5) / n
        parts.append((P.clump(sc, P.LEAF, i % 3, 1, 0.03), T(x, 0.39 + height * 0.5, 0) @ S(0.3, height * 0.6, depth * 0.5)))
    return parts
