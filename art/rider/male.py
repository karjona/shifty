"""The male rider: skeleton and body cage.

Blender space: z up, the rider faces -y, their left is +x, metres, feet on
z = 0. Rest pose: an A-pose (arms 45 degrees down, palms toward the body).

The body is one cage: a torso of 16-vertex rings with holes the arms (8)
and legs (10) are bridged into, a neck, and MakeHuman's head stitched to
the neck (see mhhead).
"""

import math

import numpy as np

import mhhead
import rings
from rings import frame_of, outline, place

A = math.radians(45)
UPPER_ARM = 0.285
FOREARM = 0.262
PALM = 0.092

REGIONS = ["torso", "hips", "thighs", "shins", "feet", "upperarms", "forearms", "hands", "head", "flanks"]
R = {name: i for i, name in enumerate(REGIONS)}


def arm_dir(s):
    return np.array([s * math.cos(A), 0.0, -math.sin(A)])


def arm_up(s):
    """Across the arm, toward its top (outer) side in the rest pose."""
    return np.array([s * math.sin(A), 0.0, math.cos(A)])


def joints():
    j = {
        "root": (0, 0, 0),
        "hips": (0, 0.0, 0.965),
        "spine": (0, 0.005, 1.085),
        "chest": (0, 0.012, 1.245),
        "neck": (0, 0.03, 1.47),
        "head": (0, 0.03, 1.575),
    }
    for s, L in ((1, "L"), (-1, "R")):
        sh = np.array([s * 0.205, 0.022, 1.438])
        el = sh + arm_dir(s) * UPPER_ARM
        wr = el + arm_dir(s) * FOREARM
        kn = wr + arm_dir(s) * PALM
        j[f"clavicle.{L}"] = (s * 0.025, -0.005, 1.445)
        j[f"upperarm.{L}"] = tuple(sh)
        j[f"forearm.{L}"] = tuple(el)
        j[f"hand.{L}"] = tuple(wr)
        j[f"fingers.{L}"] = tuple(kn)
        j[f"thigh.{L}"] = (s * 0.09, 0.0, 0.93)
        j[f"shin.{L}"] = (s * 0.098, -0.01, 0.505)
        j[f"foot.{L}"] = (s * 0.102, 0.022, 0.088)
        j[f"toes.{L}"] = (s * 0.106, -0.118, 0.022)
    return {k: np.array(v, dtype=np.float64) for k, v in j.items()}


J = joints()

TAILS = {
    "root": J["root"] + (0, 0, 0.1),
    "hips": J["spine"],
    "spine": J["chest"],
    "chest": J["neck"],
    "neck": J["head"],
    "head": J["head"] + (0, 0, 0.2),
}
for _s, _L in ((1, "L"), (-1, "R")):
    TAILS[f"clavicle.{_L}"] = J[f"upperarm.{_L}"]
    TAILS[f"upperarm.{_L}"] = J[f"forearm.{_L}"]
    TAILS[f"forearm.{_L}"] = J[f"hand.{_L}"]
    TAILS[f"hand.{_L}"] = J[f"fingers.{_L}"]
    TAILS[f"fingers.{_L}"] = J[f"fingers.{_L}"] + arm_dir(_s) * 0.085
    TAILS[f"thigh.{_L}"] = J[f"shin.{_L}"]
    TAILS[f"shin.{_L}"] = J[f"foot.{_L}"]
    TAILS[f"foot.{_L}"] = J[f"toes.{_L}"]
    TAILS[f"toes.{_L}"] = J[f"toes.{_L}"] + (0, -0.07, 0)


def smooth01(x):
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def blend_w(a, b, t):
    """Weights shared between two bones, `t` of the way from a to b."""
    t = smooth01(t)
    return {a: 1 - t, b: t}


# --- torso -----------------------------------------------------------------

