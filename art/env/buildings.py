"""The mountain's buildings: chalets, a half-timbered inn and a hotel for the
village at the finish, its church, the summit's start hut and the lodge.

Each stands on y = 0 with its front to +z; its walls go on below ground
(for slopes). Walls are flat colours with what a painter would pick out
laid on them: timbers, window frames, shutters, a stone foot. In the
game's shader a corner's masks are, as on the rocks: `u`, how high a snow
cap's corner stands over the roof it lies on (m), and `v`, 1 on a cap.
Glass has alpha 0: it lights up at dusk.
"""

import math

from meshlib import Mesh, add, cross, lerp, lerp3, norm, rng, scale, srgb, sub
from rocks import pillow

CREAM = srgb(0xEFE4CC)
WHITE = srgb(0xF3EEE4)
OCHRE = srgb(0xE2C48E)
TIMBER = srgb(0x5C4131)
HONEY = srgb(0xB57F4C)
LARCH = srgb(0x8A5A38)
STONE = srgb(0x9A938A)
STONE_DARK = srgb(0x7B756F)
SLATE = srgb(0x55505A)
SHINGLE = srgb(0x6A4E42)
GLASS = srgb(0x2D3F5C)
DOOR = srgb(0x6B452E)
GREEN = srgb(0x3E6B50)
RED = srgb(0xA5443A)
BLUE = srgb(0x3D5E8C)
#: Below ground, for slopes (m).
FOOT = 4.0


class Face:
    """A wall's plane, to lay flat things on: `o` its lower left corner seen from outside, `r` along it, `n` out of it."""

    def __init__(self, m, o, r, n):
        self.m, self.o, self.r, self.n = m, o, norm(r), norm(n)

    def at(self, u, v, out=0.0):
        return (
            self.o[0] + self.r[0] * u + self.n[0] * out,
            self.o[1] + v,
            self.o[2] + self.r[2] * u + self.n[2] * out,
        )

    def rect(self, u0, v0, u1, v1, col, out=0.0, alpha=1.0):
        a, b, c, d = self.at(u0, v0, out), self.at(u1, v0, out), self.at(u1, v1, out), self.at(u0, v1, out)
        self.m.quad(a, b, c, d, col, (0.0, 0.0), self.n, alpha=alpha)

    def strip(self, u0, v0, u1, v1, wide, col, out=0.1):
        """A timber from (u0, v0) to (u1, v1), `wide` across."""
        du, dv = u1 - u0, v1 - v0
        length = math.hypot(du, dv) or 1.0
        px, pv = -dv / length * wide / 2, du / length * wide / 2
        pts = [(u0 - px, v0 - pv), (u1 - px, v1 - pv), (u1 + px, v1 + pv), (u0 + px, v0 + pv)]
        a, b, c, d = [self.at(u, v, out) for u, v in pts]
        self.m.quad(a, b, c, d, col, (0.0, 0.0), self.n)

    def window(self, u, v, w, h, shutter=None, frame=WHITE, out=0.1, arch=False):
        """A window with its centre at (u, v): glass in a frame, shutters folded back either side."""
        f = 0.09
        u0, u1, v0, v1 = u - w / 2, u + w / 2, v - h / 2, v + h / 2
        self.rect(u0, v0, u1, v1, GLASS, out, alpha=0.0)
        self.rect(u0 - f, v0 - f, u1 + f, v0, frame, out)
        self.rect(u0 - f, v1, u1 + f, v1 + f, frame, out)
        self.rect(u0 - f, v0, u0, v1, frame, out)
        self.rect(u1, v0, u1 + f, v1, frame, out)
        # A bar across the glass.
        self.rect(u0, v - 0.03, u1, v + 0.03, frame, out + 0.01)
        if shutter:
            s = w * 0.48
            self.rect(u0 - f - s, v0, u0 - f, v1, shutter, out)
            self.rect(u1 + f, v0, u1 + f + s, v1, shutter, out)
        if arch:
            self.m.tri(self.at(u0 - f, v1 + f, out), self.at(u1 + f, v1 + f, out), self.at(u, v1 + f + w * 0.45, out), frame, (0.0, 0.0), self.n)

    def door(self, u, w, h, col=DOOR, out=0.1):
        self.rect(u - w / 2, 0.0, u + w / 2, h, col, out)
        self.rect(u - w / 2 - 0.1, h, u + w / 2 + 0.1, h + 0.14, TIMBER, out)


