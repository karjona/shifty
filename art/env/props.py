"""The mountain's chairlift, race furniture and people: lift towers and
stations, chairs (empty, and with two riders on), the finish gantry,
checkpoint gate panels, feather flags, sponsor boards, fence posts, and
the figures of the crowd.

Masks, in the game's shaders: on what the snow settles on, as on the rocks
(`u` a snow cap's height, `v` 1 on a cap); on cloth (flags, gate panels),
`u` is how far a corner is from what holds it (it flaps by it) and `v` is
0; on the figures, `u` is how much a corner moves with a raised arm and
`v` how much with the body's bounce. Alpha 0 marks what takes a colour of
its own in the game: a figure's jacket and hat, a flag's or a board's cloth.
"""

import math

from meshlib import Mesh, add, lerp, norm, rng, scale, srgb
from rocks import pillow

STEEL = srgb(0xA9B2BC)
STEEL_DARK = srgb(0x6F7882)
CONCRETE = srgb(0xB9B5AC)
NAVY = srgb(0x1F3B6E)
WHITE = srgb(0xF2F0EA)
GLASS = srgb(0x2D3F5C)
RUBBER = srgb(0x2E3036)
SEAT = srgb(0x3C4B5E)
SKIN = srgb(0xE0B090)
SKIN_DARK = srgb(0x9A6A4A)
TROUSERS = srgb(0x3A3F4C)
BOOT = srgb(0x2A2A30)
ORANGE = srgb(0xE8612C)
TINT = (1.0, 1.0, 1.0)
LAMP = srgb(0xFFF1D0)
AMBER = srgb(0xFFB02E)
TOP_DECK = srgb(0x8A7458)
CAT_RED = srgb(0xC8322A)


def cap_on(m, lo, hi, thick=0.25):
    """A snow cap on the top of a box."""
    x0, _, z0 = lo
    x1, y1, z1 = hi
    pillow(m, [(x0, y1, z1), (x1, y1, z1), (x1, y1, z0), (x0, y1, z0)], thick)


def tower(height=14.0):
    """A lift tower: a tapered tube on a concrete foot, a crossarm with a sheave train at each end, a ladder up its back."""
    m = Mesh()
    m.box((-0.9, -3.0, -0.9), (0.9, 0.35, 0.9), CONCRETE, faces="xXzZY")
    rings = [((0, 0.3, 0), 0.48, STEEL_DARK), ((0, height * 0.5, 0), 0.4, STEEL), ((0, height, 0), 0.32, STEEL)]
    m.tube(rings, STEEL, 8)
    # The crossarm, a box girder, and the walkway rail on it.
    arm = 3.1
    m.box((-arm, height - 0.25, -0.22), (arm, height + 0.2, 0.22), STEEL, faces="xXyYzZ")
    cap_on(m, (-arm, height - 0.25, -0.22), (arm, height + 0.2, 0.22), 0.16)
    for side in (-1, 1):
        x = side * 2.6
        # The sheave train: a beam along the line, four wheels under it.
        m.box((x - 0.12, height - 0.75, -1.5), (x + 0.12, height - 0.5, 1.5), STEEL_DARK, faces="xXyYzZ")
        m.box((x - 0.05, height - 0.5, -0.1), (x + 0.05, height - 0.25, 0.1), STEEL_DARK, faces="xXzZ")
        for k in range(4):
            z = -1.2 + k * 0.8
            wheel = Mesh()
            wheel.tube([((0, -0.06, 0), 0.24), ((0, 0.06, 0), 0.24)], RUBBER, 8, cap=True)
            for i in range(len(wheel.pos)):
                p, n = wheel.pos[i], wheel.nor[i]
                wheel.pos[i] = (p[1], p[0], p[2])
                wheel.nor[i] = (n[1], n[0], n[2])
            flipped = Mesh()
            for i in range(0, len(wheel.pos), 3):
                flipped.tri(wheel.pos[i], wheel.pos[i + 2], wheel.pos[i + 1], RUBBER)
            m.merge(flipped, at=(x, height - 0.95, z))
    # The ladder: two rails.
    for dx in (-0.2, 0.2):
        m.box((dx - 0.03, 0.4, -0.62), (dx + 0.03, height - 0.3, -0.56), STEEL_DARK, faces="xXzZ")
    return m


