"""Jetskis, built like the real thing: a hull lofted through its stations (a deep V with a spray rail and hard
chines, flared sides up to the rail), a deck bonded on top of it (gunwales, footwells either side of the seat's
pedestal, the console the bars stand on, the hood sloping down to the bow), a rubber bumper over the seam, a
padded seat, the steering pole with its bars and grips, the pump's nozzle at the stern, sponsons, and per model
a visor, mirrors and a grab handle.

Every model puts the rider in the same place: the footwells' floor at FLOOR under the soles (x = ±FOOT_X,
z = FOOT_Z) and the grips round the bars' pivot (PIVOT, x = ±GRIP), so one pose fits them all.
"""

import math
from dataclasses import dataclass

import numpy as np

from shapes import Builder, lerp, smoothstep

FLOOR = 0.5
FOOT_X = 0.34
FOOT_Z = -0.25
PIVOT = np.array([0.0, 1.12, 0.22])
GRIP = 0.3

# Part ids (the painters key on them).
HULL, BUMPER, DECK, SEAT, POLE, BAR, GRIPS, NOZZLE, SPONSON, VISOR, MIRROR, HANDLE, BOOT = range(1, 14)
BONES = ("ride", "bars")


@dataclass
class Ski:
    stern: float = -1.45
    bow: float = 1.65
    beam: float = 0.58
    stern_beam: float = 0.52
    widest: float = 0.36
    # How the planform closes at the bow: higher is blunter.
    bluff: float = 0.55
    rail: tuple = (0.46, 0.6)
    rise_from: float = 0.5
    rise_power: float = 2.0
    deadrise: tuple = (21.0, 36.0)
    chine: float = 0.8
    gunwale: float = 0.13
    gunwale_w: float = 0.1
    well_in: float = 0.2
    well_front: float = 0.3
    platform: float = 0.32
    seat_rear: float = -1.08
    seat_front: float = 0.06
    seat_w: float = 0.2
    seat_top: float = 0.85
    # A second, higher seat behind the first (from this z back), or none.
    seat_step: float | None = None
    seat_step_top: float = 0.92
    # A raised bolster at the seat's rear (m above the seat).
    bolster: float = 0.0
    pedestal: float = 0.66
    console: float = 0.94
    console_z: float = 0.18
    visor: float = 0.0
    mirrors: bool = False
    grab: bool = True
    sponson: float = 0.035


SKIS = {
    # Garbí's runabout: the all-rounder, a classic sit-down shape with a small visor over the gauges.
    "summer.ride.runabout": Ski(rail=(0.46, 0.64), visor=0.1),
    # Xaloc's racer: lower, narrower and longer in the nose, a deeper V, big sponsons, a slim seat with a bolster,
    # the bars on a tall riser over a low console.
    "summer.ride.racer": Ski(stern=-1.4, bow=1.72, beam=0.53, stern_beam=0.46, widest=0.32, bluff=0.42,
                             rail=(0.43, 0.56), deadrise=(23.0, 40.0), gunwale=0.11, gunwale_w=0.09, well_in=0.17,
                             seat_w=0.16, seat_top=0.82, bolster=0.07, pedestal=0.63, console=0.84, console_z=0.16,
                             grab=False, sponson=0.06),
    # Ponent's cruiser: big and comfortable, a bluff bow, high gunwales, a stepped two-up seat, a tall visor and
    # mirrors on the hood, a grab handle at the back.
    "summer.ride.cruiser": Ski(stern=-1.55, bow=1.72, beam=0.62, stern_beam=0.57, widest=0.4, bluff=0.75,
                               rail=(0.49, 0.68), deadrise=(18.0, 32.0), gunwale=0.16, gunwale_w=0.11,
                               well_in=0.21, platform=0.38, seat_rear=-1.2, seat_w=0.22, seat_top=0.86,
                               seat_step=-0.62, seat_step_top=0.93, pedestal=0.68, console=0.98, visor=0.17,
                               mirrors=True, sponson=0.03),
}


