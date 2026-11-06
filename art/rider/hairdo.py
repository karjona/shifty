"""Hair styles built from a few shapes: shells over the scalp, sheets that fall from it and drape over the head and
the shoulders, tied tails and buns. Everything is chunky locks, the way the old consoles built hair, placed by
casting rays at the body's detailed mesh (a hair.Head), so a style sits on whichever head it is built for.

Every style is made three ways (`kind`): as it falls freely ("free"), and as it shows under a cap ("cap") or a
beanie ("beanie"): only what is below the hat's band, pressed flat under it, and whatever comes out from under
it. STYLES lists each body's styles by number (the look's `hair`).
"""

import math

import bmesh
import bpy
import numpy as np
from mathutils import Vector

import blend
import hair
import headwear
import rig
from hair import beanie_band, direction, hairline_elev
from kit import thicken
from paint import smoothstep

DOWN = np.array([0.0, 0.0, -1.0])
# Under a hat the hair is pressed down to below its lining.
HAT_LIFT = 0.01


def unit(v):
    v = np.asarray(v, dtype=np.float64)
    return v / np.linalg.norm(v)


def slerp(a, b, t):
    a, b = unit(a), unit(b)
    w = math.acos(float(np.clip(np.dot(a, b), -1.0, 1.0)))
    if w < 1e-6:
        return a
    return (math.sin((1 - t) * w) * a + math.sin(t * w) * b) / math.sin(w)


def az_el(head, p):
    """A point's azimuth (degrees from the front, + toward the rider's left) and elevation round the head."""
    r = np.asarray(p) - head.centre
    return math.degrees(math.atan2(r[0], -r[1])), math.degrees(math.asin(r[2] / np.linalg.norm(r)))


def band(head, kind, az):
    """The elevation of the hat's band at an azimuth (None bareheaded)."""
    if kind == "cap":
        return headwear.band_elev(head, az)
    if kind == "beanie":
        return beanie_band(head, az)
    return None


class Locks:
    """`n` locks round a range of `u` (0-1): each its own length, and a pointed tip of its own sharpness."""

    def __init__(self, n, seed, length=(0.75, 1.0), sharp=(1.2, 2.2), offset=0.0, point=0.35):
        rng = np.random.default_rng(seed)
        self.n, self.offset, self.point = n, offset, point
        self.length = rng.uniform(*length, n)
        self.sharp = rng.uniform(*sharp, n)

    def at(self, u):
        """(lock, how near its edge 0-1, its length there as a share of the longest)."""
        x = (u * self.n + self.offset) % self.n
        k = int(x)
        saw = abs((x - k) - 0.5) * 2
        return k, saw, self.length[k] * (self.point + (1 - self.point) * (1 - saw) ** self.sharp[k])


def drape(head, start, d0, length, steps, clear=0.012, fall=0.35, push=None):
    """A strand of hair from `start` leaving along `d0`: each step it bends toward the ground by `fall` and is kept
    `clear` off the body (head, neck, shoulders). `push(p, t)` may bend it further (a direction to add)."""
    p = np.asarray(start, dtype=np.float64)
    d = unit(d0)
    out = [p]
    seg = length / steps
    for k in range(steps):
        t = (k + 1) / steps
        d = unit(d * (1 - fall) + DOWN * fall + (push(p, t) if push else 0))
        q = p + d * seg
        loc, nrm, _, dist = head.tree.find_nearest(Vector(q))
        if loc is not None:
            loc, nrm = np.array(loc), np.array(nrm)
            if np.dot(q - loc, nrm) < 0 or dist < clear:
                q = loc + nrm * clear
                d = unit(q - p)
        out.append(q)
        p = q
    return out