def station():
    """A lift station: a housing on two portal legs over the bullwheel, an operator's cabin, and a ramp of snow fences."""
    m = Mesh()
    m.box((-4.2, -3.0, -6.5), (4.2, 0.3, 6.5), CONCRETE, faces="xXzZY")
    for z in (-2.5, 3.0):
        for x in (-2.6, 2.6):
            m.box((x - 0.3, 0.3, z - 0.3), (x + 0.3, 4.6, z + 0.3), STEEL, faces="xXzZ")
        m.box((-2.9, 4.3, z - 0.3), (2.9, 4.8, z + 0.3), STEEL, faces="xXyYzZ")
    # The housing: a long box with sloped shoulders, a white band along it.
    lo, hi = (-3.5, 4.8, -5.2), (3.5, 6.3, 6.6)
    m.box(lo, (hi[0], 5.6, hi[2]), NAVY, faces="xXyzZ")
    m.box((lo[0], 5.6, lo[2]), (hi[0], 5.85, hi[2]), WHITE, faces="xXzZ")
    top = Mesh()
    sh = 0.9
    a = [(-3.5, 5.85, 6.6), (3.5, 5.85, 6.6), (3.5, 5.85, -5.2), (-3.5, 5.85, -5.2)]
    b = [(-3.5 + sh, 6.6, 6.6 - sh), (3.5 - sh, 6.6, 6.6 - sh), (3.5 - sh, 6.6, -5.2 + sh), (-3.5 + sh, 6.6, -5.2 + sh)]
    for i in range(4):
        j = (i + 1) % 4
        top.quad(a[i], a[j], b[j], b[i], NAVY)
    top.quad(b[0], b[1], b[2], b[3], scale(NAVY, 1.15))
    pillow(top, b, 0.4)
    m.merge(top)
    # The bullwheel under the housing's open end, on its shaft.
    m.tube([((0, 4.0, 4.0), 0.2), ((0, 4.8, 4.0), 0.2)], STEEL_DARK, 6)
    m.tube([((0, 3.85, 4.0), 2.6, STEEL_DARK), ((0, 4.05, 4.0), 2.6, STEEL)], STEEL, 14, cap=True)
    # The operator's cabin.
    c0, c1 = (-4.0, 0.3, -6.3), (-1.2, 2.9, -3.6)
    m.box(c0, c1, WHITE, faces="xXzZ")
    m.box((c0[0] - 0.2, c1[1], c0[2] - 0.2), (c1[0] + 0.2, c1[1] + 0.2, c1[2] + 0.2), NAVY, faces="xXyYzZ")
    cap_on(m, (c0[0] - 0.2, c1[1], c0[2] - 0.2), (c1[0] + 0.2, c1[1] + 0.2, c1[2] + 0.2), 0.3)
    m.quad((c1[0] + 0.02, 1.3, c0[2] + 0.3), (c1[0] + 0.02, 1.3, c1[2] - 0.3), (c1[0] + 0.02, 2.5, c1[2] - 0.3), (c1[0] + 0.02, 2.5, c0[2] + 0.3), GLASS, (0.0, 0.0), (1, 0, 0), alpha=0.0)
    m.quad((c0[0] + 0.3, 1.3, c1[2] + 0.02), (c1[0] - 0.3, 1.3, c1[2] + 0.02), (c1[0] - 0.3, 2.5, c1[2] + 0.02), (c0[0] + 0.3, 2.5, c1[2] + 0.02), GLASS, (0.0, 0.0), (0, 0, 1), alpha=0.0)
    return m


