"""The body's drawn anatomy for the cel look: ink lines and shapes of shade, laid out on the rest pose.

A cel body is lit in two flat tones, so its anatomy is drawn, not painted: a few confident lines (collarbones,
the deltoid's edge, the elbow, the knee) and shapes the shade line is pushed into or out of (the hollow over a
collarbone, under a pec, behind a knee). `paint` returns both for any set of points on the body:

- ink: a line's coverage, 1 on its centre line and falling off as a gaussian of `SIGMA` metres, so the game
  can cut it at any width (render/cel/rider.ts); lower where the pen lifts toward a stroke's ends.
- push: how far the shade line moves there, -1 to 1 (positive: toward shade).

Strokes are drawn in each part's own coordinates: along a limb and round it, or up the trunk and round it.
"""

import numpy as np

from figure import arm_up

# How fast a line's coverage falls off from its centre (m).
SIGMA = 0.003


def _spline(pts, n=8):
    """A smooth curve through control points ((k, 2) or (k, 3) rows): Catmull-Rom, `n` steps a span."""
    p = np.asarray(pts, dtype=np.float64)
    if len(p) < 3:
        return p
    q = np.vstack([2 * p[0] - p[1], p, 2 * p[-1] - p[-2]])
    out = []
    for i in range(len(p) - 1):
        a, b, c, d = q[i], q[i + 1], q[i + 2], q[i + 3]
        for k in range(n):
            t = k / n
            out.append(0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t
                              + (-a + 3 * b - 3 * c + d) * t**3))
    out.append(p[-1])
    return np.array(out)


def _wrap(deg):
    return (deg + 180.0) % 360.0 - 180.0


class Space:
    """Points of one part in its own coordinates: `along` it (m), the angle `round` it (degrees) and how far
    from its axis (m). Distances across the surface are measured along and round it."""

    def __init__(self, on, along, around, radius):
        self.idx = np.nonzero(on)
        self.u = along[self.idx]
        self.a = around[self.idx]
        self.r = radius[self.idx]

    def _only(self, near):
        """The points picked by `near` (a mask over this space's), as a space of their own."""
        sub = Space.__new__(Space)
        sub.idx = None
        sub.u, sub.a, sub.r = self.u[near], self.a[near], self.r[near]
        return sub

    def _to_segment(self, p, q):
        """Distance from every point to the segment p-q ((along, angle) each), and how far along it (0-1)."""
        du = self.u - p[0]
        dv = np.radians(_wrap(self.a - p[1])) * self.r
        eu = q[0] - p[0]
        ev = np.radians(_wrap(q[1] - p[1])) * self.r
        ll = np.maximum(eu * eu + ev * ev, 1e-12)
        s = np.clip((du * eu + dv * ev) / ll, 0.0, 1.0)
        return np.hypot(du - s * eu, dv - s * ev), s

    def stroke(self, sheet, pts, weight=1.0, ends=(0.3, 0.3), width=1.0):
        """Draws a line through `pts` ((along, angle) control points): full pressure in the middle, lifting
        over the first and last `ends` of its length; `width` scales the line's."""
        c = _spline(pts)
        # Lengths with a typical radius, for the pressure along the stroke.
        r = float(np.median(self.r)) if len(self.r) else 0.05
        seg = np.hypot(np.diff(c[:, 0]), np.radians(_wrap(np.diff(c[:, 1]))) * r)
        total = max(seg.sum(), 1e-9)
        start = np.concatenate([[0.0], np.cumsum(seg)]) / total
        best = np.zeros(len(self.u))
        lo, hi = c[:, 0].min() - 0.03, c[:, 0].max() + 0.03
        near = (self.u > lo) & (self.u < hi)
        if not near.any():
            return
        sub = self._only(near)
        got = np.zeros(len(sub.u))
        for i in range(len(c) - 1):
            d, s = sub._to_segment(c[i], c[i + 1])
            at = start[i] + s * (start[i + 1] - start[i])
            press = np.ones_like(at)
            if ends[0] > 0:
                press = press * np.clip(at / ends[0], 0, 1) ** 0.7
            if ends[1] > 0:
                press = press * np.clip((1 - at) / ends[1], 0, 1) ** 0.7
            got = np.maximum(got, weight * press * np.exp(-((d / (SIGMA * width)) ** 2)))
        best[near] = got
        sheet.ink[self.idx] = np.maximum(sheet.ink[self.idx], best)

    def blob(self, sheet, at, size, amount, power=2.0):
        """Moves the shade line round `at` (along, angle): by `amount` there, fading over `size` (m along,
        m round)."""
        du = (self.u - at[0]) / size[0]
        dv = np.radians(_wrap(self.a - at[1])) * self.r / size[1]
        sheet.push[self.idx] += amount * np.exp(-((du * du + dv * dv) ** (power / 2)))

    def band(self, sheet, pts, size, amount):
        """Moves the shade line along a curve through `pts`, fading over `size` metres either side."""
        c = _spline(pts)
        best = np.full(len(self.u), 1e9)
        for i in range(len(c) - 1):
            d, _ = self._to_segment(c[i], c[i + 1])
            best = np.minimum(best, d)
        sheet.push[self.idx] += amount * np.exp(-((best / size) ** 2))