class Sheet:
    """A grid of hair: columns round the head, rows from the roots to the tips. UVs run round the head (u) and
    along the hair (v), the way paint_hair draws its strands."""

    def __init__(self, name, head, rows, cols, closed=True):
        self.name, self.head = name, head
        self.P = np.zeros((rows, cols, 3))
        self.UV = np.zeros((rows, cols, 2))
        self.keep = np.ones((rows - 1, cols if closed else cols - 1), dtype=bool)
        self.closed = closed
        self.pole = None

    def bmesh(self):
        rows, cols = self.P.shape[:2]
        bm = bmesh.new()
        uvl = bm.loops.layers.uv.new("uv")
        vs = [[bm.verts.new(tuple(float(c) for c in self.P[i, j])) for j in range(cols)] for i in range(rows)]

        def face(verts, uvs):
            f = bm.faces.new(verts)
            us = [u for u, _ in uvs]
            if max(us) - min(us) > 0.5:
                uvs = [(u + 1.0 if u < 0.5 else u, v) for u, v in uvs]
            for lo, uv in zip(f.loops, uvs):
                lo[uvl].uv = uv

        for i in range(rows - 1):
            for j in range(self.keep.shape[1]):
                if not self.keep[i, j]:
                    continue
                j2 = (j + 1) % cols
                face([vs[i][j], vs[i][j2], vs[i + 1][j2], vs[i + 1][j]],
                     [tuple(self.UV[i, j]), tuple(self.UV[i, j2]), tuple(self.UV[i + 1, j2]), tuple(self.UV[i + 1, j])])
        if self.pole is not None:
            p, v = self.pole
            top = bm.verts.new(tuple(float(c) for c in p))
            for j in range(self.keep.shape[1]):
                if not self.keep[0, j]:
                    continue
                j2 = (j + 1) % cols
                face([vs[0][j2], vs[0][j], top], [tuple(self.UV[0, j2]), tuple(self.UV[0, j]), (self.UV[0, j][0], v)])
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
        return bm


def to_object(name, bm, head):
    """The hair as an object, its faces turned away from the head (all of them one way: the sheet is one
    surface)."""
    bm.normal_update()
    out = sum(float(np.dot(np.array(f.normal), np.array(f.calc_center_median()) - head.centre)) * f.calc_area()
              for f in bm.faces)
    if out < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return blend.link(bpy.data.objects.new(name, me))


def remap_uv(obj, box):
    """Moves an object's UVs (laid out in the unit square) into `box` (u0, v0, u1, v1) of the texture."""
    u0, v0, u1, v1 = box
    for d in obj.data.uv_layers.active.data:
        d.uv = (u0 + (u1 - u0) * d.uv[0], v0 + (v1 - v0) * d.uv[1])


def sheet_object(name, sheet, head, box, thickness=0.0, inner=None, rim=None):
    """A sheet as an object, its outside in `box` of the texture and (given thickness) its inside and rims in
    their own boxes."""
    obj = to_object(name, sheet.bmesh(), head)
    remap_uv(obj, box)
    if thickness:
        thicken(obj, thickness, inner_uv=inner, rim_uv=rim, even=False)
    return obj


def join(name, objs):
    blend.deselect()
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    obj = objs[0]
    obj.name = obj.data.name = name
    return obj


def weigh(obj, head, falls=True):
    """Skin weights: the head's, and for hair that hangs past the skull, the neck's and then the chest's the
    lower it falls (the sides beside the face stay with the head down to the jaw)."""
    me = obj.data
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    names = ("head", "neck", "chest")
    groups = {b: obj.vertex_groups.new(name=rig.gltf_name(b)) for b in names}
    jaw = head.eye_z - 0.1
    for i, (x, y, z) in enumerate(co):
        if not falls:
            groups["head"].add([i], 1.0, "REPLACE")
            continue
        beside_face = smoothstep(head.ear[1] + 0.01, head.ear[1] - 0.02, y)
        hi = 1.565 - (1.565 - jaw) * beside_face
        wh = smoothstep(hi - 0.06, hi, z)
        wn = smoothstep(1.4, 1.48, z)
        for b, w in zip(names, (wh, (1 - wh) * wn, (1 - wh) * (1 - wn))):
            if w > 1e-4:
                groups[b].add([i], float(w), "REPLACE")


# ---------------------------------------------------------------- shapes