def figure(m, at, jacket, raised=0.0, seated=False, skin=SKIN, hat=True, board=None):
    """A person about 1.75 m tall facing +z: legs, a jacket, a head, arms down or `raised` (0-1)."""
    x, y, z = at
    hip = 0.5 if seated else 0.9
    tint = 0.0
    # Legs.
    for side in (-1, 1):
        lx = x + side * 0.12
        if seated:
            m.box((lx - 0.09, y + hip - 0.1, z), (lx + 0.09, y + hip + 0.08, z + 0.45), TROUSERS, (0.0, 0.3), faces="xXyYZ")
            m.box((lx - 0.08, y + 0.05, z + 0.36), (lx + 0.08, y + hip, z + 0.5), TROUSERS, (0.0, 0.3), faces="xXzZ")
            m.box((lx - 0.09, y - 0.02, z + 0.34), (lx + 0.09, y + 0.1, z + 0.62), BOOT, (0.0, 0.3), faces="xXyYzZ")
        else:
            m.box((lx - 0.09, y + 0.1, z - 0.09), (lx + 0.09, y + hip, z + 0.09), TROUSERS, (0.0, 0.2), faces="xXzZ")
            m.box((lx - 0.1, y, z - 0.1), (lx + 0.1, y + 0.12, z + 0.2), BOOT, (0.0, 0.0), faces="xXyYzZ")
    # The jacket: wider at the shoulders.
    part = Mesh()
    part.tube([((0, hip - 0.05, 0), 0.2), ((0, hip + 0.3, 0), 0.21), ((0, hip + 0.58, 0), 0.25), ((0, hip + 0.64, 0), 0.12)], TINT, 6)
    for i in range(len(part.pos)):
        p = part.pos[i]
        part.pos[i] = (p[0] * 1.1, p[1], p[2] * 0.72)
        part.uv[i] = (0.0, 0.5 + 0.5 * (p[1] - hip) / 0.64)
        part.alpha[i] = tint
    m.merge(part, at=(x, y, z))
    # The head, and a hat on it.
    head = Mesh()
    hy = hip + 0.8
    head.tube([((0, hy - 0.13, 0), 0.07), ((0, hy - 0.06, 0), 0.115), ((0, hy + 0.05, 0), 0.115), ((0, hy + 0.12, 0), 0.06)], skin, 6, cap=True)
    for i in range(len(head.pos)):
        head.uv[i] = (0.0, 1.0)
    if hat:
        cap = Mesh()
        cap.tube([((0, hy + 0.03, 0), 0.125), ((0, hy + 0.13, 0), 0.1), ((0, hy + 0.19, 0), 0.03)], TINT, 6, cap=True)
        for i in range(len(cap.pos)):
            cap.uv[i] = (0.0, 1.0)
            cap.alpha[i] = tint
            cap.col[i] = (0.75, 0.75, 0.75)
        head.merge(cap)
    m.merge(head, at=(x, y, z))
    # Arms: down at the sides, or up over the head.
    for side in (-1, 1):
        sx = x + side * 0.27
        sy = y + hip + 0.56
        if raised > 0:
            hand = (sx + side * 0.18 * raised, sy + 0.55 * raised, z + 0.05)
        elif seated:
            hand = (sx, sy - 0.3, z + 0.3)
        else:
            hand = (sx + side * 0.04, sy - 0.55, z + 0.03)
        arm = Mesh()
        steps = 2
        for k in range(steps):
            a = (lerp(sx, hand[0], k / steps), lerp(sy, hand[1], k / steps), lerp(z, hand[2], k / steps))
            b = (lerp(sx, hand[0], (k + 1) / steps), lerp(sy, hand[1], (k + 1) / steps), lerp(z, hand[2], (k + 1) / steps))
            w = 0.07
            lo = (min(a[0], b[0]) - w, min(a[1], b[1]), min(a[2], b[2]) - w)
            hi = (max(a[0], b[0]) + w, max(a[1], b[1]), max(a[2], b[2]) + w)
            arm.box(lo, hi, TINT, (((k + 1) / steps) if raised > 0 else 0.0, 0.9), faces="xXyYzZ")
        for i in range(len(arm.pos)):
            arm.alpha[i] = tint
        mit = Mesh()
        mit.box((hand[0] - 0.07, hand[1] - 0.05, hand[2] - 0.07), (hand[0] + 0.07, hand[1] + 0.12, hand[2] + 0.07), BOOT, (1.0 if raised > 0 else 0.0, 0.9), faces="xXyYzZ")
        m.merge(arm)
        m.merge(mit)
    if board:
        m.box((x - 0.8, y - 0.06, z + 0.3), (x + 0.8, y - 0.02, z + 0.62), board, (0.0, 0.0), faces="xXyYzZ")


def spectator(seed, raised, hat=True, skin=SKIN):
    m = Mesh()
    figure(m, (0.0, 0.0, 0.0), TINT, raised, skin=skin, hat=hat)
    return m