class Lines:
    """A ski's lines: its plan, sheer and keel as functions of z."""

    def __init__(self, s: Ski):
        self.s = s

    def t(self, z):
        return (z - self.s.stern) / (self.s.bow - self.s.stern)

    def beam(self, z):
        """Half-beam at the rail."""
        s, t = self.s, self.t(z)
        if t <= s.widest:
            u = t / s.widest
            return lerp(s.stern_beam, s.beam, math.sin(u * math.pi / 2) ** 0.8)
        u = min(1.0, (t - s.widest) / (1 - s.widest))
        # Rounded at the tip (a quarter ellipse), fuller or finer by `bluff`.
        return s.beam * max(0.0, 1 - u**2) ** 0.5 * (1 - (1 - s.bluff) * u)

    def rail(self, z):
        s, t = self.s, self.t(z)
        return lerp(s.rail[0], s.rail[1], t**1.6)

    def keel(self, z):
        """The keel's height: flat aft, rising in the bow to meet the rail at the stem's tip."""
        s, t = self.s, self.t(z)
        u = max(0.0, (t - s.rise_from) / (1 - s.rise_from))
        return self.rail(s.bow) * u**s.rise_power

    def deadrise(self, z):
        s, t = self.s, self.t(z)
        return math.radians(lerp(s.deadrise[0], s.deadrise[1], t**1.5))

    def chine(self, z):
        """(half-breadth, height) of the chine."""
        b = self.beam(z)
        cb = self.s.chine * b
        c = self.keel(z) + cb * math.tan(self.deadrise(z))
        return cb, min(c, self.rail(z) - 0.06 * min(1.0, b / 0.2))

    def gunwale(self, z):
        """The gunwale's top: down to the platform at the stern, full along the footwells, down to the rail at
        the bow."""
        s = self.s
        aft = smoothstep(s.stern + 0.1, s.stern + s.platform, z)
        fore = 1 - smoothstep(s.console_z, s.bow, z) ** 1.6
        return lerp(FLOOR, self.rail(z) + s.gunwale * fore, aft)

    def centre(self, z):
        """The deck's centre line: the seat's pedestal, the console rising in front of the seat, the hood sloping
        to the bow."""
        s = self.s
        top = self.rail(s.bow)
        if z < s.seat_front - 0.03:
            return lerp(FLOOR, s.pedestal, smoothstep(s.seat_rear - 0.12, s.seat_rear - 0.02, z))
        if z < s.console_z:
            return lerp(s.pedestal, s.console, smoothstep(s.seat_front - 0.03, s.console_z - 0.02, z))
        u = (z - s.console_z) / (s.bow - s.console_z)
        return top + (s.console - top) * (1 - u**1.7) ** 0.9


def stations(s: Ski):
    """Where the lines are sampled along the ski: evenly, closer at every change and toward the bow."""
    zs = list(np.linspace(s.stern, s.bow - 0.5, 24))
    zs += list(s.bow - 0.5 + 0.5 * np.sin(np.linspace(0, 1, 11) * math.pi / 2))
    for z in (s.stern + 0.02, s.stern + 0.1, s.stern + s.platform, s.seat_rear - 0.12, s.seat_rear - 0.06,
              s.seat_rear - 0.02, s.seat_front - 0.03, s.seat_front, s.console_z - 0.06, s.console_z - 0.02,
              s.well_front, s.well_front + 0.05, s.well_front + 0.1, s.well_front + 0.16):
        zs.append(z)
    zs = sorted(zs)
    out = [zs[0]]
    for z in zs[1:]:
        if z - out[-1] > 0.012:
            out.append(z)
    out[-1] = s.bow
    return out


def hull_ring(L: Lines, z):
    s = L.s
    b = L.beam(z)
    k = L.keel(z)
    r = L.rail(z)
    cb, c = L.chine(z)
    tan = math.tan(L.deadrise(z))
    f = min(1.0, b / 0.2)
    si = 0.42 * cb
    half = [
        (0.0, k),
        (si, k + si * tan),
        (si + 0.012 * f, k + si * tan + 0.002 * f),
        (cb, c),
        (cb + 0.03 * f * b / s.beam, c + 0.004 * f),
    ]
    xc, yc = half[-1]
    for u in (0.3, 0.62):
        half.append((lerp(xc, b, 1 - (1 - u) ** 1.7), lerp(yc, r, u)))
    half.append((b, r))
    right = [(x, y) for x, y in half]
    left = [(-x, y) for x, y in reversed(half[1:])]
    return np.array([(x, y, z) for x, y in right + left])


