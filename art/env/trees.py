"""The mountain's trees: firs with whorls of drooping boughs, a Scots pine
with its crown in pads on a bare trunk, young firs, dead snags, and cheaper
trees for the forest behind.

Every tree stands on y = 0 at its trunk's centre (the trunk goes on below
ground, for slopes). In the game's shader, a corner's masks are: `u`, how
far along its bough it is (0 on the trunk, 1 at a bough's tip: boughs bob
in the wind by it), and `v`, how readily snow lies there (1 on a bough's
ridge, 0 at its fringe and on the trunk). Colours are the needles' on the
top side; the shader darkens the underside. Normals are bent toward a cone
round the trunk, so a tree takes the light as one shape.
"""

import math

from meshlib import Mesh, add, lerp, lerp3, mixc, norm, rng, scale, srgb

BARK = srgb(0x5F4C40)
BARK_DARK = srgb(0x473930)
CORE = srgb(0x21402F)
DEAD = srgb(0x8D877F)
DEAD_DARK = srgb(0x6A655F)
PINE_BARK = srgb(0xA5683F)
#: New growth at the ends of the boughs.
TIP = srgb(0x7DA860)


def cone_normal(p, up=0.6):
    """A normal for a point of a tree: out from the trunk and a little up."""
    r = math.hypot(p[0], p[2])
    if r < 1e-4:
        return (0.0, 1.0, 0.0)
    return norm((p[0] / r, up, p[2] / r))


# A bough's outline, one side: (along, across), ridge to fringe. `PRONGED` has fingers.
PLAIN = [(0.0, 0.24), (0.46, 0.5), (1.0, 0.0)]
PRONGED = [(0.0, 0.2), (0.3, 0.5), (0.55, 0.42), (0.76, 0.66), (0.78, 0.26), (1.0, 0.0)]
#: The ridge station each outline point hangs from.
PRONG_RIDGE = [0.0, 0.3, 0.55, 0.55, 0.78, 1.0]


def bough(m, y, az, length, width, rise, droop, col, tip, r0=0.12, pronged=False, snow=1.0, sway=1.0):
    """A drooping bough from the trunk at height `y`, pointing along `az`: a
    ridge with a fringe hanging either side of it."""
    ux, uz = math.cos(az), math.sin(az)
    tx, tz = -uz, ux

    def at(s, w):
        r = r0 + length * s
        h = y + length * (rise * s - droop * s * s) - abs(w) * width * 0.42
        return (ux * r + tx * w * width, h, uz * r + tz * w * width)

    def corner(s, w):
        p = at(s, w)
        on_ridge = w == 0.0
        k = mixc(col, tip, s * s)
        return (
            p,
            k if on_ridge else scale(k, 0.74),
            (s * sway, snow if on_ridge and s < 0.99 else 0.0),
            cone_normal(p, 0.55 if on_ridge else 0.12),
        )

    outline = PRONGED if pronged else PLAIN
    ridge = PRONG_RIDGE if pronged else [s for s, _ in PLAIN]
    for side in (1.0, -1.0):
        for i in range(len(outline) - 1):
            a = corner(ridge[i], 0.0)
            b = corner(ridge[i + 1], 0.0)
            oa = corner(outline[i][0], outline[i][1] * side)
            ob = corner(outline[i + 1][0], outline[i + 1][1] * side)
            tris = []
            if ridge[i] == ridge[i + 1]:
                tris.append((a, oa, ob))
            elif outline[i + 1][1] == 0.0:
                tris.append((a, oa, b))
            else:
                tris.append((a, oa, ob))
                tris.append((a, ob, b))
            for t in tris:
                # Counter-clockwise from above on both sides of the ridge.
                p, q, r = t if side > 0 else (t[0], t[2], t[1])
                m.tri(p[0], q[0], r[0], [p[1], q[1], r[1]], [p[2], q[2], r[2]], [p[3], q[3], r[3]])