def chair(riders=0):
    """A chair hanging from its grip (the origin, on the cable): a hanger
    cranked back over a wide bench, a tall padded back and a hood over it in
    the game's colour, a footrest; `riders` on it, a board or skis hanging
    from their boots."""
    m = Mesh()
    # The grip and the hanger: down, back behind the seat, down to the bench.
    m.box((-0.14, -0.14, -0.3), (0.14, 0.12, 0.3), STEEL_DARK, faces="xXyYzZ")
    m.box((-0.07, -1.3, -0.07), (0.07, -0.1, 0.07), STEEL, faces="xXzZ")
    m.box((-0.07, -1.4, -0.75), (0.07, -1.26, 0.07), STEEL, faces="xXyYzZ")
    m.box((-0.07, -2.3, -0.78), (0.07, -1.3, -0.64), STEEL, faces="xXzZ")
    # The bench and its back.
    m.box((-1.15, -3.0, -0.6), (1.15, -2.86, 0.3), SEAT, faces="xXyYzZ")
    n0 = len(m.pos)
    m.box((-1.15, -2.86, -0.7), (1.15, -2.05, -0.58), TINT, faces="xXyYzZ")
    # The hood: a canopy over the riders' heads, in the game's colour.
    hood = [(-1.2, -2.05, -0.72), (1.2, -2.05, -0.72), (1.2, -1.62, -0.3), (-1.2, -1.62, -0.3)]
    m.quad(*hood, TINT, (0.0, 0.0), (0.0, 0.7, -0.7))
    m.quad(*hood[::-1], scale(TINT, 0.7), (0.0, 0.0), (0.0, -0.7, 0.7))
    front = [(-1.2, -1.62, -0.3), (1.2, -1.62, -0.3), (1.2, -1.7, 0.35), (-1.2, -1.7, 0.35)]
    m.quad(*front, TINT, (0.0, 0.0), (0.0, 1.0, 0.1))
    m.quad(*front[::-1], scale(TINT, 0.7), (0.0, 0.0), (0.0, -1.0, -0.1))
    for i in range(n0, len(m.pos)):
        m.alpha[i] = 0.0
    # The frame: side arms, and the footrest hanging in front.
    for x in (-1.17, 1.17):
        m.box((x - 0.04, -3.05, -0.7), (x + 0.04, -1.62, -0.62), STEEL, faces="xXyYzZ")
        m.box((x - 0.04, -2.62, -0.62), (x + 0.04, -2.54, 0.55), STEEL, faces="xXyYzZ")
        m.box((x - 0.04, -3.6, 0.5), (x + 0.04, -2.54, 0.58), STEEL, faces="xXzZ")
    m.box((-1.17, -3.64, 0.42), (1.17, -3.56, 0.78), STEEL, faces="xXyYzZ")
    m.box((-1.17, -2.62, 0.5), (1.17, -2.54, 0.58), STEEL, faces="xXyYzZ")
    if riders:
        jackets = [srgb(0xD8452E), srgb(0x2E7FBF), srgb(0xE8B62C), srgb(0x3FAE6A)]
        gear = [srgb(0x3FAE6A), srgb(0xE86A2C), srgb(0xD8D2C4)]
        for k in range(riders):
            part = Mesh()
            figure(part, (0.0, 0.0, 0.0), TINT, seated=True, skin=SKIN if k % 2 else SKIN_DARK)
            for i in range(len(part.pos)):
                if part.alpha[i] < 0.5:
                    part.col[i] = jackets[k % 4] if part.col[i][0] > 0.9 else scale(jackets[(k + 1) % 4], 0.9)
                    part.alpha[i] = 1.0
                part.uv[i] = (0.0, 0.0)
            x = (k - (riders - 1) / 2) * 0.72
            m.merge(part, at=(x, -3.42, -0.42))
            if k % 2 == 0:
                # A board across both boots.
                m.box((x - 0.7, -3.52, 0.02), (x + 0.7, -3.47, 0.34), gear[k % 3], faces="xXyYzZ")
            else:
                # Skis, tips up.
                for dx in (-0.12, 0.12):
                    m.box((x + dx - 0.05, -3.52, -0.5), (x + dx + 0.05, -3.48, 1.1), gear[k % 3], faces="xXyYzZ")
    return m


def truss(m, a, b, wide, col, bays):
    """A square lattice girder from `a` to `b` (upright, or level along x)."""
    upright = abs(b[1] - a[1]) > abs(b[0] - a[0])
    h = wide / 2
    t = 0.05
    for sx in (-h, h):
        for sz in (-h, h):
            if upright:
                m.box((a[0] + sx - t, a[1], a[2] + sz - t), (a[0] + sx + t, b[1], a[2] + sz + t), col, faces="xXzZ")
            else:
                m.box((a[0], a[1] + sx - t, a[2] + sz - t), (b[0], a[1] + sx + t, a[2] + sz + t), col, faces="yYzZ")
    for k in range(bays + 1):
        f = k / bays
        if upright:
            y = lerp(a[1], b[1], f)
            m.box((a[0] - h, y - t, a[2] - h), (a[0] + h, y + t, a[2] + h), col, faces="xXzZ")
        else:
            x = lerp(a[0], b[0], f)
            m.box((x - t, a[1] - h, a[2] - h), (x + t, a[1] + h, a[2] + h), col, faces="xXzZ")