def deck_ring(L: Lines, z):
    s = L.s
    b = max(L.beam(z) - 0.004, 0.0)
    r = L.rail(z)
    g = L.gunwale(z)
    c = L.centre(z)
    f = min(1.0, b / 0.15)
    gw = s.gunwale_w * f
    # Footwells either side of the pedestal (or the console), closing up into the hood in front.
    m = float(smoothstep(s.well_front, s.well_front + 0.16, z))
    xw = max(b - gw, 0.0)
    well_x = [xw, max(xw - 0.03, s.well_in + 0.03), s.well_in + 0.025, s.well_in, s.well_in - 0.02, 0.0]
    well_x = [min(x, xw) for x in well_x]
    hood_x = [xw * k for k in (1.0, 0.8, 0.6, 0.4, 0.2, 0.0)]
    xs = [lerp(a, h, m) for a, h in zip(well_x, hood_x)]

    def hood(x):
        if xw <= 1e-6:
            return g
        return g + (c - g) * max(0.0, 1 - (abs(x) / xw) ** 2) ** 0.5

    floor = FLOOR
    well_y = [g, floor + 0.015, floor, max(floor, c - 0.03), max(floor, c - 0.006), c]
    ys = [lerp(a, hood(x), m) for a, x in zip(well_y, xs)]
    half = [(b, r), (max(b - 0.004 * f, 0.0), max(r, g - 0.035 * f)), (max(b - 0.028 * f, 0.0), g)]
    half += list(zip(xs, ys))
    right = half
    left = [(-x, y) for x, y in reversed(half[:-1])]
    ring = right + left
    return np.array([(x, y, z) for x, y in ring])


def seat_rings(s: Ski, L: Lines, n=16):
    """The seat's rings, rear to front: a rounded cushion on the pedestal, its ends rounded off."""
    zs = list(np.linspace(s.seat_rear, s.seat_front, 22))
    rings = []
    end = 0.07
    for z in zs:
        dz_r = z - s.seat_rear
        dz_f = s.seat_front - z
        u = (z - s.seat_rear) / (s.seat_front - s.seat_rear)
        w = s.seat_w * (1 - 0.25 * smoothstep(0.65, 1.0, u)) * (1 + 0.05 * math.sin(u * math.pi))
        top = s.seat_top - 0.015 * math.sin(min(1, u * 1.4) * math.pi) + 0.02 * smoothstep(0.85, 1.0, u)
        if s.seat_step is not None:
            top = lerp(s.seat_step_top, top, smoothstep(s.seat_step - 0.04, s.seat_step + 0.04, z))
        if s.bolster:
            top += s.bolster * (1 - smoothstep(s.seat_rear + 0.06, s.seat_rear + 0.22, z))
        base = L.centre(min(z, s.seat_front - 0.031)) - 0.02
        # Rounded ends: the cushion narrows and drops into the last few centimetres.
        e = min(dz_r, dz_f)
        k = math.sqrt(max(0.0, 1 - (1 - min(1.0, e / end)) ** 2)) if e < end else 1.0
        k = max(k, 0.25)
        w *= lerp(0.7, 1.0, k)
        hgt = (top - base) * lerp(0.75, 1.0, k)
        pts = []
        for i in range(n):
            a = 2 * math.pi * i / n
            ca, sa = math.cos(a), math.sin(a)
            px = math.copysign(abs(ca) ** (2 / 3.6), ca) * w
            py = math.copysign(abs(sa) ** (2 / (3.6 if sa > 0 else 6.0)), sa)
            y = base + hgt * (0.5 + 0.5 * py)
            pts.append((px, y, z))
        rings.append(np.array(pts))
    return rings


def bumper_path(L: Lines, zs):
    """Round the hull at the rail: up the right side, round the bow, down the left, across the transom."""
    s = L.s
    right = [(L.beam(z), L.rail(z), z) for z in zs if L.beam(z) > 0.01]
    tip = (0.0, L.rail(s.bow), s.bow)
    left = [(-x, y, z) for x, y, z in reversed(right)]
    b0 = L.beam(s.stern)
    r0 = L.rail(s.stern)
    back = [(-b0 + 0.03, r0, s.stern - 0.012), (0.0, r0, s.stern - 0.015), (b0 - 0.03, r0, s.stern - 0.012)]
    return np.array(right + [tip] + left + back)