def shell(m, w, d, h, col, y0=-FOOT):
    """Four walls `w` by `d`, from `y0` up to `h`: returns their faces (front, right, back, left)."""
    x0, x1, z0, z1 = -w / 2, w / 2, -d / 2, d / 2
    m.box((x0, y0, z0), (x1, h, z1), col, faces="xXzZ")
    return (
        Face(m, (x0, 0.0, z1), (1, 0, 0), (0, 0, 1)),
        Face(m, (x1, 0.0, z1), (0, 0, -1), (1, 0, 0)),
        Face(m, (x1, 0.0, z0), (-1, 0, 0), (0, 0, -1)),
        Face(m, (x0, 0.0, z0), (0, 0, 1), (-1, 0, 0)),
    )


def gable_roof(m, w, d, eave, rise, col, wall, over=0.7, along_x=True, snow=0.42, thick=0.22):
    """A gable roof over a `w` by `d` box, its ridge along x (or z): eaves at
    `eave`, the ridge `rise` higher, with the gables filled in `wall` and a
    blanket of snow on each side."""
    part = Mesh()
    hw, hd = w / 2, d / 2
    # (Built with the ridge along x, then turned.)
    if not along_x:
        hw, hd = hd, hw
    run = hd + over
    drop = rise * over / hd
    for side in (1.0, -1.0):
        a = (-hw - over, eave - drop, side * run)
        b = (hw + over, eave - drop, side * run)
        c = (hw + over, eave + rise, 0.0)
        e = (-hw - over, eave + rise, 0.0)
        quad = [a, b, c, e] if side > 0 else [b, a, e, c]
        part.quad(*quad, col)
        # The eave's edge, and the verge at each end.
        lo = lambda p: (p[0], p[1] - thick, p[2])
        part.quad(lo(quad[0]), lo(quad[1]), quad[1], quad[0], scale(col, 0.8))
        part.quad(lo(quad[1]), lo(quad[2]), quad[2], quad[1], scale(col, 0.8))
        part.quad(lo(quad[3]), lo(quad[0]), quad[0], quad[3], scale(col, 0.8))
        # Under the eave.
        part.quad(lo(quad[1]), lo(quad[0]), lo(quad[3]), lo(quad[2]), scale(col, 0.55))
        if snow:
            pillow(part, quad, snow)
    for end in (1.0, -1.0):
        a = (end * hw, eave, hd)
        b = (end * hw, eave, -hd)
        c = (end * hw, eave + rise, 0.0)
        part.tri(*([a, b, c] if end > 0 else [b, a, c]), wall)
    m.merge(part, turn=0.0 if along_x else math.pi / 2)


def chimney(m, x, z, base, top, col=STONE, wide=0.7):
    m.box((x - wide / 2, base, z - wide / 2), (x + wide / 2, top, z + wide / 2), col, faces="xXzZ")
    cap = [(x - wide * 0.65, top, z + wide * 0.65), (x + wide * 0.65, top, z + wide * 0.65), (x + wide * 0.65, top, z - wide * 0.65), (x - wide * 0.65, top, z - wide * 0.65)]
    m.quad(*cap, scale(col, 0.8))
    pillow(m, cap, 0.22)


def balcony(m, face, u0, u1, v, deep=1.1, col=LARCH, rail=1.0):
    """A balcony on a wall from `u0` to `u1` at height `v`: its floor, a boarded rail, posts."""
    a, b = face.at(u0, v), face.at(u1, v)
    n = face.n
    out = lambda p, k, up=0.0: (p[0] + n[0] * k, p[1] + up, p[2] + n[2] * k)
    # The floor's edge and underside.
    m.quad(out(a, deep, -0.16), out(b, deep, -0.16), out(b, deep), out(a, deep), scale(col, 0.85), (0.0, 0.0), n)
    m.quad(out(b, 0, -0.16), out(a, 0, -0.16), out(a, deep, -0.16), out(b, deep, -0.16), scale(col, 0.5))
    # The rail: boards, with a gap under the top rail.
    m.quad(out(a, deep), out(b, deep), out(b, deep, rail * 0.72), out(a, deep, rail * 0.72), col, (0.0, 0.0), n)
    m.quad(out(a, deep, rail * 0.86), out(b, deep, rail * 0.86), out(b, deep, rail), out(a, deep, rail), scale(col, 0.8), (0.0, 0.0), n)
    for end, p in ((-1, a), (1, b)):
        side = cross((0, 1, 0), n) if end > 0 else cross(n, (0, 1, 0))
        q = [out(p, 0), out(p, deep), out(p, deep, rail), out(p, 0, rail)]
        m.quad(*(q if end < 0 else q[::-1]), scale(col, 0.9), (0.0, 0.0), side)
    cap = [out(a, 0.05, rail), out(b, 0.05, rail), out(b, deep + 0.05, rail), out(a, deep + 0.05, rail)]
    order = cap if cross(sub(cap[1], cap[0]), sub(cap[2], cap[0]))[1] > 0 else cap[::-1]
    pillow(m, order, 0.16)