def floodlight(m, at, aim=(0.0, -0.5, 1.0)):
    """A floodlight head: a dark box with a lit face (glass) looking along `aim`."""
    x, y, z = at
    m.box((x - 0.28, y - 0.2, z - 0.14), (x + 0.28, y + 0.2, z + 0.14), RUBBER, faces="xXyYz")
    m.quad((x - 0.24, y - 0.16, z + 0.145), (x + 0.24, y - 0.16, z + 0.145), (x + 0.24, y + 0.16, z + 0.145), (x - 0.24, y + 0.16, z + 0.145), LAMP, (0.0, 0.0), (0, 0, 1), alpha=0.0)


def gantry_leg(clear=5.6):
    """A leg of the finish gantry: a lattice mast on a weighted foot, floodlights on its head."""
    m = Mesh()
    m.box((-0.7, -1.5, -0.7), (0.7, 0.35, 0.7), CONCRETE, faces="xXzZY")
    cap_on(m, (-0.7, -1.5, -0.7), (0.7, 0.35, 0.7), 0.2)
    truss(m, (0.0, 0.35, 0.0), (0.0, clear + 1.0, 0.0), 0.5, STEEL, 8)
    floodlight(m, (0.0, clear + 1.35, 0.3))
    back = Mesh()
    floodlight(back, (0.0, clear + 1.35, 0.3))
    m.merge(back, turn=math.pi)
    return m


def lamp_post(height=6.5):
    """A floodlight mast for the finish area: a slim pole on a foot, a crossbar with two heads."""
    m = Mesh()
    m.box((-0.3, -1.0, -0.3), (0.3, 0.2, 0.3), CONCRETE, faces="xXzZY")
    m.tube([((0, 0.2, 0), 0.09, STEEL_DARK), ((0, height, 0), 0.06, STEEL)], STEEL, 6)
    m.box((-0.8, height - 0.06, -0.06), (0.8, height + 0.06, 0.06), STEEL_DARK, faces="xXyYzZ")
    for x in (-0.55, 0.55):
        floodlight(m, (x, height + 0.26, 0.1))
    return m


def grandstand(width=12.0, tiers=5):
    """A grandstand: tiers of benches on a steel frame, a rail along its front and sides, a back wall in the game's colour. Its front to +z."""
    m = Mesh()
    rise, run = 0.45, 0.85
    hw = width / 2
    for k in range(tiers):
        y, z = 0.5 + k * rise, -k * run
        m.box((-hw, y - 0.08, z - run), (hw, y, z), TOP_DECK, faces="xXyYzZ")
        m.box((-hw, y, z - run + 0.1), (hw, y + 0.3, z - run + 0.42), SEAT, faces="xXyYzZ")
    top = 0.5 + tiers * rise
    back = -tiers * run
    # The frame under it, and the legs down into the slope.
    for x in (-hw + 0.1, -hw / 3, hw / 3, hw - 0.1):
        m.box((x - 0.06, -3.0, back - 0.06), (x + 0.06, top + 1.6, back + 0.06), STEEL, faces="xXzZ")
        m.box((x - 0.06, -3.0, -0.12), (x + 0.06, 0.5, 0.0), STEEL, faces="xXzZ")
    # The back wall and the side screens.
    wall = [(-hw, top - 0.2, back), (hw, top - 0.2, back), (hw, top + 1.6, back), (-hw, top + 1.6, back)]
    n0 = len(m.pos)
    m.quad(*wall, TINT, (0.0, 0.0), (0, 0, 1))
    m.quad(*wall[::-1], TINT, (0.0, 0.0), (0, 0, -1))
    for i in range(n0, len(m.pos)):
        m.alpha[i] = 0.0
    for x in (-hw, hw):
        side = [(x, 0.5, 0.0), (x, top, back), (x, top + 1.1, back), (x, 1.5, 0.0)]
        m.quad(*side, WHITE, (0.0, 0.0), (1 if x > 0 else -1, 0, 0))
        m.quad(*side[::-1], WHITE, (0.0, 0.0), (-1 if x > 0 else 1, 0, 0))
    m.box((-hw, 1.4, 0.0), (hw, 1.48, 0.06), STEEL, faces="xXyYzZ")
    cap_on(m, (-hw, top + 1.5, back - 0.05), (hw, top + 1.6, back + 0.05), 0.12)
    return m