def scalp(head, kind, pole, rows, cols, lift, hairline=None, groove=None):
    """A shell over the scalp from the hairline (row 0) to `pole` (a direction from the head's centre), where it
    closes: `lift(az, t)` is how far off the scalp it sits (t 0 at the hairline, 1 at the pole), `hairline(az)`
    its own edge (elevation; the head's hairline less a little by default). `groove(u, t)` pushes it in or out
    (m) along its rows. Under a hat only what is below the band is kept, pressed flat."""
    s = Sheet("scalp", head, rows + 1, cols)
    azs = [360.0 * j / cols - 180.0 for j in range(cols)]
    for j, a in enumerate(azs):
        e0 = hairline(a) if hairline else hairline_elev(head, a) - 1.5
        h0 = direction(a, e0)
        for i in range(rows + 1):
            t = i / rows
            d = slerp(h0, pole, t * 0.985)
            p, n = head.surface(d)
            off = lift(a, t)
            if groove:
                off += groove(j / cols, t)
            if kind != "free":
                off = min(off, HAT_LIFT)
            s.P[i, j] = p + n * max(off, 0.0005)
            s.UV[i, j] = (j / cols, t)
    top, _ = head.surface(pole)
    s.pole = (top + unit(pole) * (lift(0.0, 1.0) * 0.8), 1.0)
    if kind != "free":
        cut(s, head, kind)
    return s


def cut(sheet, head, kind, above=2.0):
    """Drops the faces of a sheet that are all above the hat's band (they would show through the hat)."""
    rows, cols = sheet.P.shape[:2]
    over = np.zeros((rows, cols), dtype=bool)
    for i in range(rows):
        for j in range(cols):
            a, e = az_el(head, sheet.P[i, j])
            over[i, j] = e > band(head, kind, a) + above
    for i in range(rows - 1):
        for j in range(sheet.keep.shape[1]):
            j2 = (j + 1) % cols
            if over[i, j] and over[i, j2] and over[i + 1, j] and over[i + 1, j2]:
                sheet.keep[i, j] = False
    if sheet.pole is not None and over[0].all():
        sheet.pole = None


def fall(head, kind, rows_scalp, rows_hang, cols, crown, lift, length, locks, hairline=None, clear=0.012,
         fall_rate=0.3, push=None, part=None, groove=0.006, sweep=None):
    """Hair falling from the crown: each column runs over the scalp from `crown` (a direction) to the hairline
    (`hairline(az)`, the head's own by default), then drapes `length(az)` metres on (cut into `locks`, a Locks
    round the whole head), kept `clear` of the body. `sweep(az)` turns where a column meets the hairline (degrees).
    With `part(az)` (a direction for each column) the columns start from a parting instead, and the sheet opens
    there, at the front. Grooves between the locks deepen toward the tips."""
    rows = rows_scalp + rows_hang + 1
    s = Sheet("fall", head, rows, cols, closed=part is None)
    if part is None:
        azs = [360.0 * j / cols - 180.0 for j in range(cols)]
    else:
        azs = [(1.5 + 357.0 * j / (cols - 1) + 180.0) % 360.0 - 180.0 for j in range(cols)]
    hat = kind != "free"
    for j, a in enumerate(azs):
        u = j / cols
        k, saw, share = locks.at(u)
        e0 = hairline(a) if hairline else hairline_elev(head, a) - 1.0
        a_line = a + (sweep(a) if sweep else 0.0)
        h0 = direction(a_line, e0)
        root = part(a) if part else crown
        pts, nrm = [], []
        for i in range(rows_scalp + 1):
            t = i / rows_scalp
            d = slerp(root, h0, 0.02 + 0.98 * t)
            p, n = head.surface(d)
            off = lift(a, t)
            if hat:
                off = min(off, HAT_LIFT)
            # Lock edges sink a little into the shell.
            off -= groove * 0.35 * saw**3 * smoothstep(0.3, 1.0, t)
            pts.append(p + n * max(off, 0.001))
            nrm.append(n)
        L = length(a) * share
        tail = drape(head, pts[-1], pts[-1] - pts[-2], max(L, 0.004), rows_hang, clear=clear, fall=fall_rate,
                     push=(lambda p, t, a=a: push(a, p, t)) if push else None)
        for i, q in enumerate(tail[1:], start=1):
            t = i / rows_hang
            out = q - head.centre
            out[2] = 0
            out = unit(out) if np.linalg.norm(out) > 1e-6 else DOWN
            # The locks part toward their tips: their edges sink in, their middles stand out.
            q = q - out * groove * saw**2 * t + out * 0.002 * (1 - saw) * t
            pts.append(q)
        for i, q in enumerate(pts):
            s.P[i, j] = q
            s.UV[i, j] = (u, 0.5 * i / rows_scalp if i <= rows_scalp else
                          0.5 + 0.5 * (i - rows_scalp) / rows_hang)
    if part is None:
        # Rows run from the crown: the pole closes the first.
        top, _ = head.surface(crown)
        s.pole = (top + unit(crown) * lift(0.0, 0.0) * 0.8, 0.0)
    if hat:
        cut(s, head, kind)
    return s