def timbers(face, w, v0, v1, bays, col=TIMBER, braces=True):
    """Half-timbering on a wall `w` wide between heights `v0` and `v1`: posts, a sill and a plate, braces in the end bays."""
    t = 0.2
    face.strip(0.0, v0 + t / 2, w, v0 + t / 2, t, col)
    face.strip(0.0, v1 - t / 2, w, v1 - t / 2, t, col)
    for k in range(bays + 1):
        u = min(w - t / 2, max(t / 2, w * k / bays))
        face.strip(u, v0, u, v1, t, col)
    if braces:
        bay = w / bays
        face.strip(t, v0 + t, bay - t, v1 - t, t * 0.8, col)
        face.strip(w - t, v0 + t, w - bay + t, v1 - t, t * 0.8, col)


def stone_foot(m, w, d, h=1.0, col=STONE):
    m.box((-w / 2 - 0.08, -FOOT, -d / 2 - 0.08), (w / 2 + 0.08, h, d / 2 + 0.08), col, faces="xXzZ")
    m.box((-w / 2 - 0.08, h, -d / 2 - 0.08), (w / 2 + 0.08, h + 0.001, d / 2 + 0.08), scale(col, 1.1), faces="Y")


def rows(face, w, v, count, ww, wh, shutter=None, skip=(), margin=1.2):
    """A row of windows along a wall `w` wide at height `v`."""
    for k in range(count):
        if k in skip:
            continue
        u = margin + (w - 2 * margin) * (k + 0.5) / count if count > 1 else w / 2
        face.window(u, v, ww, wh, shutter)


def chalet(seed, w=9.0, d=7.5, wall=CREAM, wood=LARCH, shutter=GREEN, roof=SHINGLE):
    """A chalet: a plastered ground floor on a stone foot, a boarded floor above with a balcony across its gable front."""
    m = Mesh()
    h1, h2 = 2.9, 5.6
    stone_foot(m, w, d)
    front, right, back, left = shell(m, w, d, h1, wall)
    # The upper floor, boarded, a little proud of the walls.
    m.box((-w / 2 - 0.12, h1, -d / 2 - 0.12), (w / 2 + 0.12, h2, d / 2 + 0.12), wood, faces="xXzZ")
    up = [Face(m, add(f.o, mul3(f.n, 0.12)), f.r, f.n) for f in (front, right, back, left)]
    gable_roof(m, w + 0.24, d + 0.24, h2, 2.3, roof, wood, over=1.0, along_x=False)
    front.door(w * 0.3, 1.1, 2.1)
    rows(front, w, 1.75, 3, 0.9, 1.1, shutter, skip=(0,))
    rows(right, d, 1.75, 2, 0.9, 1.1, shutter)
    rows(left, d, 1.75, 2, 0.9, 1.1, shutter)
    rows(up[0], w + 0.24, h1 + 1.45, 3, 0.85, 1.05, shutter)
    rows(up[1], d + 0.24, h1 + 1.45, 2, 0.85, 1.05, shutter)
    rows(up[3], d + 0.24, h1 + 1.45, 2, 0.85, 1.05, shutter)
    up[0].window((w + 0.24) / 2, h2 + 0.95, 0.8, 0.8, None)
    balcony(m, up[0], 0.5, w - 0.26, h1 + 0.25)
    chimney(m, w * 0.22, -d * 0.12, h2 + 0.6, h2 + 3.1)
    return m


def mul3(a, k):
    return (a[0] * k, a[1] * k, a[2] * k)