def build(model: str) -> Builder:
    s = SKIS[model]
    L = Lines(s)
    zs = stations(s)
    B = Builder()
    B.loft([hull_ring(L, z) for z in zs], HULL)
    B.loft([deck_ring(L, z) for z in zs], DECK)
    # The bumper: a rubber D over the seam, proud of the hull.
    prof = np.array([(-0.01, -0.006), (0.016, -0.004), (0.026, 0.012), (0.026, 0.032), (0.016, 0.048),
                     (-0.01, 0.05)])
    B.sweep(bumper_path(L, zs), prof, BUMPER, closed_path=True)
    B.loft(seat_rings(s, L), SEAT)
    # The steering: a rubber boot out of the console, the pole's padded cover, the bars and the grips.
    top = L.centre(PIVOT[2])
    B.tube([(0, top - 0.04, PIVOT[2] + 0.01), (0, PIVOT[1] - 0.09, PIVOT[2] + 0.005)],
           lambda i: (0.06, 0.045)[i], BOOT, sides=10)
    rise = PIVOT[1] - 0.075 - (top + 0.02)
    if rise > 0.06:
        # A riser: the bars stand higher over the console.
        B.box((0, top + 0.02 + rise / 2, PIVOT[2] + 0.005), (0.08, rise + 0.02, 0.07), POLE, bone=1, round_=0.02)
    tilt = math.radians(-12)
    rot = np.array([[1, 0, 0], [0, math.cos(tilt), -math.sin(tilt)], [0, math.sin(tilt), math.cos(tilt)]])
    B.box(PIVOT + (0, -0.045, 0.01), (0.24, 0.075, 0.24), POLE, bone=1, round_=0.03, rot=rot)
    bar = PIVOT + np.array([0, -0.035, 0.035])
    xs = np.linspace(-0.37, 0.37, 13)
    path = [bar + (x, 0.012 * (abs(x) / 0.37) ** 2, -0.03 * (abs(x) / 0.37) ** 2) for x in xs]
    B.tube(path, 0.012, BAR, bone=1, sides=8, up=(0, 0, 1))
    for side in (1, -1):
        g0, g1 = 0.21, 0.375
        gp = [bar + (side * x, 0.012 * (x / 0.37) ** 2, -0.03 * (x / 0.37) ** 2) for x in np.linspace(g0, g1, 5)]
        if side < 0:
            gp = gp[::-1]
        r = [0.024, 0.019, 0.019, 0.019, 0.021] if side > 0 else [0.021, 0.019, 0.019, 0.019, 0.024]
        B.tube(gp, lambda i, r=r: r[i], GRIPS, bone=1, sides=10, up=(0, 0, 1))
    # The pump's nozzle under the platform.
    y = 0.2
    B.tube([(0, y, s.stern + 0.04), (0, y, s.stern - 0.06), (0, y, s.stern - 0.13)],
           lambda i: (0.075, 0.07, 0.06)[i], NOZZLE, sides=14, up=(0, 1, 0))
    B.tube([(0, y, s.stern - 0.11), (0, y, s.stern - 0.17)], 0.068, NOZZLE, sides=14, up=(0, 1, 0))
    # Sponsons: fins along the chines either side of the stern.
    if s.sponson:
        for side in (1, -1):
            z0 = s.stern + 0.22
            cb, c = L.chine(z0)
            b = L.beam(z0)
            xs_ = lerp(cb, b, 0.25)
            B.box((side * (xs_ + s.sponson * 0.5), c + 0.06, z0 + 0.28), (s.sponson + 0.02, 0.04, 0.55), SPONSON,
                  round_=0.012)
    if s.visor:
        # A curved visor over the gauges, leaning back.
        z0 = PIVOT[2] + 0.17
        base = L.centre(z0) - 0.02
        rows = []
        for v in np.linspace(0, 1, 4):
            ring = []
            for x in np.linspace(-0.25, 0.25, 9):
                k = 1 - (x / 0.25) ** 2
                zz = z0 + 0.05 * k - v * s.visor * 0.55
                yy = base + v * (s.visor + 0.02 * k)
                ring.append((x, yy, zz))
            rows.append(ring)
        front = [np.array(r) for r in rows]
        back = [np.array(r) - (0, 0, 0.008) for r in rows]
        # (A thin shell: the front rows, then the back rows in reverse, closed round.)
        rings = [np.vstack([f, b[::-1]]) for f, b in zip(front, back)]
        B.loft(rings, VISOR)
    if s.mirrors:
        for side in (1, -1):
            z0 = PIVOT[2] + 0.3
            x0 = 0.3
            y0 = L.centre(z0) - 0.06
            B.tube([(side * x0, y0, z0), (side * 0.38, y0 + 0.08, z0 - 0.02), (side * 0.43, y0 + 0.11, z0 - 0.03)],
                   0.012, MIRROR, sides=6)
            B.box((side * 0.47, y0 + 0.14, z0 - 0.035), (0.13, 0.075, 0.03), MIRROR, round_=0.012)
    if s.grab:
        z0 = s.seat_rear + 0.02
        p = L.centre(z0 + 0.06)
        h = s.seat_top + 0.03
        pts = [(0.14, p - 0.01, z0 + 0.04), (0.14, h - 0.04, z0 - 0.02), (0.11, h, z0 - 0.06), (0.0, h + 0.004, z0 - 0.07),
               (-0.11, h, z0 - 0.06), (-0.14, h - 0.04, z0 - 0.02), (-0.14, p - 0.01, z0 + 0.04)]
        B.tube(pts, 0.016, HANDLE, sides=8, up=(0, 0, 1))
    return B