def tube(name, head, path, radius, flat=0.7, sides=8, tip=True, close_root=True, up_hint=(0, 0, 1)):
    """A lock or a tail along `path` (points): lens-shaped, `radius(t)` across, `flat` as deep; UVs round it (u)
    and along it (v), in the unit square."""
    path = [np.asarray(p, dtype=np.float64) for p in path]
    n = len(path)
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new("uv")
    rings = []
    prev_side = None
    for i, c in enumerate(path):
        t = i / (n - 1)
        d = unit(path[min(i + 1, n - 1)] - path[max(i - 1, 0)])
        side = np.cross(d, up_hint) if prev_side is None else prev_side - d * np.dot(prev_side, d)
        if np.linalg.norm(side) < 1e-6:
            side = np.cross(d, (1, 0, 0))
        side = unit(side)
        prev_side = side
        up = unit(np.cross(side, d))
        r = radius(t)
        ring = []
        for k in range(sides):
            ang = 2 * math.pi * k / sides
            ring.append(bm.verts.new(tuple(c + side * math.cos(ang) * r + up * math.sin(ang) * r * flat)))
        rings.append(ring)
    v0, v1 = 0.0, 1.0

    def face(verts, uvs):
        f = bm.faces.new(verts)
        for lo, q in zip(f.loops, uvs):
            lo[uvl].uv = q

    for i in range(n - 1):
        va, vb = v0 + (v1 - v0) * i / (n - 1), v0 + (v1 - v0) * (i + 1) / (n - 1)
        for k in range(sides):
            k2 = (k + 1) % sides
            ua, ub = k / sides, (k + 1) / sides
            face([rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]],
                 [(ua, va), (ub, va), (ub, vb), (ua, vb)])
    if tip:
        end = bm.verts.new(tuple(path[-1] + unit(path[-1] - path[-2]) * radius(1.0) * 0.6))
        for k in range(sides):
            k2 = (k + 1) % sides
            face([rings[-1][k], rings[-1][k2], end], [(k / sides, v1), ((k + 1) / sides, v1), ((k + 0.5) / sides, v1)])
    if close_root:
        start = bm.verts.new(tuple(path[0] - unit(path[1] - path[0]) * radius(0.0) * 0.3))
        for k in range(sides):
            k2 = (k + 1) % sides
            face([rings[0][k2], rings[0][k], start], [((k + 1) / sides, v0), (k / sides, v0), ((k + 0.5) / sides, v0)])
    bm.normal_update()
    centre = np.mean(path, axis=0)
    out = sum(float(np.dot(np.array(f.normal), np.array(f.calc_center_median()) - centre)) for f in bm.faces)
    if out < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return blend.link(bpy.data.objects.new(name, me))