def timing_board():
    """The timing board: a dark panel of lit figures on two posts, a band in the game's colour over it."""
    m = Mesh()
    for x in (-2.2, 2.2):
        m.box((x - 0.12, -1.5, -0.12), (x + 0.12, 5.9, 0.12), STEEL_DARK, faces="xXzZ")
    m.box((-2.8, 3.0, -0.14), (2.8, 5.6, 0.14), RUBBER, faces="xXyYzZ")
    n0 = len(m.pos)
    m.box((-2.8, 5.6, -0.16), (2.8, 6.2, 0.16), TINT, faces="xXyYzZ")
    for i in range(n0, len(m.pos)):
        m.alpha[i] = 0.0
    cap_on(m, (-2.8, 5.6, -0.16), (2.8, 6.2, 0.16), 0.14)
    # Rows of figures: a place, a name, a time.
    r = rng(5)
    for row in range(5):
        y = 5.2 - row * 0.48
        cells = [(-2.55, 0.22), (-2.15, 1.5 + r.random() * 0.8), (1.0, 1.45)]
        for x, w in cells:
            for front in (1, -1):
                quad = [(x, y - 0.14, 0.145 * front), (x + w, y - 0.14, 0.145 * front), (x + w, y + 0.14, 0.145 * front), (x, y + 0.14, 0.145 * front)]
                m.quad(*(quad if front > 0 else quad[::-1]), AMBER if row else LAMP, (0.0, 0.0), (0, 0, front))
    return m


def snowcat():
    """A snowcat: wide tracks, a red body with a glazed cab, a blade in front and a tiller behind. Its front to +z."""
    m = Mesh()
    for x in (-1.75, 1.75):
        # A track: a long flat loop, raked at both ends.
        lo, hi = (x - 0.55, 0.0, -2.4), (x + 0.55, 0.75, 2.4)
        m.box((lo[0], 0.0, -1.9), (hi[0], 0.75, 1.9), RUBBER, faces="xXyY")
        for end in (1, -1):
            z0, z1 = end * 1.9, end * 2.5
            quad = [(lo[0], 0.0, z0), (hi[0], 0.0, z0), (hi[0], 0.45, z1), (lo[0], 0.45, z1)]
            m.quad(*quad, RUBBER, (0.0, 0.0), (0, -0.5, end))
            quad = [(lo[0], 0.75, z0), (hi[0], 0.75, z0), (hi[0], 0.45, z1), (lo[0], 0.45, z1)]
            m.quad(*quad, RUBBER, (0.0, 0.0), (0, 0.5, end))
            for sx in (lo[0], hi[0]):
                m.tri((sx, 0.0, z0), (sx, 0.75, z0), (sx, 0.45, z1), RUBBER, (0.0, 0.0), (1 if sx > x else -1, 0, 0))
    # The body between and over the tracks, and the cab on it.
    m.box((-1.25, 0.45, -2.2), (1.25, 1.25, 2.1), CAT_RED, faces="xXyYzZ")
    m.box((-1.1, 1.25, -0.3), (1.1, 2.55, 1.7), CAT_RED, faces="xXzZ")
    m.box((-1.18, 2.55, -0.38), (1.18, 2.68, 1.78), WHITE, faces="xXyYzZ")
    cap_on(m, (-1.18, 2.55, -0.38), (1.18, 2.68, 1.78), 0.18)
    cap_on(m, (-1.25, 0.45, -2.2), (1.25, 1.25, -0.3), 0.14)
    glass = [
        ((-0.95, 1.55, 1.71), (0.95, 1.55, 1.71), (0.95, 2.4, 1.71), (-0.95, 2.4, 1.71), (0, 0, 1)),
        ((1.11, 1.55, 1.5), (1.11, 1.55, -0.1), (1.11, 2.4, -0.1), (1.11, 2.4, 1.5), (1, 0, 0)),
        ((-1.11, 1.55, -0.1), (-1.11, 1.55, 1.5), (-1.11, 2.4, 1.5), (-1.11, 2.4, -0.1), (-1, 0, 0)),
    ]
    for a, b, c, d, n in glass:
        m.quad(a, b, c, d, GLASS, (0.0, 0.0), n, alpha=0.0)
    for x in (-0.8, 0.8):
        floodlight(m, (x, 2.9, 1.5))
    # The blade, on its arms.
    for x in (-1.0, 1.0):
        m.box((x - 0.08, 0.5, 2.1), (x + 0.08, 0.66, 3.2), STEEL_DARK, faces="xXyYzZ")
    blade = [(-2.5, 0.05, 3.3), (2.5, 0.05, 3.3), (2.5, 1.15, 3.05), (-2.5, 1.15, 3.05)]
    m.quad(*blade, STEEL, (0.0, 0.0), (0, 0.2, 1))
    m.quad(*blade[::-1], STEEL_DARK, (0.0, 0.0), (0, -0.2, -1))
    # The tiller behind, under its cover.
    m.box((-2.4, 0.1, -3.4), (2.4, 0.6, -2.5), CAT_RED, faces="xXyYzZ")
    m.box((-0.1, 0.5, -2.5), (0.1, 0.7, -2.2), STEEL_DARK, faces="xXyYzZ")
    return m


