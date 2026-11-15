"""The mountain's rock: boulders, small rocks that poke through a thin
cover, and crags for the walls of the couloir, the bowl's rim and the
gully. Each is cut from a block by planes, so it is made of a few big flat
faces with hard edges, lighter on top; crags are blocks stepped one on
another, with ledges between.

A snow cap sits on every face that looks up. In the game's shader a
corner's masks are: `u`, how high a cap's corner stands over the face it
sits on (m: without snow the cap sinks into the rock), and `v`, 1 on a cap.
The strata are painted by the shader, the same over the whole mountain.
"""

import math

from meshlib import Mesh, add, centroid, convex, lerp3, norm, polygon_area, polygon_normal, rng, rot_y, scale, srgb

LIGHT = srgb(0xC2B9AC)
MID = srgb(0xA1978C)
DARK = srgb(0x877D76)
DEEP = srgb(0x6F6764)
SNOW = (0.9, 0.93, 1.0)


def pillow(m, poly, thick):
    """A cap of snow on an upward face: its foot just inside the face's edge, rounded over the top."""
    c = centroid(poly)
    inset = lambda k, h: [add(lerp3(p, c, k), (0.0, h, 0.0)) for p in poly]
    foot = inset(0.04, 0.0)
    edge = inset(0.02, thick * 0.55)
    crown = inset(0.34, thick)
    top = add(c, (0.0, thick * 1.1, 0.0))
    n = len(poly)

    def out(p, up):
        d = (p[0] - c[0], 0.0, p[2] - c[2])
        length = math.hypot(d[0], d[2]) or 1.0
        return norm((d[0] / length, up, d[2] / length))

    for i in range(n):
        j = (i + 1) % n
        m.quad(
            foot[i], foot[j], edge[j], edge[i], SNOW,
            [(0.0, 1.0), (0.0, 1.0), (thick * 0.55, 1.0), (thick * 0.55, 1.0)],
            [out(foot[i], 0.1), out(foot[j], 0.1), out(edge[j], 0.5), out(edge[i], 0.5)],
        )
        m.quad(
            edge[i], edge[j], crown[j], crown[i], SNOW,
            [(thick * 0.55, 1.0), (thick * 0.55, 1.0), (thick, 1.0), (thick, 1.0)],
            [out(edge[i], 0.5), out(edge[j], 0.5), out(crown[j], 2.5), out(crown[i], 2.5)],
        )
        m.tri(
            crown[i], crown[j], top, SNOW,
            [(thick, 1.0), (thick, 1.0), (thick * 1.1, 1.0)],
            [out(crown[i], 2.5), out(crown[j], 2.5), (0.0, 1.0, 0.0)],
        )


def block(m, lo, hi, planes, r, caps=True, tones=(LIGHT, MID, DARK, DEEP), cap_thick=0.34):
    """A block cut by planes: flat faces in the rock's tones (the lightest on top), a snow cap on the ones that look up."""
    polys = convex(lo, hi, planes)
    k = r.randrange(3)
    for poly in polys:
        n = polygon_normal(poly)
        if n[1] < -0.7:
            continue
        if n[1] > 0.55:
            tone = tones[0]
        else:
            # Neighbouring faces differ, so the planes read even in shade.
            k = (k + 1 + r.randrange(2)) % 3
            tone = tones[1 + k]
        tone = scale(tone, r.uniform(0.95, 1.05))
        for i in range(1, len(poly) - 1):
            m.tri(poly[0], poly[i], poly[i + 1], tone, (0.0, 0.0), n)
        if caps and n[1] > 0.72 and polygon_area(poly) > 0.5:
            pillow(m, poly, min(0.6, cap_thick * (0.7 + 0.35 * math.sqrt(polygon_area(poly)))))


def cuts(r, lo, hi, count, top=0.5, bite=0.3):
    """Planes that cut the corners and sides off a block: `count` of them, biting up to `bite` of its size."""
    cx, cy, cz = [(lo[i] + hi[i]) / 2 for i in range(3)]
    sx, sy, sz = [(hi[i] - lo[i]) / 2 for i in range(3)]
    planes = []
    for k in range(count):
        a = r.random() * math.tau
        up = r.uniform(-0.15, 0.9) if k % 3 else r.uniform(0.6, 1.4) * top
        n = norm((math.cos(a), up, math.sin(a)))
        # The plane touches the block's box, then bites into it.
        reach = abs(n[0]) * sx + abs(n[1]) * sy + abs(n[2]) * sz
        d = n[0] * cx + n[1] * cy + n[2] * cz + reach * (1 - r.uniform(0.08, bite))
        planes.append((n, d))
    return planes


def boulder(seed, w=2.3, h=1.5, d=2.0, count=10, caps=True, bite=0.34):
    """A boulder about `w` by `d` across and `h` tall, its foot below the ground."""
    r = rng(seed)
    m = Mesh()
    lo, hi = (-w / 2, -0.5, -d / 2), (w / 2, h, d / 2)
    block(m, lo, hi, cuts(r, lo, hi, count, bite=bite), r, caps)
    return m