N_TORSO = 16
# Rings from the crotch up: z, half width, front, back, centre y, squareness.
TORSO = [
    (0.885, 0.162, 0.09, 0.11, 0.004, 2.3),
    (0.955, 0.168, 0.096, 0.116, 0.004, 2.4),
    (1.03, 0.154, 0.093, 0.098, 0.0, 2.5),
    (1.105, 0.136, 0.09, 0.088, 0.0, 2.4),
    (1.185, 0.153, 0.1, 0.093, 0.0, 2.4),
    (1.265, 0.168, 0.112, 0.1, 0.0, 2.5),
    (1.33, 0.186, 0.12, 0.104, 0.004, 2.6),
    (1.392, 0.19, 0.112, 0.104, 0.01, 2.7),
    (1.452, 0.2, 0.082, 0.09, 0.016, 2.8),
    (1.512, 0.15, 0.07, 0.08, 0.026, 2.3),
]
ARMPIT, CHEST_HIGH, SHOULDER = 6, 7, 8
HOLE = {1: (3, 4, 5), -1: (13, 12, 11)}


def torso_params(z):
    """The torso table's ring parameters (half width, front, back, centre y, squareness) at any height."""
    zs = [r[0] for r in TORSO]
    return tuple(float(np.interp(z, zs, [r[c] for r in TORSO])) for c in (1, 2, 3, 4, 5))


def torso_ring(k):
    z, W, F, B, yc, n = TORSO[k]
    pts = []
    for i in range(N_TORSO):
        t = 2 * math.pi * i / N_TORSO
        s, c = math.sin(t), math.cos(t)
        ex = 2.0 / n
        x = W * math.copysign(abs(s) ** ex, s)
        d = F if c >= 0 else B
        y = yc - d * math.copysign(abs(c) ** ex, c)
        zz = z
        side = abs(s)
        # Pecs: forward and a touch down at their lower edge.
        if k in (5, 6, 7) and c > 0.3:
            y -= {5: 0.004, 6: 0.008, 7: 0.004}[k] * (1 - abs(abs(s) - 0.45) * 1.6)
        # The shoulder ring rises to the top of the shoulders and dips at the collarbones' middle.
        if k == SHOULDER:
            zz += 0.022 * side**3 - 0.008 * max(0.0, c) ** 4
        if k == len(TORSO) - 1:
            # The base of the neck: trapezius slopes up behind, collarbone notch in front.
            zz += 0.012 * max(0.0, -c) - 0.008 * max(0.0, c) ** 3
        # A shallow groove down the spine.
        if c < -0.9 and 1 <= k <= 7:
            y -= 0.006
        pts.append(np.array([x, y, zz]))
    return pts


def torso_weights(k, i):
    z = TORSO[k][0]
    if z < 1.0:
        w = {"hips": 1.0}
    elif z < 1.16:
        w = blend_w("hips", "spine", (z - 1.0) / 0.16)
    elif z < 1.32:
        w = blend_w("spine", "chest", (z - 1.16) / 0.16)
    else:
        w = {"chest": 1.0}
    if k >= len(TORSO) - 1:
        w = {"chest": 0.85, "neck": 0.15}
    for s, L in ((1, "L"), (-1, "R")):
        if k in (ARMPIT, CHEST_HIGH, SHOULDER) and i in HOLE[s]:
            share = {ARMPIT: 0.25, CHEST_HIGH: 0.35, SHOULDER: 0.4}[k] * (1.0 if i == HOLE[s][1] else 0.7)
            w = {b: v * (1 - share) for b, v in w.items()}
            w[f"upperarm.{L}"] = share
    return w


def torso_region(k, i):
    """Hips (under shorts), torso (under a vest or top: the front and back of the chest and belly), flanks
    (the sides under the arms and the top of the chest, which show through a vest's openings)."""
    if k < 2:
        return R["hips"]
    side = i in (3, 4, 11, 12)
    if k >= 7 or (side and k >= 4):
        return R["flanks"]
    return R["torso"]