def inn(seed, w=12.0, d=8.5, wall=WHITE, shutter=RED):
    """A half-timbered inn: three floors, the upper two framed in dark timber, its long side to the front, a dormer in the roof."""
    m = Mesh()
    h1, h2, h3 = 3.0, 5.8, 8.4
    stone_foot(m, w, d, 0.8)
    front, right, back, left = shell(m, w, d, h3, wall)
    for f, width in ((front, w), (right, d), (back, w), (left, d)):
        timbers(f, width, h1, h2, 4 if width > 10 else 3)
        timbers(f, width, h2, h3, 4 if width > 10 else 3, braces=False)
    gable_roof(m, w, d, h3, 3.4, SLATE, wall, over=0.8, along_x=True)
    for end, f in ((1, right), (-1, left)):
        f.strip(d / 2, h3, d / 2, h3 + 3.0, 0.2, TIMBER)
        f.strip(d * 0.2, h3 + 0.9, d * 0.8, h3 + 0.9, 0.2, TIMBER)
        f.window(d / 2 + 0.9, h3 + 0.4, 0.7, 0.8, None)
    front.door(w / 2, 1.5, 2.3)
    rows(front, w, 1.8, 4, 1.0, 1.2, None, skip=())
    for v in (h1 + 1.4, h2 + 1.3):
        rows(front, w, v, 4, 0.9, 1.1, shutter, margin=0.9)
        rows(back, w, v, 4, 0.9, 1.1, shutter, margin=0.9)
        rows(right, d, v, 3, 0.85, 1.05, shutter, margin=0.8)
        rows(left, d, v, 3, 0.85, 1.05, shutter, margin=0.8)
    # A dormer on the front slope.
    part = Mesh()
    dw, dh = 2.2, 1.7
    fr, _, _, _ = shell(part, dw, 2.6, dh, wall, y0=0.0)
    fr.window(dw / 2, dh * 0.55, 0.9, 0.9, shutter)
    gable_roof(part, dw, 2.6, dh, 0.9, SLATE, wall, over=0.3, along_x=False, snow=0.3)
    m.merge(part, at=(-w * 0.18, h3 + 0.2, d / 2 - 1.3))
    m.merge(part, at=(w * 0.22, h3 + 0.2, d / 2 - 1.3))
    chimney(m, w * 0.3, -d * 0.15, h3 + 1.5, h3 + 4.4)
    chimney(m, -w * 0.34, -d * 0.1, h3 + 1.5, h3 + 4.1)
    return m


def hotel(seed):
    """The hotel: four floors under a steep roof with a row of dormers, balconies along its front, a porch."""
    m = Mesh()
    w, d = 20.0, 10.0
    floors = [3.2, 6.1, 9.0, 11.9]
    stone_foot(m, w, d, 1.2, STONE_DARK)
    front, right, back, left = shell(m, w, d, floors[-1], OCHRE)
    gable_roof(m, w, d, floors[-1], 4.6, SLATE, OCHRE, over=0.9, along_x=True, snow=0.45)
    rows(front, w, 2.0, 6, 1.1, 1.4, None, skip=(2, 3), margin=1.0)
    front.door(w / 2, 2.2, 2.5)
    for k, base in enumerate(floors[:-1]):
        rows(front, w, base + 1.5, 7, 0.95, 1.25, BLUE, margin=0.8)
        rows(back, w, base + 1.5, 7, 0.95, 1.25, BLUE, margin=0.8)
        rows(right, d, base + 1.5, 3, 0.95, 1.25, BLUE, margin=0.9)
        rows(left, d, base + 1.5, 3, 0.95, 1.25, BLUE, margin=0.9)
        balcony(m, front, 1.2 if k % 2 else 3.2, w - (1.2 if k % 2 else 3.2), base + 0.2, deep=0.9, col=HONEY)
    # A band under the eaves, and corner stones.
    for f, width in ((front, w), (right, d), (back, w), (left, d)):
        f.strip(0.0, floors[-1] - 0.2, width, floors[-1] - 0.2, 0.4, WHITE)
        f.strip(0.25, 0.0, 0.25, floors[-1], 0.5, WHITE)
        f.strip(width - 0.25, 0.0, width - 0.25, floors[-1], 0.5, WHITE)
    for k in range(5):
        part = Mesh()
        fr, _, _, _ = shell(part, 1.8, 2.4, 1.6, OCHRE, y0=0.0)
        fr.window(0.9, 0.85, 0.8, 0.9, None)
        gable_roof(part, 1.8, 2.4, 1.6, 0.8, SLATE, OCHRE, over=0.25, along_x=False, snow=0.28)
        m.merge(part, at=(-w / 2 + 2.6 + k * (w - 5.2) / 4, floors[-1] + 0.5, d / 2 - 1.5))
    # The porch.
    part = Mesh()
    part.box((-2.2, 0.0, 0.0), (-1.95, 2.9, 0.25), WHITE, faces="xXzZ")
    part.box((1.95, 0.0, 0.0), (2.2, 2.9, 0.25), WHITE, faces="xXzZ")
    gable_roof(part, 4.6, 2.6, 2.9, 0.9, SLATE, WHITE, over=0.3, along_x=False, snow=0.3)
    m.merge(part, at=(0.0, 0.0, d / 2 + 1.5))
    chimney(m, -w * 0.3, -1.0, floors[-1] + 2.6, floors[-1] + 6.2, wide=0.9)
    chimney(m, w * 0.28, -1.2, floors[-1] + 2.6, floors[-1] + 6.0, wide=0.9)
    return m