def drape():
    """A cloth hung by its top edge (y = 0), 1 m wide and 1 m long, in the game's colour: it sways more the further down it hangs."""
    m = Mesh()
    rows = 4
    for k in range(rows):
        y0, y1 = -k / rows, -(k + 1) / rows
        for front in (1, -1):
            quad = [(-0.5, y1, 0.0), (0.5, y1, 0.0), (0.5, y0, 0.0), (-0.5, y0, 0.0)]
            uvs = [(-y1 * 0.6, 0.0), (-y1 * 0.6, 0.0), (-y0 * 0.6, 0.0), (-y0 * 0.6, 0.0)]
            m.quad(*(quad if front > 0 else quad[::-1]), TINT, uvs if front > 0 else uvs[::-1], (0, 0, front), alpha=0.0)
    return m


def boarder(seed, skis=False):
    """Someone standing with their board upright beside them (or their skis and poles), watching."""
    m = Mesh()
    figure(m, (0.0, 0.0, 0.0), TINT, 0.0, skin=SKIN if seed % 2 else SKIN_DARK)
    r = rng(seed)
    col = [srgb(0x3FAE6A), srgb(0xE86A2C), srgb(0x2E7FBF), srgb(0xE8B62C)][seed % 4]
    if skis:
        for dx in (0.42, 0.52):
            m.box((dx - 0.04, 0.0, -0.02), (dx + 0.04, 1.75, 0.02), col, (0.0, 0.0), faces="xXyYzZ")
        m.box((-0.44, 0.0, 0.1), (-0.42, 1.2, 0.12), RUBBER, (0.0, 0.0), faces="xXzZ")
    else:
        m.box((0.4, 0.0, -0.03), (0.68, 1.5, 0.03), col, (0.0, 0.0), faces="xXyYzZ")
        m.box((0.42, 0.45, 0.03), (0.66, 0.6, 0.07), RUBBER, (0.0, 0.0), faces="xXyYZ")
        m.box((0.42, 0.95, 0.03), (0.66, 1.1, 0.07), RUBBER, (0.0, 0.0), faces="xXyYZ")
    _ = r
    return m


def truss_bay():
    """One bay (1 m, along x) of the gantry's beam: four chords, a frame, a brace on each face."""
    m = Mesh()
    h, t = 0.3, 0.035
    for sy in (-h, h):
        for sz in (-h, h):
            m.box((0.0, sy - t, sz - t), (1.0, sy + t, sz + t), STEEL, faces="yYzZ")
    m.box((-t, -h, -h), (t, h, h), STEEL_DARK, faces="xX")
    for sz in (-h, h):
        m.quad((0.0, -h, sz), (0.06, -h, sz), (1.0, h, sz), (0.94, h, sz), STEEL_DARK, (0.0, 0.0), (0, 0, 1 if sz > 0 else -1))
    pillow(m, [(0.0, h, h), (1.0, h, h), (1.0, h, -h), (0.0, h, -h)], 0.14)
    return m