# --- arms ------------------------------------------------------------------

# (distance along the arm from the shoulder joint, top/outer, bottom/inner, front, back), m.
UPPER = [
    (0.012, 0.088, 0.056, 0.079, 0.076),
    (0.06, 0.083, 0.056, 0.077, 0.074),
    (0.12, 0.064, 0.055, 0.072, 0.068),
    (0.18, 0.053, 0.052, 0.07, 0.062),
    (0.24, 0.043, 0.043, 0.052, 0.05),
]
FORE = [
    (0.0, 0.042, 0.041, 0.046, 0.054),
    (0.04, 0.061, 0.049, 0.065, 0.054),
    (0.1, 0.055, 0.043, 0.058, 0.046),
    (0.17, 0.037, 0.033, 0.043, 0.035),
    (0.235, 0.023, 0.023, 0.034, 0.029),
]
HAND = [
    (0.0, 0.024, 0.024, 0.035, 0.031),
    (0.03, 0.024, 0.028, 0.05, 0.046),
    (0.065, 0.022, 0.024, 0.052, 0.048),
    (0.09, 0.02, 0.02, 0.05, 0.046),
    (0.102, 0.016, 0.016, 0.044, 0.04),
]
# Fingers: across the hand (front to back, m), length (m), radius (m).
FINGERS = [(0.03, 0.068, 0.0098), (0.0105, 0.078, 0.0102), (-0.0095, 0.074, 0.0098), (-0.028, 0.06, 0.009)]


# Muscle on the arm rings, by ring: (angle from the top toward the front, width, push in m).
ARM_BUMPS = {
    2: ((math.pi / 2, 0.55, 0.007), (-math.pi / 2, 0.6, 0.004)),
    3: ((math.pi / 2, 0.55, 0.006), (-math.pi / 2, 0.6, 0.005)),
    5: ((-math.pi / 2, 0.35, 0.006),),
    6: ((math.pi / 4, 0.6, 0.006), (-math.pi * 0.6, 0.5, 0.002)),
    7: ((math.pi / 4, 0.6, 0.004),),
}


def arm_ring(s, base, dist, r_top, r_bot, r_front, r_back, bumps=()):
    d = arm_dir(s)
    e1, e2, _ = frame_of(d, (0, -1, 0))
    # e1 must point to the arm's top (outer) side.
    if np.dot(e1, arm_up(s)) < 0:
        e1 = -e1
    pts = outline(8, r_top, r_bot, r_front, r_back, power=2.1, bumps=bumps)
    return place(np.asarray(base) + d * dist, e1, e2, pts)