def church(seed):
    """The village church: a nave under a steep roof, and a square tower with a belfry and a spire."""
    m = Mesh()
    w, d, h = 7.5, 13.0, 6.5
    stone_foot(m, w, d, 0.9)
    front, right, back, left = shell(m, w, d, h, WHITE)
    gable_roof(m, w, d, h, 4.2, SHINGLE, WHITE, over=0.5, along_x=False, snow=0.4)
    for f in (right, left):
        for k in range(3):
            f.window(2.6 + k * 3.6, 3.4, 0.9, 2.6, None, arch=True)
    # The tower, at the front.
    tw, th = 4.4, 17.0
    part = Mesh()
    tf, tr, tb, tl = shell(part, tw, tw, th, WHITE)
    for f in (tf, tr, tb, tl):
        f.window(tw / 2, th - 2.6, 1.0, 2.2, None, frame=STONE, arch=True)
        f.strip(0.0, th - 5.0, tw, th - 5.0, 0.3, STONE)
        f.strip(0.0, th - 0.2, tw, th - 0.2, 0.4, STONE)
    tf.door(tw / 2, 1.6, 2.8)
    tf.window(tw / 2, 7.5, 1.3, 1.3, None, frame=STONE)
    # The spire: four steep sides, a snow blanket low on each.
    s = tw / 2 + 0.35
    apex = (0.0, th + 9.0, 0.0)
    base = [(-s, th, s), (s, th, s), (s, th, -s), (-s, th, -s)]
    for i in range(4):
        a, b = base[i], base[(i + 1) % 4]
        part.tri(a, b, apex, SLATE)
        mid_a, mid_b = lerp3(a, apex, 0.32), lerp3(b, apex, 0.32)
        nrm = norm(cross(sub(b, a), sub(apex, a)))
        lift = lambda p, k: add(p, mul3(nrm, k))
        part.quad(lift(a, 0.3), lift(b, 0.3), lift(mid_b, 0.12), lift(mid_a, 0.12), (0.9, 0.93, 1.0), [(0.6, 1.0), (0.6, 1.0), (0.25, 1.0), (0.25, 1.0)], nrm)
        part.quad(a, b, lift(b, 0.3), lift(a, 0.3), (0.9, 0.93, 1.0), [(0.0, 1.0), (0.0, 1.0), (0.6, 1.0), (0.6, 1.0)])
    part.box((-0.06, th + 9.0, -0.06), (0.06, th + 10.6, 0.06), TIMBER, faces="xXzZ")
    part.box((-0.5, th + 9.9, -0.05), (0.5, th + 10.05, 0.05), TIMBER, faces="xXyYzZ")
    m.merge(part, at=(0.0, 0.0, d / 2 + tw / 2 - 0.4))
    return m


def hut(seed):
    """The start hut on the summit: a long timber cabin on a stone foot, under a shallow roof that runs out over a porch."""
    m = Mesh()
    w, d, h = 14.0, 6.0, 3.2
    stone_foot(m, w, d, 0.7)
    front, right, back, left = shell(m, w, d, h, LARCH)
    for f, width in ((front, w), (back, w)):
        for v in (1.2, 2.0, 2.8):
            f.strip(0.0, v, width, v, 0.05, scale(LARCH, 0.75), out=0.04)
    gable_roof(m, w, d + 2.4, h, 1.7, SLATE, LARCH, over=0.9, along_x=True, snow=0.5)
    rows(front, w, 1.9, 5, 1.2, 1.0, RED, skip=(2,), margin=1.0)
    front.door(w / 2, 1.3, 2.2)
    rows(back, w, 1.9, 4, 1.2, 1.0, RED, margin=1.0)
    right.window(d / 2, 1.9, 1.2, 1.0, RED)
    left.window(d / 2, 1.9, 1.2, 1.0, RED)
    # Porch posts.
    for k in range(5):
        x = -w / 2 + 0.3 + k * (w - 0.6) / 4
        m.box((x - 0.11, -FOOT, d / 2 + 1.5), (x + 0.11, h - 0.5, d / 2 + 1.72), TIMBER, faces="xXzZ")
    chimney(m, w * 0.36, -0.6, h + 0.8, h + 2.6)
    return m