def tail(head, root, out, length, radius, box, locks=5, seed=1, clear=0.014, fall_rate=0.4, steps=14):
    """A tied tail of hair from `root` (leaving along `out`): one thick lock that splits into `locks` near its
    end, draped over the back of the head and the neck; its UVs in `box` (the lock below, the ends above it)."""
    rng = np.random.default_rng(seed)
    path = drape(head, root, out, length, steps, clear=clear + radius * 0.6, fall=fall_rate)

    def r(t):
        # Gathered at the tie, full below it, thinning to the split.
        return radius * (0.55 + 0.6 * smoothstep(0.0, 0.18, t) - 0.45 * smoothstep(0.45, 1.0, t))

    u0, v0, u1, v1 = box
    vs = v0 + (v1 - v0) * 0.6
    split = int(steps * 0.62)
    body = tube("tail", head, path[: split + 1], lambda t: r(t * split / steps), flat=0.8, sides=10, tip=False)
    remap_uv(body, (u0, v0, u1, vs))
    pieces = [body]
    base = path[split]
    d = unit(path[split] - path[split - 1])
    side = unit(np.cross(d, (0, 0, 1)) if abs(d[2]) < 0.95 else np.cross(d, (1, 0, 0)))
    up = unit(np.cross(side, d))
    rest = length * (1 - split / steps)
    for k in range(locks):
        ang = 2 * math.pi * (k + rng.uniform(-0.2, 0.2)) / locks
        off = (side * math.cos(ang) + up * math.sin(ang) * 0.8) * r(split / steps) * 0.5
        spread = (side * math.cos(ang) + up * math.sin(ang)) * rng.uniform(0.12, 0.3)
        L = rest * rng.uniform(0.75, 1.15)
        p = drape(head, base + off, d + spread, L, 6, clear=clear, fall=fall_rate * 1.3)
        rr = r(split / steps) * 0.6 * rng.uniform(0.85, 1.1)
        lock = tube(f"lock{k}", head, p, lambda t, rr=rr: rr * (1 - 0.8 * t**1.3), flat=0.6, sides=6)
        remap_uv(lock, (u0 + (u1 - u0) * k / locks, vs, u0 + (u1 - u0) * (k + 1) / locks, v1))
        pieces.append(lock)
    return join("tail", pieces)


def tie(head, root, out, radius, box):
    """The band round a tail where it is tied (its UVs in `box`)."""
    d = unit(out)
    c = np.asarray(root) + d * 0.006
    obj = tube("tie", head, [c - d * 0.004, c, c + d * 0.006],
               lambda t: radius * (0.62 + 0.06 * math.sin(math.pi * t)), flat=0.85, sides=10, tip=False)
    remap_uv(obj, box)
    return obj


# ---------------------------------------------------------------- styles


def _pulled(base, front):
    """Hair pulled back tight: `base` off the scalp, a little more toward the tie, lifted `front` over the
    forehead."""
    return lambda a, t: base + 0.006 * t + front * smoothstep(70, 10, abs(a)) * math.sin(math.pi * min(t * 2.2, 1.0))


def _combed(u, t):
    """Comb lines toward the tie."""
    return 0.0011 * math.sin(u * 2 * math.pi * 26) * (1 - 0.7 * t)

# Where the texture keeps a tie's band (painted dark).
TIE_BOX = (0.0, 0.0, 0.3, 0.07)


def ponytail(head, kind):
    """Pulled back tight into a tail at the back of the head (lower under a hat, out under its edge)."""
    tie_el = {"free": 24.0, "cap": 4.0, "beanie": -13.0}[kind]
    T = direction(180, tie_el)
    sc = scalp(head, kind, T, rows=18, cols=64, lift=_pulled(0.0045, 0.006), groove=_combed)
    shell = sheet_object("shell", sc, head, (0.0, 0.08, 1.0, 0.5))
    p, n = head.surface(T)
    root = p + n * 0.012
    out = unit(direction(180, tie_el + 12)) + np.array([0, 0.25, 0])
    pieces = [shell, tail(head, root, out, 0.28, 0.034, (0.0, 0.5, 0.86, 1.0), seed=3),
              tie(head, root, out, 0.034, TIE_BOX)]
    obj = join(kind, pieces)
    obj["bands"] = [TIE_BOX]
    weigh(obj, head)
    return obj