def build_arm(cage, s, loop):
    L = "L" if s > 0 else "R"
    sh, el, wr = J[f"upperarm.{L}"], J[f"forearm.{L}"], J[f"hand.{L}"]
    rings_ = []
    for k, (dist, a, b, f, bk) in enumerate(UPPER):
        w = {f"upperarm.{L}": 1.0} if k else {f"upperarm.{L}": 0.75, "chest": 0.25}
        if dist > UPPER_ARM - 0.06:
            w = blend_w(f"upperarm.{L}", f"forearm.{L}", (dist - (UPPER_ARM - 0.06)) / 0.12)
        rings_.append((arm_ring(s, sh, dist, a, b, f, bk, ARM_BUMPS.get(k, ())), w, R["upperarms"]))
    for k, (dist, a, b, f, bk) in enumerate(FORE):
        k += len(UPPER)
        if dist < 0.06:
            w = blend_w(f"upperarm.{L}", f"forearm.{L}", 0.5 + dist / 0.12)
        elif dist > FOREARM - 0.05:
            w = blend_w(f"forearm.{L}", f"hand.{L}", (dist - (FOREARM - 0.05)) / 0.1)
        else:
            w = {f"forearm.{L}": 1.0}
        rings_.append((arm_ring(s, el, dist, a, b, f, bk, ARM_BUMPS.get(k, ())), w, R["forearms"]))
    for k, (dist, a, b, f, bk) in enumerate(HAND):
        if dist <= 0.0:
            w = blend_w(f"forearm.{L}", f"hand.{L}", 0.55)
        elif dist < PALM - 0.01:
            w = {f"hand.{L}": 1.0}
        else:
            w = blend_w(f"hand.{L}", f"fingers.{L}", (dist - (PALM - 0.01)) / 0.03)
        rings_.append((arm_ring(s, wr, dist, a, b, f, bk), w, R["hands"]))
    verts = [cage.ring(p, w, part=f"arm.{L}") for p, w, _ in rings_]
    first = cage.bridge_aligned(loop, verts[0], R["upperarms"])
    # Keep the first ring's order for the rest.
    verts[0] = first
    for k in range(1, len(verts)):
        verts[k] = _align(verts[k - 1], verts[k])
        cage.bridge(verts[k - 1], verts[k], rings_[k][2])
    tip = np.mean([np.array(v.co[:]) for v in verts[-1]], axis=0) + arm_dir(s) * 0.006
    cage.cap(verts[-1], tip, blend_w(f"hand.{L}", f"fingers.{L}", 0.6), R["hands"], part=f"arm.{L}")
    _fingers(cage, s)
    # Seams: around the shoulder, under the arm to the wrist, round the wrist, along the hand's edge.
    cage.seam(loop, closed=True)
    inner = _index_toward(verts[1], -arm_up(s))
    n_arm = len(UPPER) + len(FORE)
    cage.seam([loop[inner], first[inner]] + [verts[k][inner] for k in range(1, n_arm)])
    cage.seam(verts[n_arm], closed=True)
    back = _index_toward(verts[n_arm + 1], (0, 1, 0))
    cage.seam([verts[k][back] for k in range(n_arm, len(verts))])
    _thumb(cage, s)
    return verts


def _index_toward(ring, direction):
    c = np.mean([np.array(v.co[:]) for v in ring], axis=0)
    d = np.asarray(direction, dtype=np.float64)
    return int(np.argmax([np.dot(np.array(v.co[:]) - c, d) for v in ring]))


def _align(prev, ring):
    """`ring` rotated (and flipped) to run alongside `prev`."""
    n = len(ring)
    P = np.array([v.co[:] for v in prev])
    Q = np.array([v.co[:] for v in ring])
    P = P - P.mean(axis=0)
    Q = Q - Q.mean(axis=0)
    best = None
    for flip in (False, True):
        qq = Q[::-1] if flip else Q
        for k in range(n):
            d = np.linalg.norm(P - np.roll(qq, -k, axis=0), axis=1).sum()
            if best is None or d < best[0]:
                best = (d, flip, k)
    _, flip, k = best
    r = ring[::-1] if flip else ring
    return r[k:] + r[:k]


def _fingers(cage, s):
    """Four fingers, each its own little tube from the knuckles, slightly spread and curled toward the palm."""
    L = "L" if s > 0 else "R"
    wr = J[f"hand.{L}"]
    d = arm_dir(s)
    up = arm_up(s)
    front = np.array([0, -1.0, 0])
    for k, (across, length, r) in enumerate(FINGERS):
        base = wr + d * (PALM - 0.004) + front * across + up * 0.002
        spread = front * across * 0.18
        rings_ = []
        n = 6
        for i, t in enumerate((0.0, 0.33, 0.66, 1.0)):
            # Curl: each joint bends the finger a little toward the palm (away from `up`).
            axis = d + spread - up * (0.18 * t + 0.1 * t * t)
            axis /= np.linalg.norm(axis)
            c = base + (d + spread * 0.5 - up * 0.08 * t) * length * t
            e1, e2, _ = frame_of(axis, front)
            rr = r * (1 - 0.18 * t)
            w = blend_w(f"hand.{L}", f"fingers.{L}", 0.5 + 0.5 * t) if i else blend_w(f"hand.{L}", f"fingers.{L}", 0.35)
            ring = cage.ring(place(c, e1, e2, outline(n, rr, rr * 0.95, rr * 1.05, rr, power=2.0)), w,
                             part=f"finger.{L}")
            if rings_:
                ring = _align(rings_[-1], ring)
                cage.bridge(rings_[-1], ring, R["hands"])
            rings_.append(ring)
        cage.cap(rings_[0], base - d * 0.008, blend_w(f"hand.{L}", f"fingers.{L}", 0.3), R["hands"],
                 part=f"finger.{L}")
        end = np.mean([np.array(v.co[:]) for v in rings_[-1]], axis=0)
        cage.cap(rings_[-1], end + d * r * 0.9, {f"fingers.{L}": 1.0}, R["hands"], part=f"finger.{L}")
        cage.seam([r_[0] for r_ in rings_])