def trunk(m, height, radius, col, top=0.06, sides=6, lean=(0.0, 0.0), flare=1.45, dark=None):
    """A tapering trunk with a flare at its foot, leaning by `lean` (m at its top)."""
    dark = dark or scale(col, 0.8)
    rings = []
    for t, k in ((-0.08, flare), (0.0, flare), (0.05, 1.0), (0.35, 0.78), (0.7, 0.45), (1.0, 0.0)):
        y = t * height if t >= 0 else -1.0
        r = max(top, radius * k) if t < 1.0 else top
        tt = max(0.0, t)
        rings.append(((lean[0] * tt * tt, y, lean[1] * tt * tt), r, mixc(dark, col, min(1.0, tt * 3))))
    m.tube(rings, col, sides)


def fir(seed, height, reach, whorls, first, green, green_top, pronged_whorls=3, gaps=0.0, lean=0.0, per_whorl=(6, 4)):
    """A fir: `whorls` skirts of drooping boughs from `first` m up, the longest `reach` m,
    each skirt hanging over the next one down."""
    r = rng(seed)
    m = Mesh()
    la = r.random() * math.tau
    lx, lz = math.cos(la) * lean, math.sin(la) * lean
    trunk(m, height * 0.97, 0.3 + height * 0.012, BARK, lean=(lx, lz), dark=BARK_DARK)
    top = height * 0.95
    # The heart of the crown, behind the boughs.
    rings = []
    for t in (0.0, 0.25, 0.6, 1.0):
        y = lerp(first + 0.3, top, t)
        tt = y / height
        rings.append(((lx * tt * tt, y, lz * tt * tt), reach * 0.2 * (1 - t) ** 0.9 + 0.04, mixc(CORE, green, 0.25 + 0.4 * t)))
    core = Mesh()
    core.tube(rings, CORE, 6)
    for i in range(len(core.pos)):
        core.nor[i] = cone_normal(core.pos[i], 0.5)
    m.merge(core)
    turn = r.random() * math.tau
    for k in range(whorls):
        t = k / (whorls - 1)
        # Skirts closer together toward the top, as the boughs get shorter.
        y = lerp(first, top - 0.5, 1 - (1 - t) ** 1.35)
        tt = y / height
        profile = (0.8 + 0.2 * min(1.0, t / 0.15)) * (1 - t) ** 0.78 + 0.1
        n = round(lerp(per_whorl[0], per_whorl[1], t))
        turn += math.pi / n + r.uniform(-0.25, 0.25)
        col = mixc(green, green_top, t)
        for i in range(n):
            if r.random() < gaps and k < whorls - 2:
                continue
            length = reach * profile * r.uniform(0.85, 1.12)
            az = turn + (i / n) * math.tau + r.uniform(-0.18, 0.18)
            shade = r.uniform(0.84, 1.14) * lerp(0.9, 1.08, t)
            base = Mesh()
            bough(
                base,
                y + r.uniform(-0.2, 0.2),
                az,
                length,
                length * lerp(0.7, 1.05, t),
                lerp(0.18, 0.1, t),
                lerp(0.66, 0.8, t) * r.uniform(0.9, 1.15),
                scale(col, shade),
                scale(mixc(col, TIP, 0.35), shade * 1.12),
                pronged=k < pronged_whorls,
            )
            m.merge(base, at=(lx * tt * tt, 0.0, lz * tt * tt))
    # The leader.
    tip = Mesh()
    tip.tube(
        [((0, top - 1.0, 0), reach * 0.09, green_top), ((0, height, 0), 0.02, scale(green_top, 1.1))],
        green_top,
        4,
        uv=(0.3, 0.45),
    )
    for i in range(len(tip.pos)):
        tip.nor[i] = cone_normal(tip.pos[i], 0.5)
    m.merge(tip, at=(lx, 0.0, lz))
    return m


def young(seed, height, green, green_top):
    """A young fir: boughs to the ground."""
    return fir(seed, height, height * 0.4, 6, 0.3, green, green_top, pronged_whorls=1, per_whorl=(6, 4))


