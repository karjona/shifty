"""Snowboards, built like the real thing: a core with a sidecut between its contact points, rounded tips kicked
up (or a swallowtail's two prongs), thin at the tips and thicker underfoot, steel edges round the base, and two
bindings at the stance, duck: a baseplate, a heelcup rising into a highback, an ankle strap over the instep and a
toe strap over the toe.

The board lies along z (nose +z), base on y = 0, the toe edge toward -x (the rider faces it). Every model puts
the feet in the same place: the bindings' baseplates top out at DECK under the soles, STANCE either side of the
middle, turned out by DUCK.
"""

import math
from dataclasses import dataclass

import numpy as np

from shapes import Builder, lerp, smoothstep, to_blender

DECK = 0.03
STANCE = 0.27
# The feet's angles: both turned out toward the ends this much (rad).
DUCK = math.atan(0.3)
# The bindings' middle across the board (the boots sit centred on it).
BINDING_X = 0.0

TOP, BASE, EDGE, SIDEWALL, BASEPLATE, HIGHBACK, STRAP, BUCKLE = range(20, 28)
BONES = ("ride",)


@dataclass
class Board:
    length: float = 1.54
    # The tips: how far the outline runs past the contact points, and how high they kick up.
    nose: float = 0.17
    tail: float = 0.17
    kick_nose: float = 0.06
    kick_tail: float = 0.06
    # Half widths at the waist and the contact points.
    waist: float = 0.124
    nose_w: float = 0.146
    tail_w: float = 0.146
    # How blunt the tips are (2 = elliptical, higher is squarer).
    blunt: float = 2.6
    blunt_tail: float = 2.6
    # A swallowtail's notch depth (0 = none), and how far its prongs pinch in.
    swallow: float = 0.0
    thick: float = 0.012
    # How far the sidecut's middle is set back from the board's (m).
    setback: float = 0.0


BOARDS = {
    # Tramuntana's freestyle twin: the same both ways, soft rounded tips, an even kick.
    "winter.ride.freestyle": Board(),
    # Llevant's freeride: a long, wide, early-rising nose for powder, a short swallowtail that sinks.
    "winter.ride.freeride": Board(length=1.6, nose=0.24, tail=0.12, kick_nose=0.085, kick_tail=0.025, waist=0.127,
                                  nose_w=0.156, tail_w=0.142, blunt=2.2, swallow=0.11, setback=-0.04),
    # Xaloc's carver: long and narrow, a deep sidecut, a low nose and a squared, flat tail.
    "winter.ride.carver": Board(length=1.6, nose=0.15, tail=0.1, kick_nose=0.045, kick_tail=0.018, waist=0.112,
                                nose_w=0.138, tail_w=0.134, blunt=2.3, blunt_tail=4.5, setback=-0.02),
}


class Outline:
    def __init__(self, b: Board):
        self.b = b
        self.zn = b.length / 2 - b.nose
        self.zt = -b.length / 2 + b.tail

    def half_width(self, z):
        b = self.b
        if z > self.zn:
            d = min(1.0, (z - self.zn) / b.nose)
            return b.nose_w * max(0.0, 1 - d**b.blunt) ** (1 / b.blunt)
        if z < self.zt:
            d = min(1.0, (self.zt - z) / b.tail)
            if b.swallow:
                return b.tail_w * (1 - 0.25 * d**2)
            return b.tail_w * max(0.0, 1 - d**b.blunt_tail) ** (1 / b.blunt_tail)
        # The sidecut: an arc through the contact points, deepest at the waist.
        mid = (self.zn + self.zt) / 2 + b.setback
        u = (z - mid) / ((self.zn - self.zt) / 2)
        w_end = b.nose_w if u > 0 else b.tail_w
        return lerp(b.waist, w_end, min(1.0, u * u))

    def base(self, z):
        """The base's height: flat underfoot, kicked up at the tips."""
        b = self.b
        if z > self.zn:
            return b.kick_nose * ((z - self.zn) / b.nose) ** 2.1
        if z < self.zt:
            return b.kick_tail * ((self.zt - z) / b.tail) ** 2.1
        return 0.0

    def thickness(self, z):
        b = self.b
        u = abs(z) / (b.length / 2)
        return b.thick * lerp(1.0, 0.45, smoothstep(0.35, 1.0, u))


def board_grid(b: Board, rows=64, cols=12):
    """The board's outline as a grid (rows from tail to nose, columns from the heel edge to the toe edge): (x, z)
    per point. A swallowtail's rows end on a V, so its two prongs come out of the same grid."""
    O = Outline(b)
    z0, z1 = -b.length / 2, b.length / 2
    # Rows closer together toward the tips, where the outline turns.
    q = np.linspace(0, 1, rows + 1)
    zs = z0 + (z1 - z0) * (q - 0.035 * np.sin(2 * math.pi * q))
    pts = np.zeros((rows + 1, cols + 1, 2))
    for i, z in enumerate(zs):
        for j in range(cols + 1):
            v = 2 * j / cols - 1
            zz = z
            if b.swallow and z < O.zt:
                # Toward the tail the middle columns stop short, on the notch's V.
                d = (O.zt - z) / b.tail
                zz = lerp(O.zt, z0 + b.swallow * (1 - abs(v)) ** 1.2, d)
            w = O.half_width(zz)
            # (Columns bunch toward the edges, where the outline and the kick show.)
            x = math.copysign(abs(v) ** 0.8, v) * w
            pts[i, j] = (x, zz)
    return pts, O