def _thumb(cage, s):
    L = "L" if s > 0 else "R"
    wr = J[f"hand.{L}"]
    d = arm_dir(s)
    up = arm_up(s)
    front = np.array([0, -1.0, 0])
    base = wr + d * 0.022 + front * 0.03 - up * 0.008
    axis = d * 0.55 + front * 0.55 - up * 0.45
    axis /= np.linalg.norm(axis)
    e1, e2, _ = frame_of(axis, up)
    rs = []
    for t, r1, r2 in ((0.0, 0.016, 0.014), (0.025, 0.0135, 0.012), (0.045, 0.011, 0.01), (0.06, 0.009, 0.0085)):
        ring = cage.ring(place(base + axis * t, e1, e2, outline(6, r1, r1, r2, r2)), {f"hand.{L}": 1.0},
                         part=f"thumb.{L}")
        if rs:
            ring = _align(rs[-1], ring)
            cage.bridge(rs[-1], ring, R["hands"])
        rs.append(ring)
    back = cage.cap(rs[0], base - axis * 0.012, {f"hand.{L}": 1.0}, R["hands"], part=f"thumb.{L}")
    cage.cap(rs[-1], base + axis * 0.07, {f"hand.{L}": 1.0}, R["hands"], part=f"thumb.{L}")
    cage.seam([back] + [r[0] for r in rs])


# --- legs ------------------------------------------------------------------

# (distance below the hip joint along the thigh, outer, inner, front, back).
THIGH = [
    (0.13, 0.094, 0.078, 0.09, 0.088),
    (0.21, 0.088, 0.072, 0.088, 0.08),
    (0.29, 0.079, 0.065, 0.081, 0.072),
    (0.36, 0.065, 0.06, 0.069, 0.06),
]
SHIN = [
    (0.0, 0.052, 0.051, 0.064, 0.052),
    (0.05, 0.051, 0.051, 0.054, 0.06),
    (0.12, 0.061, 0.066, 0.049, 0.085),
    (0.19, 0.057, 0.063, 0.046, 0.08),
    (0.27, 0.043, 0.046, 0.04, 0.053),
    (0.34, 0.034, 0.035, 0.035, 0.037),
    (0.395, 0.035, 0.036, 0.037, 0.033),
]


def leg_ring(s, a, b, dist, outer, inner, front, back):
    d = b - a
    d /= np.linalg.norm(d)
    e1, e2, _ = frame_of(d, (0, -1, 0))
    if np.dot(e1, (s, 0, 0)) < 0:
        e1 = -e1
    pts = outline(10, outer, inner, front, back, power=2.1, start=math.pi / 10)
    return place(a + d * dist, e1, e2, pts)