def pad(m, at, radius, thick, col, r, sides=7):
    """A clump of a pine's crown: a lumpy dome, dark below."""
    rim, mid, cap = [], [], []
    for i in range(sides):
        a = (i / sides) * math.tau
        k = radius * r.uniform(0.8, 1.2)
        rim.append(add(at, (math.cos(a) * k, r.uniform(-0.15, 0.1) * thick, math.sin(a) * k)))
        mid.append(add(at, (math.cos(a + 0.22) * k * 0.82, thick * r.uniform(0.42, 0.56), math.sin(a + 0.22) * k * 0.82)))
        cap.append(add(at, (math.cos(a + 0.45) * k * 0.42, thick * r.uniform(0.82, 0.96), math.sin(a + 0.45) * k * 0.42)))
    top = add(at, (0.0, thick, 0.0))
    below = add(at, (0.0, -thick * 0.5, 0.0))

    def nrm(p, up):
        d = (p[0] - at[0], 0.0, p[2] - at[2])
        length = math.hypot(d[0], d[2]) or 1.0
        return norm((d[0] / length, up, d[2] / length))

    light = scale(col, 1.1)
    for i in range(sides):
        j = (i + 1) % sides
        m.quad(
            rim[i], mid[i], mid[j], rim[j],
            [col, col, col, col],
            [(0.7, 0.0), (0.5, 0.45), (0.5, 0.45), (0.7, 0.0)],
            [nrm(rim[i], 0.0), nrm(mid[i], 0.6), nrm(mid[j], 0.6), nrm(rim[j], 0.0)],
        )
        m.quad(
            mid[i], cap[i], cap[j], mid[j],
            [col, light, light, col],
            [(0.5, 0.45), (0.4, 0.95), (0.4, 0.95), (0.5, 0.45)],
            [nrm(mid[i], 0.6), nrm(cap[i], 1.6), nrm(cap[j], 1.6), nrm(mid[j], 0.6)],
        )
        m.tri(cap[i], top, cap[j], light, [(0.4, 0.95), (0.3, 1.0), (0.4, 0.95)], [nrm(cap[i], 1.6), (0, 1, 0), nrm(cap[j], 1.6)])
        dark = scale(col, 0.5)
        m.tri(rim[j], below, rim[i], dark, (0.5, 0.0), [nrm(rim[j], -0.6), (0, -1, 0), nrm(rim[i], -0.6)])


def limb(m, a, b, ra, rb, col, sides=4):
    """A bare limb from `a` to `b`."""
    d = norm((b[0] - a[0], b[1] - a[1], b[2] - a[2]))
    ref = (0.0, 1.0, 0.0) if abs(d[1]) < 0.9 else (1.0, 0.0, 0.0)
    u = norm((d[1] * ref[2] - d[2] * ref[1], d[2] * ref[0] - d[0] * ref[2], d[0] * ref[1] - d[1] * ref[0]))
    v = (d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0])
    ring = lambda c, rad: [
        (
            c[0] + (u[0] * math.cos(i / sides * math.tau) + v[0] * math.sin(i / sides * math.tau)) * rad,
            c[1] + (u[1] * math.cos(i / sides * math.tau) + v[1] * math.sin(i / sides * math.tau)) * rad,
            c[2] + (u[2] * math.cos(i / sides * math.tau) + v[2] * math.sin(i / sides * math.tau)) * rad,
        )
        for i in range(sides)
    ]
    ra_, rb_ = ring(a, ra), ring(b, rb)
    for i in range(sides):
        j = (i + 1) % sides
        m.quad(ra_[i], ra_[j], rb_[j], rb_[i], col, (0.0, 0.0))