def board_solid(B: Builder, b: Board):
    pts, O = board_grid(b)
    rows, cols = pts.shape[0] - 1, pts.shape[1] - 1
    bm, pl, bl = B._piece()
    made = {}

    def vert(p):
        # (Points that meet, where the outline closes at a tip, are one vertex.)
        k = tuple(np.round(p, 6))
        if k not in made:
            made[k] = bm.verts.new(to_blender(p))
        return made[k]

    top, base = [], []
    for i in range(rows + 1):
        tr, br = [], []
        for j in range(cols + 1):
            x, z = pts[i, j]
            y0 = O.base(z)
            t = O.thickness(z)
            # The top's edge sits a little in from the base's (the sidewall leans in), crowned a hair in the middle.
            v = abs(2 * j / cols - 1)
            tr.append(vert((x * (1 - 0.03 * v**8), y0 + t * (1 + 0.15 * (1 - v * v)), z)))
            br.append(vert((x, y0, z)))
        top.append(tr)
        base.append(br)
    faces = []
    for i in range(rows):
        for j in range(cols):
            # (Across, then along the board, turns clockwise seen from above: the top's faces go the other way.)
            for grid, flip in ((top, True), (base, False)):
                q = [grid[i][j], grid[i][j + 1], grid[i + 1][j + 1], grid[i + 1][j]]
                q = list(dict.fromkeys(reversed(q) if flip else q))
                if len(q) >= 3:
                    faces.append(q)
    # The sidewalls, round the grid's edge.
    ring = [(i, 0) for i in range(rows + 1)] + [(rows, j) for j in range(1, cols + 1)]
    ring += [(i, cols) for i in range(rows - 1, -1, -1)] + [(0, j) for j in range(cols - 1, 0, -1)]
    for k in range(len(ring)):
        a, c = ring[k], ring[(k + 1) % len(ring)]
        q = [base[a[0]][a[1]], base[c[0]][c[1]], top[c[0]][c[1]], top[a[0]][a[1]]]
        q = list(dict.fromkeys(q))
        if len(q) >= 3:
            faces.append(q)
    for f in faces:
        try:
            bm.faces.new(f)
        except ValueError:
            pass
    B._finish(bm, pl, bl, TOP, 0)
    return O


def binding(B: Builder, side: int, foot_len=0.34):
    """A binding at the front (+1) or back (-1) foot: its pieces in the board's frame."""
    turn = side * DUCK
    # Along the foot (heel to toe, toward -x), across it (toward the nose for the front foot), up.
    along = np.array([-math.cos(turn), 0.0, math.sin(turn)])
    across = np.array([math.sin(turn), 0.0, math.cos(turn)])
    up = np.array([0.0, 1.0, 0.0])
    centre = np.array([BINDING_X, 0.0, side * STANCE])

    def at(a, c, y):
        return centre + along * a + across * c + up * y

    heel = -foot_len / 2 + 0.01
    toe = foot_len / 2 - 0.035
    half = 0.088
    # The baseplate: a rounded plate under the whole boot.
    rows = []
    for y in (DECK - 0.017, DECK - 0.002):
        ring = []
        for k in range(24):
            th = 2 * math.pi * k / 24
            ca, sa = math.cos(th), math.sin(th)
            a = toe * abs(ca) ** 0.5 if ca > 0 else heel * abs(ca) ** 0.5
            c = half * math.copysign(abs(sa) ** 0.6, sa)
            ring.append(at(a, c, y))
        rows.append(np.array(ring))
    B.loft(rows, BASEPLATE)
    # The heelcup and the highback: a shell round the back of the heel and up the calf, leaning forward.
    R = 0.098
    ca = heel + R
    rings = []
    for h in np.linspace(0, 1, 7):
        outer, inner = [], []
        for th in np.linspace(-1.75, 1.75, 13):
            # Its top: high at the back, falling to the heelcup's wings at the sides.
            crown = 0.27 - 0.035 * min(1.0, abs(th) / 0.6) ** 2
            top = lerp(0.07, crown, float(smoothstep(1.75, 0.6, abs(th))))
            y = DECK - 0.004 + h * (top - DECK)
            lean = 0.2 * (y - DECK)
            for r, out in ((R, outer), (R - 0.009, inner)):
                out.append(at(ca - r * math.cos(th) + lean, r * math.sin(th), y))
        rings.append((np.array(outer), np.array(inner)))
    # (A thick shell: each row's outside then its inside, back round; lofted up.)
    B.loft([np.vstack([o, i[::-1]]) for o, i in rings], HIGHBACK)
    # The straps: padded bands arching over the instep and over the toe.
    for a0, width, height, span in ((-0.04, 0.055, 0.15, half + 0.012), (toe - 0.055, 0.035, 0.085, half + 0.006)):
        path = []
        for t in np.linspace(-1, 1, 15):
            ang = t * math.pi / 2
            sa, ca_ = math.sin(ang), math.cos(ang)
            path.append(at(a0, span * math.copysign(abs(sa) ** 0.55, sa), DECK + 0.006 + height * ca_**0.45))
        prof = np.array([(0.0, -width / 2), (0.0, width / 2), (0.016, width / 2), (0.016, -width / 2)])
        B.sweep(path, prof, STRAP, up=along)
        # A buckle on the strap, on the side toward the board's middle.
        B.box(at(a0, span * 0.62, DECK + 0.01 + height * 0.82), (0.03, 0.022, width * 0.85), BUCKLE,
              round_=0.006, rot=np.column_stack([across, up, along]))


def build(model: str) -> Builder:
    b = BOARDS[model]
    B = Builder()
    board_solid(B, b)
    for side in (1, -1):
        binding(B, side)
    return B