class Sheet:
    def __init__(self, shape):
        self.ink = np.zeros(shape)
        self.push = np.zeros(shape)


def _limb(pos, a, b, up, front=(0.0, -1.0, 0.0)):
    """Where points are round a bone from `a` to `b`: along it (m), the angle round it (0 toward `up`, 90
    toward `front`), and the distance from it."""
    a, b = np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64)
    d = b - a
    d = d / np.linalg.norm(d)
    up = np.asarray(up, dtype=np.float64)
    up = up - d * np.dot(up, d)
    up /= np.linalg.norm(up)
    fr = np.cross(d, up)
    if np.dot(fr, front) < 0:
        fr = -fr
    q = pos - a
    t = q @ d
    r = q - t[..., None] * d
    u, f = r @ up, r @ fr
    return t, np.degrees(np.arctan2(f, u)), np.hypot(u, f)


def _trunk(pos, fig):
    """Where points are round the trunk: their height, the angle round it (0 in front, 90 on the body's left)
    and the distance from its middle."""
    z = pos[..., 2]
    yc = np.interp(z, [r[0] for r in fig.TORSO], [r[4] for r in fig.TORSO])
    x, y = pos[..., 0], pos[..., 1] - yc
    return z, np.degrees(np.arctan2(x, -y)), np.hypot(x, y)


def _front(fig, x, z, back=False):
    """The angle round the trunk of the point of its surface `x` metres off the middle at height `z`, on the
    front (or the back)."""
    W, F, B, _, n = fig.torso_params(z)
    s = min(1.0, abs(x) / W) ** (n / 2.0)
    c = max(0.0, 1.0 - s * s) ** 0.5
    y = (B if back else F) * c ** (2.0 / n)
    a = np.degrees(np.arctan2(abs(x), y))
    a = 180.0 - a if back else a
    return float(np.copysign(a, x)) if x else (180.0 if back else 0.0)


def _xz(fig, pts, back=False):
    """Control points given across and up the trunk's front (x, z) as (height, angle) points."""
    return [(z, _front(fig, x, z, back)) for x, z in pts]


def paint(pos, part, parts, fig):
    """The ink and the push at points `pos` (rest pose) of parts `part` (ids, named by `parts`)."""
    ids = {name: i for i, name in parts.items()}
    sheet = Sheet(pos.shape[:-1])
    J = fig.J
    m = fig.MUSCLE
    for s, L in ((1, "L"), (-1, "R")):
        arm = part == ids.get(f"arm.{L}", -1)
        if arm.any():
            _arm(sheet, pos, arm, fig, s, L, m)
        leg = part == ids.get(f"leg.{L}", -1)
        if leg.any():
            _leg(sheet, pos, leg, fig, s, L, m)
    torso = (part == ids.get("torso", -1)) | (part == ids.get("neck", -1))
    if torso.any():
        _torso(sheet, pos, torso, fig, m)
    return np.clip(sheet.ink, 0, 1), np.clip(sheet.push, -1, 1)