def pine(seed, height, green):
    """A Scots pine: a tall bare trunk, orange up high, its crown in pads."""
    r = rng(seed)
    m = Mesh()
    lean = (r.uniform(-0.6, 0.6), r.uniform(-0.6, 0.6))
    rings = []
    for t, k in ((-0.1, 1.5), (0.0, 1.5), (0.06, 1.0), (0.45, 0.8), (0.8, 0.5), (1.0, 0.12)):
        y = t * height * 0.92 if t >= 0 else -1.0
        tt = max(0.0, t)
        rings.append(
            ((lean[0] * tt * tt, y, lean[1] * tt * tt), 0.34 * k, mixc(BARK, PINE_BARK, min(1.0, max(0.0, tt - 0.3) * 2.5)))
        )
    m.tube(rings, BARK, 6)
    # Pads round the upper trunk, the biggest on top.
    spots = [(0.93, 0.0, 0.0, 2.7)]
    turn = r.random() * math.tau
    for k in range(4):
        t = lerp(0.66, 0.86, k / 3)
        turn += 2.3 + r.uniform(-0.4, 0.4)
        spots.append((t, turn, lerp(2.5, 1.7, k / 3) * r.uniform(0.9, 1.1), lerp(2.2, 1.8, k / 3) * r.uniform(0.9, 1.15)))
    for t, az, out, rad in spots:
        tt = t * 0.92
        base = (lean[0] * tt * tt, height * tt, lean[1] * tt * tt)
        centre = add(base, (math.cos(az) * out, out * 0.3, math.sin(az) * out))
        if out > 0:
            limb(m, add(base, (0, -0.8, 0)), add(centre, (0, -0.2, 0)), 0.13, 0.07, PINE_BARK)
        pad(m, centre, rad, rad * 0.62, scale(green, r.uniform(0.92, 1.08)), r)
    return m


def snag(seed, height):
    """A dead tree: a grey trunk broken off at the top, with a few bare limbs."""
    r = rng(seed)
    m = Mesh()
    lean = (r.uniform(-0.5, 0.5), r.uniform(-0.5, 0.5))
    rings = []
    for t, k in ((-0.12, 1.5), (0.0, 1.5), (0.06, 1.0), (0.5, 0.75), (1.0, 0.42)):
        y = t * height if t >= 0 else -1.0
        tt = max(0.0, t)
        rings.append(((lean[0] * tt * tt, y, lean[1] * tt * tt), 0.3 * k, mixc(DEAD_DARK, DEAD, tt)))
    m.tube(rings, DEAD, 6, smooth=False)
    # The break: a splinter standing over a slanted cut.
    top = (lean[0], height, lean[1])
    rim = [(top[0] + math.cos(i / 6 * math.tau) * 0.126, top[1], top[2] + math.sin(i / 6 * math.tau) * 0.126) for i in range(6)]
    spike = add(top, (0.05, 0.9, -0.04))
    for i in range(6):
        j = (i + 1) % 6
        m.tri(rim[i], spike if i < 3 else add(top, (0.0, 0.25, 0.0)), rim[j], DEAD if i < 3 else DEAD_DARK, (0.0, 0.5))
    az = r.random() * math.tau
    for k in range(6):
        t = lerp(0.3, 0.92, k / 5)
        az += 2.2 + r.uniform(-0.5, 0.5)
        length = lerp(2.2, 0.8, t) * r.uniform(0.6, 1.2)
        base = (lean[0] * t * t, height * t, lean[1] * t * t)
        end = add(base, (math.cos(az) * length, length * r.uniform(-0.25, 0.35), math.sin(az) * length))
        limb(m, base, end, 0.07, 0.015, DEAD_DARK, 3)
    # Snow lies on what is left: the masks say so on upward faces only.
    for i in range(len(m.pos)):
        m.uv[i] = (0.0, 0.7 if m.nor[i][1] > 0.6 else 0.0)
    return m