def shard(seed, w=1.2, h=1.0, d=0.9):
    """A sharp, dark rock poking through a thin cover."""
    r = rng(seed)
    m = Mesh()
    lo, hi = (-w / 2, -0.4, -d / 2), (w / 2, h, d / 2)
    planes = cuts(r, lo, hi, 7, top=0.9, bite=0.45)
    block(m, lo, hi, planes, r, caps=False, tones=(MID, DARK, DEEP, DARK))
    return m


def joints(r, lo, hi, count, bite=0.3, front=0.12):
    """Near-vertical planes that break a bed's edge into a few straight runs; the front (+z) is cut least."""
    cx, cz = (lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2
    sx, sz = (hi[0] - lo[0]) / 2, (hi[2] - lo[2]) / 2
    planes = []
    a = r.random() * math.tau
    for k in range(count):
        a += math.tau / count + r.uniform(-0.35, 0.35)
        n = norm((math.cos(a), r.uniform(-0.12, 0.22), math.sin(a)))
        reach = abs(n[0]) * sx + abs(n[2]) * sz
        cut = r.uniform(0.04, front) if n[2] > 0.6 else r.uniform(0.06, bite)
        planes.append((n, n[0] * cx + n[2] * cz + n[1] * hi[1] * 0.5 + reach * (1 - cut)))
    return planes


def outcrop(seed, w, h, d, beds, setback=0.28, spread=0.0, dip=(0.05, 0.03), flush=0.5):
    """Beds of rock one on another, dipping together, each broken along its
    own joints. Some stand flush on the one below, making a tall face;
    the others are set back from it (toward -z, or to one side with
    `spread`), leaving a ledge along the front (+z)."""
    r = rng(seed)
    m = Mesh()
    weights = [r.choice((0.45, 0.7, 1.0, 1.6, 2.2)) for _ in range(beds)]
    total = sum(weights)
    y = -1.4
    cx, cz, bw, bd = 0.0, 0.0, w, d
    # A crag on its own leans one way as it rises.
    lean = r.random() * math.tau
    for k in range(beds):
        thick = (h + 1.4) * weights[k] / total
        lo, hi = (cx - bw / 2, y, cz - bd / 2), (cx + bw / 2, y + thick * 1.25, cz + bd / 2)
        planes = joints(r, lo, hi, 6 if bw > 3 else 5)
        # The top follows the dip.
        top = norm((dip[0], 1.0, dip[1]))
        planes.append((top, top[0] * cx + top[1] * (y + thick) + top[2] * cz))
        k_tone = r.uniform(0.88, 1.1)
        tones = tuple(scale(t, k_tone) for t in (LIGHT, MID, DARK, DEEP))
        block(m, lo, hi, planes, r, True, tones, cap_thick=0.36)
        y += thick
        if r.random() < flush:
            continue
        # The next bed: narrower, and back from the front.
        shrink = r.uniform(0.6, 0.88)
        back = bd * setback * r.uniform(0.4, 1.0)
        if spread > 0:
            cx += math.cos(lean) * bw * (1 - shrink) * 0.5
            cz += math.sin(lean) * back * 0.5
        else:
            cx += r.uniform(-1, 1) * bw * (1 - shrink) * 0.5
            cz -= back * 0.5
        bw *= shrink
        bd = max(bd * 0.5, bd - back)
    return m


def crag(seed, w, h, d, beds=4):
    """A crag standing on its own: beds stepping in from every side, and a fallen block at its foot."""
    m = outcrop(seed, w, h, d, beds, setback=0.4, spread=1.0)
    r = rng(seed + 1)
    part = Mesh()
    lo, hi = (-w * 0.2, -0.5, -d * 0.18), (w * 0.2, h * 0.2, d * 0.18)
    block(part, lo, hi, cuts(r, lo, hi, 7, bite=0.3), r, True)
    a = r.random() * math.tau
    m.merge(part, at=(math.cos(a) * w * 0.62, 0.0, math.sin(a) * d * 0.62), turn=r.random() * 3)
    return m


def build():
    return {
        "boulder_a": boulder(3),
        "boulder_b": boulder(8, 2.2, 1.7, 2.2, 11),
        "boulder_c": boulder(14, 2.4, 1.3, 1.9, 9),
        "shard_a": shard(21),
        "shard_b": shard(25, 1.0, 1.2, 1.0),
        "crag_a": crag(31, 5.0, 5.0, 4.2, 4),
        "crag_b": crag(36, 6.0, 3.6, 4.6, 3),
        "crag_c": crag(44, 4.4, 7.5, 4.0, 5),
        "wall_a": outcrop(51, 9.0, 5.0, 4.5, 5),
        "wall_b": outcrop(58, 8.0, 7.0, 4.5, 6, setback=0.22),
        "wall_c": outcrop(63, 10.0, 3.2, 4.0, 3, setback=0.35),
    }