# Each body's hair styles by number (the look's `hair`): a function of the head and how it is worn ("free",
# "cap" or "beanie") that makes the piece.
def _helmet(cut, half=True):
    def make(head, kind):
        obj = hair.helmet(head, under_cap=kind == "cap", under_beanie=kind == "beanie", cut=cut)
        obj["half"] = half and kind != "free"
        return obj

    return make


def _ring(above, azs, h, w, flow):
    """Spikes round the head at `above` degrees over the hairline (see hair.SPIKES); `flow(az)` their lean."""
    return [(az, above, h, w, flow(az)) for az in azs]


def _messy(spikes, seed, amount=1.0):
    """Each spike a little taller or shorter, a little off its place and its lean."""
    rng = np.random.default_rng(seed)
    out = []
    for az, above, h, w, flow in spikes:
        f = np.array(flow, float) + rng.normal(0, 0.15 * amount, 3) * np.array([1, 1, 0.5])
        out.append((az + rng.uniform(-4, 4) * amount, above + rng.uniform(-2, 2) * amount,
                    h * rng.uniform(1 - 0.18 * amount, 1 + 0.18 * amount), w * rng.uniform(0.9, 1.1), tuple(f)))
    return out


# A pixie crop: short locks lying back and down, a fringe swept across the forehead toward her right.
PIXIE = {
    "spikes": _messy(
        _ring(-6, range(-55, 40, 14), 0.017, 13, lambda az: (-0.9, -0.5, -0.5))
        + _ring(16, range(-168, 180, 24), 0.017, 19, lambda az: (0, 0.7, -0.6) if abs(az) > 100 else (-0.25, 0.2, 0.6))
        + _ring(36, range(-160, 180, 32), 0.016, 21, lambda az: (-0.3, 0.6, 0.3))
        + _ring(56, (0, 72, -72, 144, -144), 0.014, 23, lambda az: (-0.2, 0.5, 0.6))
        + _ring(4, (70, 92, 114, -70, -92, -114), 0.012, 12, lambda az: (0, 0.8, -0.6))
        + _ring(5, (146, 180, -146), 0.012, 14, lambda az: (0, 0.3, -1)), seed=21),
    "height": 0.74,
    "fringe": {"centre": -8.0, "full": 42.0, "none": 66.0, "span": (-70.0, 54.0), "locks": 6, "seed": 300,
               "drop": 7.0, "length": (6.0, 13.0), "sharp": (1.4, 2.4), "slope": -5.0, "sweep": -1.8},
    "lift": {"base": 0.008, "fringe": 0.005, "crown": 0.009, "edge": 0.001, "edge_fringe": 0.005},
    "tuck": 66.0,
}

# Swept back: long locks off the forehead over the top, falling to the nape, a few curling out at the back.
SWEPT = {
    "spikes": _messy(
        _ring(6, range(-50, 51, 20), 0.028, 18, lambda az: (az / 120, 1.0, 0.45))
        + _ring(24, range(-150, 151, 30), 0.03, 21,
                lambda az: (az / 200, 1.0, -0.15) if abs(az) < 100 else (0, 0.7, -0.8))
        + _ring(44, range(-160, 180, 40), 0.028, 23, lambda az: (0, 1.0, -0.2))
        + _ring(62, (0, 90, -90, 180), 0.024, 25, lambda az: (0, 1.0, 0.0))
        + _ring(4, (75, 100, 125, -75, -100, -125, 150, 180, -150), 0.016, 14, lambda az: (0, 0.8, -0.7)), seed=33),
    "height": 0.74,
    "fringe": {"centre": 0.0, "full": 30.0, "none": 50.0, "span": (-50.0, 50.0), "locks": 5, "seed": 400,
               "drop": 0.0, "length": (0.0, 3.0), "sharp": (1.2, 2.0), "slope": 0.0},
    "lift": {"base": 0.012, "fringe": 0.006, "crown": 0.01, "edge": 0.002, "edge_fringe": 0.004},
    "tuck": 50.0,
}