def build_leg(cage, s, loop):
    L = "L" if s > 0 else "R"
    hip, knee, ankle = J[f"thigh.{L}"], J[f"shin.{L}"], J[f"foot.{L}"]
    thigh_len = np.linalg.norm(knee - hip)
    shin_len = np.linalg.norm(ankle - knee)
    specs = []
    for k, (dist, o, i, f, b) in enumerate(THIGH):
        w = {f"thigh.{L}": 0.8, "hips": 0.2} if k == 0 else {f"thigh.{L}": 1.0}
        if dist > thigh_len - 0.07:
            w = blend_w(f"thigh.{L}", f"shin.{L}", (dist - (thigh_len - 0.07)) / 0.14)
        specs.append((leg_ring(s, hip, knee, dist, o, i, f, b), w, R["thighs"]))
    for dist, o, i, f, b in SHIN:
        if dist < 0.07:
            w = blend_w(f"thigh.{L}", f"shin.{L}", 0.5 + dist / 0.14)
        elif dist > shin_len - 0.04:
            w = blend_w(f"shin.{L}", f"foot.{L}", (dist - (shin_len - 0.04)) / 0.08)
        else:
            w = {f"shin.{L}": 1.0}
        specs.append((leg_ring(s, knee, ankle, dist, o, i, f, b), w, R["shins"]))
    verts = [cage.ring(p, w, part=f"leg.{L}") for p, w, _ in specs]
    verts[0] = cage.bridge_aligned(loop, verts[0], R["thighs"])
    for k in range(1, len(verts)):
        verts[k] = _align(verts[k - 1], verts[k])
        cage.bridge(verts[k - 1], verts[k], specs[k][2])
    foot = _foot(cage, s, verts[-1])
    cage.seam(loop, closed=True)
    inner = _index_toward(verts[2], (-s, 0, 0))
    cage.seam([loop[inner]] + [v[inner] for v in verts])
    cage.seam(verts[-1], closed=True)
    return verts, foot


def _foot(cage, s, ankle_ring):
    L = "L" if s > 0 else "R"
    x = s * 0.104
    path = [
        ((x, 0.018, 0.058), (0, -0.35, -0.94), (0.034, 0.034, 0.05, 0.045)),
        ((x, -0.02, 0.045), (0, -0.85, -0.5), (0.036, 0.034, 0.04, 0.04)),
        ((x + s * 0.002, -0.07, 0.038), (0, -1, -0.12), (0.042, 0.037, 0.032, 0.03)),
        ((x + s * 0.004, -0.125, 0.03), (0, -1, -0.05), (0.046, 0.04, 0.026, 0.022)),
        ((x + s * 0.004, -0.165, 0.024), (0, -1, 0.0), (0.042, 0.036, 0.02, 0.016)),
    ]
    prev = ankle_ring
    out = []
    for k, (c, axis, (o, i, top, bottom)) in enumerate(path):
        axis = np.asarray(axis, dtype=np.float64)
        e1, e2, _ = frame_of(axis, (0, 0, 1) if k else (0, -1, 0))
        if np.dot(e1, (s, 0, 0)) < 0:
            e1 = -e1
        pts = place(c, e1, e2, outline(10, o, i, top, bottom, power=2.2, start=math.pi / 10))
        # The heel sticks out behind the first rings.
        if k < 2:
            c0 = np.asarray(c, dtype=np.float64)
            pts = [p + np.array([0, 0.02, -0.004]) * (1 - k * 0.5) * max(0.0, (p - c0)[1] / 0.04) for p in pts]
        w = {f"foot.{L}": 1.0} if k < 3 else blend_w(f"foot.{L}", f"toes.{L}", (k - 2) / 2)
        ring = cage.ring(pts, w, part=f"leg.{L}")
        ring = _align(prev, ring)
        cage.bridge(prev, ring, R["feet"])
        out.append(ring)
        prev = ring
    tip = np.array(path[-1][0]) + np.array([0, -0.022, -0.002])
    cage.cap(prev, tip, {f"toes.{L}": 1.0}, R["feet"], part=f"leg.{L}")
    sole = _index_toward(out[2], (0, 0, -1))
    cage.seam([r[sole] for r in out])
    return out


# --- head ------------------------------------------------------------------

