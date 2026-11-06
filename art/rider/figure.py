"""A rider's body: skeleton and cage, built from a body's tables (male.py, female.py).

Blender space: z up, the rider faces -y, their left is +x, metres, feet on
z = 0. Rest pose: an A-pose (arms 45 degrees down, palms toward the body).
Both bodies are built 1.78 m tall, joints at nearly the same heights; the
game scales each to its height presets.

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

# The `suit.` regions are the skin wholly under a swimsuit, carved out of the region named after them (see
# build.suit_regions): a garment that hides a region hides its suit part too.
REGIONS = ["torso", "hips", "thighs", "shins", "feet", "upperarms", "forearms", "hands", "head", "flanks", "yoke",
           "suit.torso", "suit.hips", "suit.flanks"]
R = {name: i for i, name in enumerate(REGIONS)}

N_TORSO = 16
# The arm holes in the torso's rings: the vertices they replace, per side.
HOLE = {1: (3, 4, 5), -1: (13, 12, 11)}


def arm_dir(s):
    return np.array([s * math.cos(A), 0.0, -math.sin(A)])


def arm_up(s):
    """Across the arm, toward its top (outer) side in the rest pose."""
    return np.array([s * math.sin(A), 0.0, math.cos(A)])


def smooth01(x):
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def blend_w(a, b, t):
    """Weights shared between two bones, `t` of the way from a to b."""
    t = smooth01(t)
    return {a: 1 - t, b: t}


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


class Figure:
    """A body: its tables (set by the subclass) and how a cage is built from them.

    Tables: `JOINTS` (the trunk's and one side's joints), `UPPER_ARM`, `FOREARM`, `PALM`, `TORSO` (rings from
    the crotch up: z, half width, front, back, centre y, squareness; `ARMPIT`, `CHEST_HIGH` and `SHOULDER`
    index the rings the arm holes cut), `UPPER`, `FORE`, `HAND` (arm rings: distance along the arm, top,
    bottom, front, back), `FINGERS` (across the hand, length, radius), `ARM_BUMPS`, `THIGH`, `SHIN` (leg rings:
    distance, outer, inner, front, back), `FOOT` (rings from the ankle to the toes), `CROTCH`, `NECK` (the
    neck's top ring: centre, half width, front, back, muscle), and the head's place (see `head_scaled`).
    """

    name = ""
    SWIMSUIT = False

    def __init__(self):
        self.J = self.joints()
        J = self.J
        t = {
            "root": J["root"] + (0, 0, 0.1),
            "hips": J["spine"],
            "spine": J["chest"],
            "chest": J["neck"],
            "neck": J["head"],
            "head": J["head"] + (0, 0, 0.2),
        }
        for s, L in ((1, "L"), (-1, "R")):
            t[f"clavicle.{L}"] = J[f"upperarm.{L}"]
            t[f"upperarm.{L}"] = J[f"forearm.{L}"]
            t[f"forearm.{L}"] = J[f"hand.{L}"]
            t[f"hand.{L}"] = J[f"fingers.{L}"]
            t[f"fingers.{L}"] = J[f"fingers.{L}"] + arm_dir(s) * 0.085
            t[f"thigh.{L}"] = J[f"shin.{L}"]
            t[f"shin.{L}"] = J[f"foot.{L}"]
            t[f"foot.{L}"] = J[f"toes.{L}"]
            t[f"toes.{L}"] = J[f"toes.{L}"] + (0, -0.07, 0)
        self.TAILS = t
        self._head_k = np.array([self.HEAD_SCALE * self.HEAD_WIDEN, self.HEAD_SCALE, self.HEAD_SCALE])

    # --- skeleton ----------------------------------------------------------

    def joints(self):
        j = {k: self.JOINTS[k] for k in ("root", "hips", "spine", "chest", "neck", "head")}
        for s, L in ((1, "L"), (-1, "R")):
            sh = np.array(self.JOINTS["upperarm"]) * (s, 1, 1)
            el = sh + arm_dir(s) * self.UPPER_ARM
            wr = el + arm_dir(s) * self.FOREARM
            kn = wr + arm_dir(s) * self.PALM
            j[f"clavicle.{L}"] = np.array(self.JOINTS["clavicle"]) * (s, 1, 1)
            j[f"upperarm.{L}"] = tuple(sh)
            j[f"forearm.{L}"] = tuple(el)
            j[f"hand.{L}"] = tuple(wr)
            j[f"fingers.{L}"] = tuple(kn)
            for b in ("thigh", "shin", "foot", "toes"):
                j[f"{b}.{L}"] = np.array(self.JOINTS[b]) * (s, 1, 1)
        return {k: np.array(v, dtype=np.float64) for k, v in j.items()}

    # --- torso -------------------------------------------------------------

    def torso_params(self, z):
        """The torso table's ring parameters (half width, front, back, centre y, squareness) at any height."""
        zs = [r[0] for r in self.TORSO]
        return tuple(float(np.interp(z, zs, [r[c] for r in self.TORSO])) for c in (1, 2, 3, 4, 5))

    def chest(self, k, s, c):
        """How far ring `k`'s vertex at (sin, cos) of its angle moves forward for the chest (m)."""
        return 0.0

    def torso_ring(self, k):
        z, W, F, B, yc, n = self.TORSO[k]
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
            y -= self.chest(k, s, c)
            # The shoulder ring rises to the top of the shoulders and dips at the collarbones' middle.
            if k == self.SHOULDER:
                zz += self.SHOULDER_RISE * side**3 - 0.008 * max(0.0, c) ** 4
            if k == len(self.TORSO) - 1:
                # The base of the neck: trapezius slopes up behind, collarbone notch in front.
                zz += 0.012 * max(0.0, -c) - 0.008 * max(0.0, c) ** 3
            # A shallow groove down the spine.
            if c < -0.9 and 1 <= k <= self.CHEST_HIGH:
                y -= 0.006
            pts.append(np.array([x, y, zz]))
        return pts

    def torso_weights(self, k, i):
        z = self.TORSO[k][0]
        if z < 1.0:
            w = {"hips": 1.0}
        elif z < 1.16:
            w = blend_w("hips", "spine", (z - 1.0) / 0.16)
        elif z < 1.32:
            w = blend_w("spine", "chest", (z - 1.16) / 0.16)
        else:
            w = {"chest": 1.0}
        if k >= len(self.TORSO) - 1:
            w = {"chest": 0.85, "neck": 0.15}
        for s, L in ((1, "L"), (-1, "R")):
            if k in (self.ARMPIT, self.CHEST_HIGH, self.SHOULDER) and i in HOLE[s]:
                share = {self.ARMPIT: 0.25, self.CHEST_HIGH: 0.35, self.SHOULDER: 0.4}[k]
                share *= 1.0 if i == HOLE[s][1] else 0.7
                w = {b: v * (1 - share) for b, v in w.items()}
                w[f"upperarm.{L}"] = share
        return w

    def torso_region(self, k, i):
        """Hips (under shorts), torso (under a vest or top: the front and back of the chest and belly), flanks
        (the sides under the arms) and the yoke (the top of the chest, the shoulders and the top of the back),
        which show through a vest's openings."""
        if k < 2:
            return R["hips"]
        if k >= self.CHEST_HIGH:
            return R["yoke"]
        if i in (3, 4, 11, 12) and k >= 4:
            return R["flanks"]
        return R["torso"]

    # --- arms --------------------------------------------------------------

    def arm_ring(self, s, base, dist, r_top, r_bot, r_front, r_back, bumps=()):
        d = arm_dir(s)
        e1, e2, _ = frame_of(d, (0, -1, 0))
        # e1 must point to the arm's top (outer) side.
        if np.dot(e1, arm_up(s)) < 0:
            e1 = -e1
        pts = outline(8, r_top, r_bot, r_front, r_back, power=2.1, bumps=bumps)
        return place(np.asarray(base) + d * dist, e1, e2, pts)

    def build_arm(self, cage, s, loop):
        J = self.J
        L = "L" if s > 0 else "R"
        sh, el, wr = J[f"upperarm.{L}"], J[f"forearm.{L}"], J[f"hand.{L}"]
        rings_ = []
        for k, (dist, a, b, f, bk) in enumerate(self.UPPER):
            w = {f"upperarm.{L}": 1.0} if k else {f"upperarm.{L}": 0.75, "chest": 0.25}
            if dist > self.UPPER_ARM - 0.06:
                w = blend_w(f"upperarm.{L}", f"forearm.{L}", (dist - (self.UPPER_ARM - 0.06)) / 0.12)
            rings_.append((self.arm_ring(s, sh, dist, a, b, f, bk, self.ARM_BUMPS.get(k, ())), w, R["upperarms"]))
        for k, (dist, a, b, f, bk) in enumerate(self.FORE):
            k += len(self.UPPER)
            if dist < 0.06:
                w = blend_w(f"upperarm.{L}", f"forearm.{L}", 0.5 + dist / 0.12)
            elif dist > self.FOREARM - 0.05:
                w = blend_w(f"forearm.{L}", f"hand.{L}", (dist - (self.FOREARM - 0.05)) / 0.1)
            else:
                w = {f"forearm.{L}": 1.0}
            rings_.append((self.arm_ring(s, el, dist, a, b, f, bk, self.ARM_BUMPS.get(k, ())), w, R["forearms"]))
        for k, (dist, a, b, f, bk) in enumerate(self.HAND):
            if dist <= 0.0:
                w = blend_w(f"forearm.{L}", f"hand.{L}", 0.55)
            elif dist < self.PALM - 0.01:
                w = {f"hand.{L}": 1.0}
            else:
                w = blend_w(f"hand.{L}", f"fingers.{L}", (dist - (self.PALM - 0.01)) / 0.03)
            rings_.append((self.arm_ring(s, wr, dist, a, b, f, bk), w, R["hands"]))
        verts = [cage.ring(p, w, part=f"arm.{L}") for p, w, _ in rings_]
        first = cage.bridge_aligned(loop, verts[0], R["upperarms"])
        # Keep the first ring's order for the rest.
        verts[0] = first
        for k in range(1, len(verts)):
            verts[k] = _align(verts[k - 1], verts[k])
            cage.bridge(verts[k - 1], verts[k], rings_[k][2])
        tip = np.mean([np.array(v.co[:]) for v in verts[-1]], axis=0) + arm_dir(s) * 0.006
        cage.cap(verts[-1], tip, blend_w(f"hand.{L}", f"fingers.{L}", 0.6), R["hands"], part=f"arm.{L}")
        self._fingers(cage, s)
        # Seams: around the shoulder, under the arm to the wrist, round the wrist, along the hand's edge.
        cage.seam(loop, closed=True)
        inner = _index_toward(verts[1], -arm_up(s))
        n_arm = len(self.UPPER) + len(self.FORE)
        cage.seam([loop[inner], first[inner]] + [verts[k][inner] for k in range(1, n_arm)])
        cage.seam(verts[n_arm], closed=True)
        back = _index_toward(verts[n_arm + 1], (0, 1, 0))
        cage.seam([verts[k][back] for k in range(n_arm, len(verts))])
        self._thumb(cage, s)
        return verts

    def _fingers(self, cage, s):
        """Four fingers, each its own little tube from the knuckles, slightly spread and curled toward the
        palm."""
        L = "L" if s > 0 else "R"
        wr = self.J[f"hand.{L}"]
        d = arm_dir(s)
        up = arm_up(s)
        front = np.array([0, -1.0, 0])
        for k, (across, length, r) in enumerate(self.FINGERS):
            base = wr + d * (self.PALM - 0.004) + front * across + up * 0.002
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
                w = (blend_w(f"hand.{L}", f"fingers.{L}", 0.5 + 0.5 * t) if i
                     else blend_w(f"hand.{L}", f"fingers.{L}", 0.35))
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

    def _thumb(self, cage, s):
        L = "L" if s > 0 else "R"
        wr = self.J[f"hand.{L}"]
        d = arm_dir(s)
        up = arm_up(s)
        front = np.array([0, -1.0, 0])
        k = self.HAND_SIZE
        base = wr + d * (0.022 * k) + front * (0.03 * k) - up * (0.008 * k)
        axis = d * 0.55 + front * 0.55 - up * 0.45
        axis /= np.linalg.norm(axis)
        e1, e2, _ = frame_of(axis, up)
        rs = []
        for t, r1, r2 in ((0.0, 0.016, 0.014), (0.025, 0.0135, 0.012), (0.045, 0.011, 0.01), (0.06, 0.009, 0.0085)):
            ring = cage.ring(place(base + axis * (t * k), e1, e2, outline(6, r1 * k, r1 * k, r2 * k, r2 * k)),
                             {f"hand.{L}": 1.0}, part=f"thumb.{L}")
            if rs:
                ring = _align(rs[-1], ring)
                cage.bridge(rs[-1], ring, R["hands"])
            rs.append(ring)
        back = cage.cap(rs[0], base - axis * (0.012 * k), {f"hand.{L}": 1.0}, R["hands"], part=f"thumb.{L}")
        cage.cap(rs[-1], base + axis * (0.07 * k), {f"hand.{L}": 1.0}, R["hands"], part=f"thumb.{L}")
        cage.seam([back] + [r[0] for r in rs])

    # --- legs --------------------------------------------------------------

    def leg_ring(self, s, a, b, dist, outer, inner, front, back):
        d = b - a
        d /= np.linalg.norm(d)
        e1, e2, _ = frame_of(d, (0, -1, 0))
        if np.dot(e1, (s, 0, 0)) < 0:
            e1 = -e1
        pts = outline(10, outer, inner, front, back, power=2.1, start=math.pi / 10)
        return place(a + d * dist, e1, e2, pts)

    def leg_at(self, dist, thigh_len):
        """The thigh's (outer, inner, front, back) `dist` below the hip, running on into the top of the shin."""
        return [float(np.interp(dist, [r[0] for r in self.THIGH] + [thigh_len, thigh_len + 0.1],
                                [r[k] for r in self.THIGH] + [self.SHIN[0][k], self.SHIN[2][k]]))
                for k in (1, 2, 3, 4)]

    def build_leg(self, cage, s, loop):
        J = self.J
        L = "L" if s > 0 else "R"
        hip, knee, ankle = J[f"thigh.{L}"], J[f"shin.{L}"], J[f"foot.{L}"]
        thigh_len = np.linalg.norm(knee - hip)
        shin_len = np.linalg.norm(ankle - knee)
        specs = []
        for k, (dist, o, i, f, b) in enumerate(self.THIGH):
            w = {f"thigh.{L}": 0.8, "hips": 0.2} if k == 0 else {f"thigh.{L}": 1.0}
            if dist > thigh_len - 0.07:
                w = blend_w(f"thigh.{L}", f"shin.{L}", (dist - (thigh_len - 0.07)) / 0.14)
            specs.append((self.leg_ring(s, hip, knee, dist, o, i, f, b), w, R["thighs"]))
        for dist, o, i, f, b in self.SHIN:
            if dist < 0.07:
                w = blend_w(f"thigh.{L}", f"shin.{L}", 0.5 + dist / 0.14)
            elif dist > shin_len - 0.04:
                w = blend_w(f"shin.{L}", f"foot.{L}", (dist - (shin_len - 0.04)) / 0.08)
            else:
                w = {f"shin.{L}": 1.0}
            specs.append((self.leg_ring(s, knee, ankle, dist, o, i, f, b), w, R["shins"]))
        verts = [cage.ring(p, w, part=f"leg.{L}") for p, w, _ in specs]
        verts[0] = cage.bridge_aligned(loop, verts[0], R["thighs"])
        for k in range(1, len(verts)):
            verts[k] = _align(verts[k - 1], verts[k])
            cage.bridge(verts[k - 1], verts[k], specs[k][2])
        foot = self._foot(cage, s, verts[-1])
        cage.seam(loop, closed=True)
        inner = _index_toward(verts[2], (-s, 0, 0))
        cage.seam([loop[inner]] + [v[inner] for v in verts])
        cage.seam(verts[-1], closed=True)
        return verts, foot

    def foot_point(self, s, p):
        """A point of the male-sized foot design (its left side) scaled to this body's foot, on side `s`."""
        a = self.J["foot.L"] * (1, 1, 0)
        p = a + (np.asarray(p, dtype=np.float64) - (0.102, 0.022, 0.0)) * self.FOOT_SIZE
        return p * (s, 1, 1)

    def foot_design(self, pos):
        """Points round this body's feet (an array of them) back where they are on the male-sized foot design,
        for painters drawn on that design (the inverse of `foot_point`, either side)."""
        pos = np.asarray(pos, dtype=np.float64)
        s = np.where(pos[..., :1] < 0, -1.0, 1.0) * np.array([1.0, 0.0, 0.0]) + np.array([0.0, 1.0, 1.0])
        a = self.J["foot.L"] * (1, 1, 0)
        return ((pos * s - a) / self.FOOT_SIZE + (0.102, 0.022, 0.0)) * s

    def _foot(self, cage, s, ankle_ring):
        L = "L" if s > 0 else "R"
        k = self.FOOT_SIZE
        prev = ankle_ring
        out = []
        for i, (c, axis, (o, inn, top, bottom)) in enumerate(self.FOOT):
            c = self.foot_point(s, c)
            axis = np.asarray(axis, dtype=np.float64)
            e1, e2, _ = frame_of(axis, (0, 0, 1) if i else (0, -1, 0))
            if np.dot(e1, (s, 0, 0)) < 0:
                e1 = -e1
            pts = place(c, e1, e2, outline(10, o * k, inn * k, top * k, bottom * k, power=2.2, start=math.pi / 10))
            # The heel sticks out behind the first rings.
            if i < 2:
                pts = [p + np.array([0, 0.02, -0.004]) * k * (1 - i * 0.5) * max(0.0, (p - c)[1] / (0.04 * k))
                       for p in pts]
            w = {f"foot.{L}": 1.0} if i < 3 else blend_w(f"foot.{L}", f"toes.{L}", (i - 2) / 2)
            ring = cage.ring(pts, w, part=f"leg.{L}")
            ring = _align(prev, ring)
            cage.bridge(prev, ring, R["feet"])
            out.append(ring)
            prev = ring
        tip = self.foot_point(s, np.array(self.FOOT[-1][0]) + np.array([0, -0.022, -0.002]))
        cage.cap(prev, tip, {f"toes.{L}": 1.0}, R["feet"], part=f"leg.{L}")
        sole = _index_toward(out[2], (0, 0, -1))
        cage.seam([r[sole] for r in out])
        return out

    # --- head --------------------------------------------------------------

    def head_scaled(self, p):
        """A point round the life-size head where it ends up on the body: the hair is designed round a
        life-size head, then scaled up about the bottom of the chin (`HEAD_PIVOT`, by `HEAD_SCALE`, broader
        by `HEAD_WIDEN`; below `LOWER_Z`, shorter by `LOWER_K`)."""
        p = np.array(p, dtype=np.float64)
        z = p[..., 2]
        p[..., 2] = np.where(z < self.LOWER_Z, self.LOWER_Z - (self.LOWER_Z - z) * self.LOWER_K, z)
        return self.HEAD_PIVOT + (p - self.HEAD_PIVOT) * self._head_k

    def neck_outline(self):
        """The neck's top ring, round its centre: (centre, points)."""
        c, w, f, b, m = self.NECK
        return c, outline(N_TORSO, w, w, f, b, power=2.0, start=0,
                          bumps=((math.pi / 2 - 0.75, 0.32, m), (math.pi / 2 + 0.75, 0.32, m),
                                 (-math.pi / 2 + 0.75, 0.32, m), (-math.pi / 2 - 0.75, 0.32, m)))

    # --- the whole body ------------------------------------------------------

    def build_cage(self, head_src):
        """The body's cage, with the head of `head_src` (a mhhead.Source) stitched to the neck: (cage, the
        head's mhhead.Offset)."""
        cage = rings.Cage("body")
        tr = []
        for k in range(len(self.TORSO)):
            pts = self.torso_ring(k)
            tr.append([cage.vert(p, self.torso_weights(k, i), part="torso") for i, p in enumerate(pts)])
        # Torso faces, leaving holes for the arms.
        for k in range(len(self.TORSO) - 1):
            skip = set()
            if k in (self.ARMPIT, self.CHEST_HIGH):
                skip = {3, 4, 11, 12}
            for i in range(N_TORSO):
                if i in skip:
                    continue
                j = (i + 1) % N_TORSO
                cage.face([tr[k][i], tr[k][j], tr[k + 1][j], tr[k + 1][i]], self.torso_region(k, i))
        for s in (1, -1):
            cage.bm.verts.remove(tr[self.CHEST_HIGH][HOLE[s][1]])
        loops = {}
        A_, C_, S_ = self.ARMPIT, self.CHEST_HIGH, self.SHOULDER
        for s in (1, -1):
            a, b, c = HOLE[s]
            loops[s] = [tr[A_][a], tr[A_][b], tr[A_][c], tr[C_][c], tr[S_][c], tr[S_][b], tr[S_][a], tr[C_][a]]
        # The crotch: one vertex under the middle that both legs share.
        crotch = cage.vert(self.CROTCH, {"hips": 1.0}, part="torso")
        bottom = tr[0]
        legs = {1: bottom[0:9] + [crotch], -1: bottom[8:16] + [bottom[0], crotch]}
        # A ring round the neck, and the head on it.
        centre, ring = self.neck_outline()
        pts = place(centre, np.array([1.0, 0, 0]), np.array([0, -1.0, 0]), ring)
        neck = _align(tr[-1], cage.ring(pts, blend_w("chest", "neck", 0.6), part="neck"))
        cage.bridge(tr[-1], neck, R["head"])
        off, _ = mhhead.attach(cage, neck, head_src, R["head"])
        # Seams: down the back of the torso and neck.
        cage.seam([crotch] + [tr[k][8] for k in range(len(self.TORSO))] + [neck[_index_toward(neck, (0, 1, 0))]])
        for s in (1, -1):
            self.build_arm(cage, s, loops[s])
            self.build_leg(cage, s, legs[s])
        cage.bm.verts.index_update()
        off.cage_index = [v.index for v in off.cage_verts]
        off.caps = [(c.index, ring) for c, ring in off.caps]
        return cage.finish(), off