# A buzz cut: the shell close to the scalp, no locks.
BUZZ = {
    "spikes": [], "height": 0.74,
    "fringe": {"centre": 0.0, "full": 40.0, "none": 62.0, "span": (-60.0, 60.0), "locks": 8, "seed": 500,
               "drop": 0.0, "length": (0.0, 0.0), "sharp": (1.2, 2.2), "slope": 0.0},
    "lift": {"base": 0.0032, "fringe": 0.0, "crown": 0.0015, "edge": 0.0006, "edge_fringe": 0.0},
    "tuck": 60.0,
}


def _curls():
    """Round curls all over the scalp (a golden-angle spiral), a little bigger toward the crown."""
    out = []
    n = 64
    for k in range(n):
        t = (k + 0.5) / n
        out.append((math.degrees(k * 2.39996) % 360 - 180, 4 + 80 * t**0.8, 0.012 + 0.006 * t, 12 + 3 * t,
                    (0.0, 0.0, 0.0)))
    return _messy(out, seed=55)


# Short curls: round clumps all over, standing out from the scalp.
CURLY = {
    "spikes": _curls(), "height": 0.74, "profile": 0.55,
    "fringe": {"centre": 0.0, "full": 40.0, "none": 60.0, "span": (-60.0, 60.0), "locks": 9, "seed": 600,
               "drop": 3.0, "length": (1.5, 5.0), "sharp": (0.5, 0.9), "slope": 0.0},
    "lift": {"base": 0.012, "fringe": 0.004, "crown": 0.008, "edge": 0.002, "edge_fringe": 0.004},
    "tuck": 60.0,
}


# Where a falling sheet's texture goes: its outside, inside and rims.
FALL_BOX, FALL_IN, FALL_RIM = (0.0, 0.1, 1.0, 1.0), (0.0, 0.0, 1.0, 0.06), (0.0, 0.065, 1.0, 0.095)


def _falling(head, kind, sheet, thickness=0.006):
    obj = sheet_object(kind, sheet, head, FALL_BOX, thickness=thickness, inner=FALL_IN, rim=FALL_RIM)
    weigh(obj, head)
    return obj


def bob(head, kind):
    """A chin-length bob with a full fringe to the brows, the ends turning under."""
    locks = Locks(16, seed=7, length=(0.88, 1.0), sharp=(1.0, 1.6), point=0.62)

    def length(az):
        return float(np.interp(abs(az), [0, 30, 50, 70, 100, 140, 180], [0.04, 0.045, 0.07, 0.105, 0.11, 0.085, 0.06]))

    def push(az, p, t):
        # The ends turn under, toward the neck.
        inward = head.centre - p
        inward[2] = 0
        return unit(inward) * 0.25 * smoothstep(0.55, 1.0, t) if abs(az) > 45 else np.zeros(3)

    s = fall(head, kind, 12, 10, 64, direction(180, 70), lambda a, t: 0.011 + 0.008 * t, length, locks,
             clear=0.012, fall_rate=0.32, push=push)
    return _falling(head, kind, s)


def _centre_part(az):
    """A parting down the middle of the top: the front columns start at its front, the back ones at the crown."""
    a = abs(az)
    return direction(math.copysign(1.5, az), float(np.interp(a, [0, 40, 90, 140, 180], [62, 72, 86, 84, 72])) if a < 120
                     else float(np.interp(a, [120, 180], [86, 72])))


def long(head, kind):
    """Long and straight from a centre parting: a curtain either side of the face to the chin, the rest down the
    back past the shoulder blades."""
    locks = Locks(20, seed=11, length=(0.85, 1.0), sharp=(1.1, 1.8), point=0.5)

    def length(az):
        return float(np.interp(abs(az), [0, 20, 45, 70, 100, 140, 180], [0.13, 0.14, 0.17, 0.22, 0.25, 0.27, 0.27]))

    def push(az, p, t):
        # The sides behind the shoulders (the curtain in front of the ears and the back fall straight).
        a = abs(az)
        return np.array([0.0, 0.35, 0.0]) * smoothstep(55, 85, a) * smoothstep(150, 115, a) * smoothstep(0.2, 0.5, t)

    s = fall(head, kind, 12, 14, 64, direction(180, 72), lambda a, t: 0.009 + 0.006 * t, length, locks,
             clear=0.013, fall_rate=0.5, push=push, part=_centre_part,
             sweep=lambda a: math.copysign(max(0.0, 50 - abs(a)) * 0.75, a))
    return _falling(head, kind, s)