# The hair is designed round a life-size head, then scaled up about the bottom of the chin (heroic
# proportions).
HEAD_PIVOT = np.array([0.0, 0.03, 1.548])
HEAD_SCALE = 0.97
# Broader than life: wider than it is deep or tall.
HEAD_WIDEN = 1.07
_HEAD_K = np.array([HEAD_SCALE * HEAD_WIDEN, HEAD_SCALE, HEAD_SCALE])
# Below the nose, a little shorter.
LOWER_Z, LOWER_K = 1.625, 0.95


def head_scaled(p):
    """A point round the life-size head where it ends up on the body."""
    p = np.array(p, dtype=np.float64)
    z = p[..., 2]
    p[..., 2] = np.where(z < LOWER_Z, LOWER_Z - (LOWER_Z - z) * LOWER_K, z)
    return HEAD_PIVOT + (p - HEAD_PIVOT) * _HEAD_K


# --- the whole body ----------------------------------------------------------


def build_cage(head_src):
    """The body's cage, with the head of `head_src` (a mhhead.Source) stitched to the neck: (cage, the
    head's mhhead.Offset)."""
    cage = rings.Cage("body")
    tr = []
    for k in range(len(TORSO)):
        pts = torso_ring(k)
        tr.append([cage.vert(p, torso_weights(k, i), part="torso") for i, p in enumerate(pts)])
    # Torso faces, leaving holes for the arms.
    for k in range(len(TORSO) - 1):
        skip = set()
        if k in (ARMPIT, CHEST_HIGH):
            skip = {3, 4, 11, 12}
        for i in range(N_TORSO):
            if i in skip:
                continue
            j = (i + 1) % N_TORSO
            cage.face([tr[k][i], tr[k][j], tr[k + 1][j], tr[k + 1][i]], torso_region(k, i))
    for s in (1, -1):
        cage.bm.verts.remove(tr[CHEST_HIGH][HOLE[s][1]])
    loops = {}
    for s in (1, -1):
        a, b, c = HOLE[s]
        loops[s] = [tr[ARMPIT][a], tr[ARMPIT][b], tr[ARMPIT][c], tr[CHEST_HIGH][c],
                    tr[SHOULDER][c], tr[SHOULDER][b], tr[SHOULDER][a], tr[CHEST_HIGH][a]]
    # The crotch: one vertex under the middle that both legs share.
    crotch = cage.vert((0, 0.006, 0.84), {"hips": 1.0}, part="torso")
    bottom = tr[0]
    legs = {1: bottom[0:9] + [crotch], -1: bottom[8:16] + [bottom[0], crotch]}
    # A ring round the neck, and the head on it.
    pts = place((0, 0.026, 1.53), np.array([1.0, 0, 0]), np.array([0, -1.0, 0]),
                outline(N_TORSO, 0.072, 0.072, 0.056, 0.064, power=2.0, start=0,
                        bumps=((math.pi / 2 - 0.75, 0.32, 0.006), (math.pi / 2 + 0.75, 0.32, 0.006),
                               (-math.pi / 2 + 0.75, 0.32, 0.006), (-math.pi / 2 - 0.75, 0.32, 0.006))))
    neck = _align(tr[-1], cage.ring(pts, blend_w("chest", "neck", 0.6), part="neck"))
    cage.bridge(tr[-1], neck, R["head"])
    off, _ = mhhead.attach(cage, neck, head_src, R["head"])
    # Seams: down the back of the torso and neck.
    cage.seam([crotch] + [tr[k][8] for k in range(len(TORSO))] + [neck[_index_toward(neck, (0, 1, 0))]])
    for s in (1, -1):
        build_arm(cage, s, loops[s])
        build_leg(cage, s, legs[s])
    cage.bm.verts.index_update()
    off.cage_index = [v.index for v in off.cage_verts]
    off.caps = [(c.index, ring) for c, ring in off.caps]
    return cage.finish(), off