def lodge(seed):
    """The lodge: a broad timber hall with a wall of glass in its gable front, a stone chimney, and a deck round two sides."""
    m = Mesh()
    w, d, h = 14.0, 11.0, 4.2
    stone_foot(m, w, d, 1.4, STONE_DARK)
    front, right, back, left = shell(m, w, d, h, HONEY)
    gable_roof(m, w, d, h, 4.4, SLATE, HONEY, over=1.4, along_x=False, snow=0.5)
    # The gable's glass: tall lights between posts, shorter toward the eaves.
    for k in range(5):
        u = 2.0 + k * 2.5
        tall = 1.4 + 2.6 * (1 - abs(k - 2) / 2.6)
        front.window(u, h + tall / 2 - 0.2, 1.7, tall, None, frame=TIMBER)
    rows(front, w, 2.5, 5, 1.7, 2.2, None, skip=(2,), margin=0.9)
    front.door(w / 2, 1.8, 2.7, col=TIMBER)
    rows(right, d, 2.6, 3, 1.5, 1.8, GREEN, margin=1.0)
    rows(left, d, 2.6, 3, 1.5, 1.8, GREEN, margin=1.0)
    rows(back, w, 2.6, 4, 1.2, 1.4, GREEN, margin=1.0)
    # The deck, on posts, along the front and the right side.
    dk = 1.25
    deck = Mesh()
    deck.box((-w / 2 - 0.2, dk - 0.25, d / 2), (w / 2 + 4.2, dk, d / 2 + 4.6), LARCH, faces="xXyYzZ")
    deck.box((w / 2, dk - 0.25, -d / 2 + 1.0), (w / 2 + 4.2, dk, d / 2), LARCH, faces="xXyYz")
    for x, z in ((-w / 2, d / 2 + 4.4), (0.0, d / 2 + 4.4), (w / 2 + 4.0, d / 2 + 4.4), (w / 2 + 4.0, 0.0), (w / 2 + 4.0, -d / 2 + 1.2)):
        deck.box((x - 0.14, -FOOT, z - 0.14), (x + 0.14, dk - 0.25, z + 0.14), TIMBER, faces="xXzZ")
    # Its rail.
    for a, b in (((-w / 2 - 0.2, d / 2 + 4.6), (w / 2 + 4.2, d / 2 + 4.6)), ((w / 2 + 4.2, d / 2 + 4.6), (w / 2 + 4.2, -d / 2 + 1.0))):
        lo, hi = (min(a[0], b[0]) - 0.04, dk + 0.85, min(a[1], b[1]) - 0.04), (max(a[0], b[0]) + 0.04, dk + 0.97, max(a[1], b[1]) + 0.04)
        deck.box(lo, hi, TIMBER, faces="xXyYzZ")
        deck.box((lo[0], dk + 0.4, lo[2]), (hi[0], dk + 0.48, hi[2]), TIMBER, faces="xXyYzZ")
        steps = 6
        for k in range(steps + 1):
            x, z = lerp(a[0], b[0], k / steps), lerp(a[1], b[1], k / steps)
            deck.box((x - 0.06, dk, z - 0.06), (x + 0.06, dk + 0.9, z + 0.06), TIMBER, faces="xXzZ")
    m.merge(deck)
    chimney(m, -w * 0.3, -d * 0.2, h + 1.6, h + 6.6, STONE, wide=1.3)
    return m


def build():
    return {
        "chalet_a": chalet(1),
        "chalet_b": chalet(2, 10.5, 8.0, WHITE, HONEY, RED, SLATE),
        "chalet_c": chalet(3, 8.0, 7.0, OCHRE, TIMBER, BLUE, SHINGLE),
        "inn": inn(4),
        "hotel": hotel(5),
        "church": church(6),
        "hut": hut(7),
        "lodge": lodge(8),
    }