def surfer(head, kind):
    """Shoulder length and loose from a side parting, tucked behind the ears, the ends flicking out."""
    locks = Locks(14, seed=17, length=(0.7, 1.0), sharp=(1.2, 2.2), point=0.4)

    def length(az):
        return float(np.interp(abs(az), [0, 25, 50, 80, 110, 150, 180], [0.075, 0.085, 0.1, 0.12, 0.14, 0.15, 0.15]))

    def push(az, p, t):
        out = p - head.centre
        out[2] = 0
        # Behind the ears, and the ends out.
        return (np.array([0.0, 0.3, 0.0]) * smoothstep(60, 90, abs(az)) * smoothstep(150, 115, abs(az))
                + unit(out) * 0.3 * smoothstep(0.65, 1.0, t))

    def part(az):
        a = abs(az + 25)
        return direction(-25 + math.copysign(1.5, az + 25 if abs(az + 25) < 180 else az),
                         float(np.interp(min(a, 360 - a), [0, 40, 90, 180], [64, 76, 86, 72])))

    s = fall(head, kind, 12, 10, 64, direction(180, 72), lambda a, t: 0.012 + 0.008 * t, length, locks,
             clear=0.012, fall_rate=0.3, push=push, part=part, groove=0.008,
             sweep=lambda a: math.copysign(max(0.0, 45 - abs(a)) * 0.6, a))
    return _falling(head, kind, s)


def coil(head, centre, axis, radius, turns, rise, thick, box):
    """A bun: a lock coiled `turns` times round `axis` at `centre`, rising `rise`, tapering in."""
    axis = unit(axis)
    e1 = unit(np.cross(axis, (0, 0, 1)) if abs(axis[2]) < 0.9 else np.cross(axis, (1, 0, 0)))
    e2 = np.cross(axis, e1)
    path = []
    n = int(18 * turns)
    for k in range(n + 1):
        t = k / n
        a = 2 * math.pi * turns * t
        r = radius * (1 - 0.55 * t)
        path.append(np.asarray(centre) + (e1 * math.cos(a) + e2 * math.sin(a)) * r + axis * rise * t)
    obj = tube("bun", head, path, lambda t: thick * (1 - 0.45 * t), flat=0.85, sides=10)
    remap_uv(obj, box)
    return obj


def bun(head, kind):
    """Pulled up into a bun at the top of the back of the head (low at the nape under a hat)."""
    el = {"free": 52.0, "cap": 2.0, "beanie": -16.0}[kind]
    P = direction(180, el)
    sc = scalp(head, kind, P, rows=18, cols=64, lift=_pulled(0.005, 0.005), groove=_combed)
    shell = sheet_object("shell", sc, head, (0.0, 0.08, 1.0, 0.5))
    p, n = head.surface(P)
    root = p + n * 0.012
    pieces = [shell, coil(head, root + n * 0.012, n, 0.03, 1.7, 0.03, 0.019, (0.0, 0.5, 1.0, 1.0)),
              tie(head, root, n, 0.04, TIE_BOX)]
    obj = join(kind, pieces)
    obj["bands"] = [TIE_BOX]
    weigh(obj, head)
    return obj


def _spiky(head, kind):
    obj = hair.helmet(head, under_cap=kind == "cap", under_beanie=kind == "beanie")
    obj["half"] = kind != "free"
    return obj


STYLES = {
    "male": {0: _spiky, 1: _helmet(SWEPT), 2: _helmet(BUZZ), 3: _helmet(CURLY), 4: surfer},
    "female": {0: _helmet(PIXIE), 1: ponytail, 2: bob, 3: long, 4: bun},
}