def far_fir(seed, height, reach, skirts, green, green_top, points=6):
    """A fir for the forest behind: skirts of boughs as pointed stars, one over the next."""
    r = rng(seed)
    m = Mesh()
    m.tube([((0, -1.0, 0), 0.34, BARK_DARK), ((0, height * 0.3, 0), 0.22, BARK)], BARK, 4)
    first = height * 0.14
    turn = r.random() * math.tau
    for k in range(skirts):
        t = k / skirts
        y0 = lerp(first, height, t)
        y1 = lerp(first, height, min(1.0, (k + 1.9) / skirts))
        rad = reach * ((1 - t) ** 0.8) * (0.85 if k == 0 else 1.0) + 0.15
        col = mixc(green, green_top, t)
        turn += 0.5
        apex = (0.0, y1, 0.0)
        rim = []
        for i in range(points * 2):
            a = turn + (i / (points * 2)) * math.tau
            out = rad * (r.uniform(0.9, 1.12) if i % 2 == 0 else 0.56)
            y = y0 - (rad * 0.32 if i % 2 == 0 else -rad * 0.08)
            rim.append((math.cos(a) * out, y, math.sin(a) * out))
        for i in range(points * 2):
            j = (i + 1) % (points * 2)
            tip_i = scale(col, 1.05 if i % 2 == 0 else 0.86)
            tip_j = scale(col, 1.05 if j % 2 == 0 else 0.86)
            m.tri(
                apex,
                rim[j],
                rim[i],
                [col, tip_j, tip_i],
                [(0.0, 1.0), (1.0 if j % 2 == 0 else 0.5, 0.0), (1.0 if i % 2 == 0 else 0.5, 0.0)],
                [(0.0, 1.0, 0.0), cone_normal(rim[j], 0.4), cone_normal(rim[i], 0.4)],
            )
    return m


def far_pine(seed, height, green):
    """A pine for the forest behind: the trunk and three pads."""
    r = rng(seed)
    m = Mesh()
    m.tube(
        [((0, -1.0, 0), 0.42, BARK), ((0, height * 0.5, 0), 0.26, PINE_BARK), ((0, height * 0.9, 0), 0.08, PINE_BARK)],
        BARK,
        4,
    )
    pad(m, (0.0, height * 0.86, 0.0), 2.6, 1.6, green, r, 5)
    pad(m, (1.7, height * 0.7, 0.6), 2.0, 1.2, scale(green, 0.94), r, 5)
    pad(m, (-1.4, height * 0.76, -1.0), 1.8, 1.1, scale(green, 1.05), r, 5)
    return m


def build():
    """Every tree, by name."""
    silver = (srgb(0x3A6B4C), srgb(0x4F8A62))
    spruce = (srgb(0x2F6450), srgb(0x44826A))
    olive = (srgb(0x44663D), srgb(0x5C8750))
    fresh = (srgb(0x4B8452), srgb(0x66A168))
    return {
        "fir_tall": fir(11, 16.0, 3.4, 12, 2.9, *silver, lean=0.25),
        "fir_broad": fir(23, 12.5, 3.8, 10, 2.3, *spruce, lean=0.15),
        "fir_old": fir(37, 18.0, 3.5, 12, 4.4, *olive, gaps=0.28, lean=0.7, per_whorl=(5, 4)),
        "fir_young": young(41, 4.2, *fresh),
        "fir_small": young(43, 2.6, *silver),
        "pine_scots": pine(53, 13.5, srgb(0x4D7B45)),
        "snag": snag(61, 8.5),
        # The same trees from far off.
        "fir_tall_lod": far_fir(12, 16.0, 3.4, 6, *silver),
        "fir_broad_lod": far_fir(24, 12.5, 3.8, 5, *spruce),
        "fir_old_lod": far_fir(38, 18.0, 3.2, 6, *olive),
        "fir_young_lod": far_fir(42, 4.2, 1.6, 3, *fresh, points=5),
        "fir_small_lod": far_fir(44, 2.6, 1.0, 3, *silver, points=5),
        "pine_scots_lod": far_pine(54, 13.5, srgb(0x4D7B45)),
        "far_fir_a": far_fir(71, 14.0, 3.0, 5, *silver),
        "far_fir_b": far_fir(73, 11.0, 3.4, 4, *spruce),
        "far_fir_c": far_fir(79, 17.0, 2.8, 6, *olive),
    }