def gate():
    """A checkpoint gate's panel: a banner between two poles, in the game's colour. Its cloth flaps between them."""
    m = Mesh()
    for x in (-0.5, 0.5):
        m.tube([((x, -0.8, 0), 0.035, RUBBER), ((x, 2.3, 0), 0.03, RUBBER)], RUBBER, 5)
    steps = 4
    for k in range(steps):
        x0, x1 = -0.47 + k * 0.94 / steps, -0.47 + (k + 1) * 0.94 / steps
        w0 = 1 - abs((k / steps) * 2 - 1)
        w1 = 1 - abs(((k + 1) / steps) * 2 - 1)
        for front in (1, -1):
            quad = [(x0, 1.35, 0), (x1, 1.35, 0), (x1, 2.2, 0), (x0, 2.2, 0)]
            m.quad(*(quad if front > 0 else quad[::-1]), TINT, [(w0, 0.0), (w1, 0.0), (w1, 0.0), (w0, 0.0)] if front > 0 else [(w0, 0.0), (w1, 0.0), (w1, 0.0), (w0, 0.0)][::-1], (0, 0, front), alpha=0.0)
    return m


def feather():
    """A feather flag: a tall pole bent over at the top, a long sail of cloth down its length that flaps from it."""
    m = Mesh()
    m.box((-0.25, -0.6, -0.25), (0.25, 0.12, 0.25), RUBBER, faces="xXzZY")
    m.tube([((0, 0.1, 0), 0.03, STEEL_DARK), ((0, 3.6, 0), 0.02, STEEL_DARK), ((0.25, 4.4, 0), 0.012, STEEL_DARK)], STEEL_DARK, 4)
    rows = 6
    for k in range(rows):
        y0, y1 = 0.9 + k * 3.3 / rows, 0.9 + (k + 1) * 3.3 / rows
        wide = lambda y: 0.75 * (1 - max(0.0, (y - 3.6) / 0.8)) * (0.55 + 0.45 * min(1.0, (y - 0.9) / 0.8))
        bend = lambda y: 0.25 * max(0.0, (y - 3.6) / 0.8) ** 1.5
        for front in (1, -1):
            quad = [(bend(y0), y0, 0), (bend(y0) + wide(y0), y0, 0), (bend(y1) + wide(y1), y1, 0), (bend(y1), y1, 0)]
            uvs = [(0.0, 0.0), (1.0, 0.0), (1.0, 0.0), (0.0, 0.0)]
            m.quad(*(quad if front > 0 else quad[::-1]), TINT, uvs if front > 0 else uvs[::-1], (0, 0, front), alpha=0.0)
    return m


def board():
    """A sponsor board: a low padded panel on feet, 3 m long. Its face takes a brand's colours in the game."""
    m = Mesh()
    m.box((-1.5, 0.0, -0.06), (1.5, 0.95, 0.06), WHITE, faces="xXY")
    for front in (1, -1):
        quad = [(-1.5, 0.0, 0.06 * front), (1.5, 0.0, 0.06 * front), (1.5, 0.95, 0.06 * front), (-1.5, 0.95, 0.06 * front)]
        m.quad(*(quad if front > 0 else quad[::-1]), TINT, (0.0, 0.0), (0, 0, front), alpha=0.0)
    for x in (-1.2, 1.2):
        m.box((x - 0.04, -0.5, -0.3), (x + 0.04, 0.05, 0.3), RUBBER, faces="xXzZY")
    cap_on(m, (-1.5, 0.0, -0.06), (1.5, 0.95, 0.06), 0.1)
    return m


def post():
    """A netting post: a slim orange pole."""
    m = Mesh()
    m.tube([((0, -0.5, 0), 0.03, ORANGE), ((0, 1.3, 0), 0.025, ORANGE)], ORANGE, 4)
    return m


def build():
    return {
        "lift_tower": tower(),
        "lift_station": station(),
        "chair": chair(0),
        "chair_riders": chair(2),
        "chair_four": chair(3),
        "gantry_leg": gantry_leg(),
        "lamp_post": lamp_post(),
        "grandstand": grandstand(),
        "timing_board": timing_board(),
        "snowcat": snowcat(),
        "drape": drape(),
        "boarder_a": boarder(1),
        "boarder_b": boarder(2, skis=True),
        "boarder_c": boarder(3),
        "truss_bay": truss_bay(),
        "gate": gate(),
        "feather": feather(),
        "board": board(),
        "post": post(),
        "spectator_a": spectator(1, 0.0),
        "spectator_b": spectator(2, 1.0, hat=False, skin=SKIN_DARK),
        "spectator_c": spectator(3, 0.6),
    }