def _arm(sheet, pos, on, fig, s, L, m):
    J = fig.J
    up = arm_up(s)
    U, F = fig.UPPER_ARM, fig.FOREARM
    t, ang, rad = _limb(pos, J[f"upperarm.{L}"], J[f"forearm.{L}"], up)
    upper = Space(on & (t < U + 0.03), t, ang, rad)
    # The deltoid's edge: down its front to the point where it runs into the arm, and up behind.
    tip = 0.5 * U
    upper.stroke(sheet, [(0.26 * U, 98), (0.36 * U, 72), (0.455 * U, 40), (tip, 12), (0.47 * U, -18),
                         (0.39 * U, -52), (0.3 * U, -84)], weight=0.95, ends=(0.25, 0.4))
    upper.blob(sheet, (tip + 0.035, 20), (0.03, 0.035), 0.5 * m + 0.1)
    # The biceps: its outer edge, and its swell in the light.
    upper.stroke(sheet, [(0.58 * U, 42), (0.72 * U, 50), (0.9 * U, 58)], weight=0.75 * m, ends=(0.45, 0.45),
                 width=0.9)
    upper.blob(sheet, (0.7 * U, 175), (0.09, 0.03), 0.3)
    # The triceps' horseshoe behind.
    upper.stroke(sheet, [(0.5 * U, -62), (0.64 * U, -80), (0.78 * U, -96)], weight=0.7 * m, ends=(0.4, 0.5),
                 width=0.9)
    t2, ang2, rad2 = _limb(pos, J[f"forearm.{L}"], J[f"hand.{L}"], up)
    fore = Space(on & (t2 > -0.05) & (t2 < F + 0.02), t2, ang2, rad2)
    # The crease inside the elbow, the point of the elbow behind.
    fore.stroke(sheet, [(0.004, 62), (0.012, 92), (0.006, 124)], weight=0.95, ends=(0.35, 0.35))
    fore.blob(sheet, (0.0, 95), (0.016, 0.022), 0.25)
    fore.stroke(sheet, [(-0.016, -64), (0.006, -90), (-0.012, -118)], weight=0.85, ends=(0.4, 0.4), width=0.9)
    # The forearm: the long muscle from the elbow's outside toward the thumb, the tendons at the wrist.
    fore.stroke(sheet, [(0.03, 38), (0.3 * F, 52), (0.56 * F, 70)], weight=0.8 * m + 0.1, ends=(0.3, 0.6),
                width=0.9)
    fore.blob(sheet, (0.3 * F, 150), (0.08, 0.03), 0.3)
    fore.stroke(sheet, [(0.9 * F, -74), (0.955 * F, -92), (0.985 * F, -84)], weight=0.7, ends=(0.4, 0.4),
                width=0.8)


def _leg(sheet, pos, on, fig, s, L, m):
    J = fig.J
    hip, knee, ankle = J[f"thigh.{L}"], J[f"shin.{L}"], J[f"foot.{L}"]
    T = float(np.linalg.norm(knee - hip))
    S = float(np.linalg.norm(ankle - knee))
    t, ang, rad = _limb(pos, hip, knee, (s, 0, 0))
    thigh = Space(on & (t < T + 0.02), t, ang, rad)
    # Over the knee: the muscle's teardrop inside it, and the edge of the one outside.
    thigh.stroke(sheet, [(0.7 * T, 146), (0.82 * T, 138), (0.915 * T, 118)], weight=0.85 * m + 0.1,
                 ends=(0.5, 0.25))
    thigh.stroke(sheet, [(0.72 * T, 42), (0.83 * T, 48), (0.9 * T, 62)], weight=0.7 * m, ends=(0.5, 0.3),
                 width=0.9)
    # Under the buttock.
    thigh.stroke(sheet, [(0.11 * T, -150), (0.13 * T, -112), (0.1 * T, -70)], weight=0.8, ends=(0.4, 0.5))
    thigh.blob(sheet, (0.15 * T, -110), (0.03, 0.06), 0.4)
    t2, ang2, rad2 = _limb(pos, knee, ankle, (s, 0, 0))
    shin = Space(on & (t2 > -0.06) & (t2 < S + 0.03), t2, ang2, rad2)
    # The knee cap: its sides, and the hollow under it.
    shin.stroke(sheet, [(-0.035, 58), (-0.012, 50), (0.014, 62)], weight=0.9, ends=(0.35, 0.3))
    shin.stroke(sheet, [(-0.03, 124), (-0.008, 132), (0.016, 120)], weight=0.9, ends=(0.35, 0.3))
    shin.stroke(sheet, [(0.03, 70), (0.04, 92), (0.03, 112)], weight=0.9, ends=(0.3, 0.3))
    shin.blob(sheet, (0.05, 92), (0.02, 0.025), 0.5)
    # Behind the knee.
    shin.blob(sheet, (0.0, -90), (0.035, 0.04), 0.5)
    # The shin bone's edge, the calf's two heads and where they end.
    shin.stroke(sheet, [(0.09, 100), (0.3 * S, 97), (0.62 * S, 92)], weight=0.8, ends=(0.3, 0.6), width=0.9)
    shin.stroke(sheet, [(0.3 * S, -28), (0.42 * S, -44), (0.5 * S, -74)], weight=0.75 * m + 0.1, ends=(0.5, 0.3),
                width=0.9)
    shin.stroke(sheet, [(0.32 * S, -152), (0.45 * S, -138), (0.52 * S, -110)], weight=0.75 * m + 0.1,
                ends=(0.5, 0.3), width=0.9)
    shin.blob(sheet, (0.56 * S, -90), (0.04, 0.05), 0.35)
    # The ankle bones.
    shin.stroke(sheet, [(S - 0.03, -22), (S - 0.004, 0), (S - 0.026, 24)], weight=0.75, ends=(0.4, 0.4),
                width=0.8)
    shin.stroke(sheet, [(S - 0.04, 160), (S - 0.014, 180), (S - 0.036, 202)], weight=0.75, ends=(0.4, 0.4),
                width=0.8)


def _torso(sheet, pos, on, fig, m):
    z, ang, rad = _trunk(pos, fig)
    trunk = Space(on, z, ang, rad)
    top = fig.TORSO[fig.SHOULDER][0]
    W = fig.TORSO[fig.SHOULDER][1]
    pit = fig.TORSO[fig.ARMPIT][0]
    waist = min(fig.TORSO, key=lambda r: r[1] if r[0] > 1.0 else 9)[0]
    hip = fig.TORSO[1][0]
    for s in (1, -1):
        # The collarbones, from the notch between them out to the shoulders; the hollow over each.
        trunk.stroke(sheet, _xz(fig, [(s * 0.016, top - 0.012), (s * 0.06, top - 0.004), (s * 0.11, top + 0.001),
                                      (s * (W - 0.03), top + 0.012)]), weight=1.0, ends=(0.12, 0.45))
        trunk.blob(sheet, (top + 0.02, _front(fig, s * 0.075, top)), (0.016, 0.04), 0.3)
        # The neck's cords running down into the notch.
        trunk.stroke(sheet, _xz(fig, [(s * 0.014, top - 0.014), (s * 0.03, top + 0.02), (s * 0.045, top + 0.05)]),
                     weight=0.7, ends=(0.2, 0.6), width=0.8)
        if m >= 1:
            # The pecs: under each and up toward the armpit; the shade they throw.
            low = pit - 0.052
            edge = [(s * 0.018, low + 0.004), (s * 0.07, low - 0.006), (s * 0.125, low + 0.004),
                    (s * 0.165, low + 0.034)]
            trunk.stroke(sheet, _xz(fig, edge), weight=1.0, ends=(0.2, 0.45))
            trunk.band(sheet, _xz(fig, [(x, zz - 0.016) for x, zz in edge[:3]]), 0.014, 0.6)
            # The abs: three rows either side of the middle line, and their outer edge.
            for row, zz in enumerate((low - 0.062, low - 0.118, low - 0.17)):
                trunk.stroke(sheet, _xz(fig, [(s * 0.012, zz + 0.003), (s * 0.036, zz - 0.002),
                                              (s * 0.06, zz + 0.004)]), weight=0.7 - 0.08 * row, ends=(0.35, 0.4),
                             width=0.85)
            trunk.stroke(sheet, _xz(fig, [(s * 0.082, low - 0.03), (s * 0.078, low - 0.11),
                                          (s * 0.066, low - 0.2)]), weight=0.6, ends=(0.4, 0.5), width=0.85)
        # The hip bone's line down toward the groin.
        trunk.stroke(sheet, _xz(fig, [(s * 0.125, hip + 0.085), (s * 0.1, hip + 0.04), (s * 0.06, hip - 0.02)]),
                     weight=0.75 * m + 0.15, ends=(0.35, 0.45), width=0.9)
        # Behind: the shoulder blade's edge, the dimple over the hip.
        blade = [(s * 0.055, pit + 0.07), (s * 0.075, pit + 0.02), (s * 0.115, pit - 0.03)]
        trunk.stroke(sheet, _xz(fig, blade, back=True), weight=0.75 * m + 0.1, ends=(0.4, 0.5), width=0.9)
        trunk.blob(sheet, (hip + 0.075, _front(fig, s * 0.045, hip + 0.075, back=True)), (0.012, 0.012), 0.5)
    # The notch between the collarbones, the middle line of the chest and belly, the navel.
    trunk.blob(sheet, (top - 0.008, 0), (0.012, 0.012), 0.7)
    trunk.stroke(sheet, [(pit - 0.01, 0), (pit - 0.09, 0), (waist + 0.02, 0)], weight=0.55 * m + 0.2,
                 ends=(0.3, 0.4), width=0.8)
    trunk.stroke(sheet, [(waist - 0.03, -4), (waist - 0.04, 0), (waist - 0.03, 4)], weight=0.9, ends=(0.3, 0.3),
                 width=0.9)
    # Behind: the spine's furrow.
    trunk.stroke(sheet, [(top - 0.03, 180), (pit - 0.1, 180), (waist - 0.03, 180)], weight=0.8, ends=(0.3, 0.3))
    trunk.band(sheet, [(top - 0.05, 180), (waist - 0.02, 180)], 0.012, 0.3)
