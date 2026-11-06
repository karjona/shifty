"""The summer kit, box-modelled around a body (figure.py).

Garments are grids or cages fitted to the body by casting rays at it, given
thickness, unwrapped by construction, baked on themselves (with the body
around them for occlusion) and painted. Colourways tint them at runtime:
main, second and accent.
"""

import math

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

import blend
import figure
import rings
from paint import fbm, smoothstep
from skin import blur


class Body:
    """Ray casts against a body (`fig`, a figure.Figure; `obj`, its detailed mesh), for fitting garments to it."""

    def __init__(self, obj, fig):
        self.tree = BVHTree.FromObject(obj, bpy.context.evaluated_depsgraph_get())
        self.fig = fig

    def out(self, origin, d, reach=0.4):
        """The first surface met going out from inside the body along `d` (origin and direction in metres)."""
        o = Vector(tuple(float(c) for c in origin))
        dv = Vector(tuple(float(c) for c in d)).normalized()
        hit, normal, _, dist = self.tree.ray_cast(o, dv, reach)
        if hit is None:
            return np.array(origin) + np.array(dv) * 0.05
        return np.array(hit)

    def clear(self, p, off):
        """`p` moved out to at least `off` from the body's surface (along the surface's normal)."""
        loc, nrm, _, _ = self.tree.find_nearest(Vector(tuple(float(c) for c in p)))
        if loc is None:
            return p
        loc, nrm = np.array(loc), np.array(nrm)
        d = float(np.dot(p - loc, nrm))
        return p if d >= off else p + nrm * (off - d)


def _axis_y(fig, z):
    """The torso's middle (y) at height z, from the body's table."""
    zs = [r[0] for r in fig.TORSO]
    ys = [r[4] for r in fig.TORSO]
    return float(np.interp(z, zs, ys))


def grid_mesh(name, P, UV, keep):
    """A mesh from a grid of points (rows x cols, closed round the columns) keeping the faces `keep[i, j]`
    (between rows i, i+1 and columns j, j+1); UV per grid point (the last column's seam gets u = 1)."""
    rows, cols = P.shape[:2]
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new("uv")
    vs = [[bm.verts.new(tuple(P[i, j])) for j in range(cols)] for i in range(rows)]
    for i in range(rows - 1):
        for j in range(cols):
            if not keep[i, j]:
                continue
            j2 = (j + 1) % cols
            quad = [vs[i][j], vs[i][j2], vs[i + 1][j2], vs[i + 1][j]]
            f = bm.faces.new(quad)
            uvs = [tuple(UV[i, j]), tuple(UV[i, j2]), tuple(UV[i + 1, j2]), tuple(UV[i + 1, j])]
            us = [u for u, _ in uvs]
            if max(us) - min(us) > 0.5:
                uvs = [(u + 1.0 if u < 0.5 else u, v) for u, v in uvs]
            for lo, uv in zip(f.loops, uvs):
                lo[uvl].uv = uv
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return blend.link(bpy.data.objects.new(name, me))


def thicken(obj, thickness, inner_uv=(0.0, 0.0, 1.0, 0.05), rim_uv=(0.0, 0.055, 1.0, 0.075), even=True):
    """Gives a sheet thickness inward; the inside and the rims get their own strips of the texture. (Without
    `even` it is thinner where the sheet bends sharply, instead of shooting out spikes there.)"""
    m = obj.modifiers.new("solid", "SOLIDIFY")
    m.thickness = thickness
    m.offset = -1
    m.use_even_offset = even
    m.use_rim = True
    m.material_offset = 1
    m.material_offset_rim = 2
    if not obj.data.materials:
        for n in ("out", "in", "rim"):
            obj.data.materials.append(bpy.data.materials.get(f"kit.{n}") or bpy.data.materials.new(f"kit.{n}"))
    blend.apply_modifiers(obj)
    me = obj.data
    uv = me.uv_layers.active.data
    for p in me.polygons:
        if p.material_index == 0:
            continue
        u0, v0, u1, v1 = inner_uv if p.material_index == 1 else rim_uv
        for li in p.loop_indices:
            u, v = uv[li].uv
            uv[li].uv = (u0 + (u1 - u0) * u, v0 + (v1 - v0) * v)
    for p in me.polygons:
        p.material_index = 0
    while len(me.materials) > 1:
        me.materials.pop()


# ---------------------------------------------------------------- foam vest

VEST_BOTTOM, VEST_TOP = 1.065, 1.53
VEST_ROWS, VEST_COLS = 40, 32
ROLLS = 4
ROLL_LOW, ROLL_HIGH = 1.09, 1.425


def _theta(j, cols):
    return 360.0 * j / cols


def _sdeg(a, b):
    return (a - b + 180) % 360 - 180


ARMHOLE = (1.358, 0.098, 38.0)


def in_armhole(theta, z):
    """How far inside an armhole (theta, z) is: < 1 inside (an ellipse round each side)."""
    zc, bz, half = ARMHOLE
    best = 9.0
    for side in (90, 270):
        best = min(best, (_sdeg(theta, side) / half) ** 2 + ((z - zc) / bz) ** 2)
    return best


def to_armhole(theta, z):
    """The nearest point on an armhole's edge, in (theta, z)."""
    zc, bz, half = ARMHOLE
    side = 90 if abs(_sdeg(theta, 90)) < 90 else 270
    a, b = _sdeg(theta, side) / half, (z - zc) / bz
    r = math.hypot(a, b) or 1.0
    return side + a / r * half, zc + b / r * bz


def neckline(theta):
    """The vest's top edge at the front and back (z), by angle from the front."""
    a = abs(_sdeg(theta, 0))
    front = 1.478 + 0.045 * (a / 62) ** 1.6
    return min(front, VEST_TOP + 0.01) if a < 62 else VEST_TOP + 0.01


def panel(theta):
    """How much of the vest's front or back panel (the rolls) this angle is in: 0 on the sides."""
    a = abs(_sdeg(theta, 0))
    front = smoothstep(64, 54, a)
    back = smoothstep(126, 136, a)
    return max(front, back)


def roll_bump(z):
    """The foam rolls' height across z: rounded, with tight creases between them."""
    if z < ROLL_LOW or z > ROLL_HIGH:
        return 0.0
    f = (z - ROLL_LOW) / (ROLL_HIGH - ROLL_LOW) * ROLLS
    f -= math.floor(f)
    return math.sin(math.pi * f) ** 0.55


def vest(body):
    rows, cols = VEST_ROWS, VEST_COLS
    T = np.array([[_theta(j, cols) for j in range(cols)] for _ in range(rows + 1)])
    Z = np.array([[VEST_BOTTOM + (VEST_TOP - VEST_BOTTOM) * i / rows] * cols for i in range(rows + 1)])
    keep = np.ones((rows, cols), dtype=bool)
    hole = np.zeros((rows, cols), dtype=int)
    for i in range(rows):
        for j in range(cols):
            th = _theta(j + 0.5, cols)
            z = (Z[i, 0] + Z[i + 1, 0]) / 2
            if in_armhole(th, z) < 1:
                keep[i, j], hole[i, j] = False, 1
            elif z > neckline(th):
                keep[i, j], hole[i, j] = False, 2
    # Edge vertices go onto their opening's curve, so the edges run smooth instead of stepping.
    for i in range(1, rows):
        for j in range(cols):
            near = [(ii, jj % cols) for ii in (i - 1, i) for jj in (j - 1, j)]
            kinds = {hole[a, b] for a, b in near if not keep[a, b]}
            if not kinds or all(not keep[a, b] for a, b in near):
                continue
            th, z = T[i, j], Z[i, j]
            if kinds == {1}:
                T[i, j], Z[i, j] = to_armhole(th, z)
            elif kinds == {2}:
                Z[i, j] = min(neckline(th), VEST_TOP)
    radius = {}

    def surface(th, z):
        key = (round(th, 3), round(z, 4))
        if key not in radius:
            yc = _axis_y(body.fig, z)
            a = math.radians(th)
            hit = body.out((0, yc, z), (math.sin(a), -math.cos(a), 0.0))
            r = math.hypot(hit[0], hit[1] - yc)
            # Above the armholes the straps lie on the trapezius, not out on the shoulder caps.
            side = abs(math.sin(a))
            cap = 0.2 + (0.105 - 0.2) * smoothstep(1.43, 1.505, z)
            radius[key] = min(r, cap / max(side, 0.35)) if side > 0.35 else r
        return radius[key]

    P = np.zeros((rows + 1, cols, 3))
    UV = np.zeros((rows + 1, cols, 2))
    for i in range(rows + 1):
        for j in range(cols):
            th, z = T[i, j], Z[i, j]
            yc = _axis_y(body.fig, z)
            a = math.radians(th)
            d = np.array([math.sin(a), -math.cos(a), 0.0])
            r = surface(th, z)
            # The vest hangs straight from the chest: below it, it doesn't follow the waist in.
            if z < 1.27:
                r = r + 0.55 * max(0.0, surface(th, 1.27) - r)
            foam = 0.024 + 0.01 * panel(th)
            roll = 0.026 * roll_bump(z) * panel(th)
            flare = 0.008 * smoothstep(1.12, VEST_BOTTOM, z)
            P[i, j] = np.array([0, yc, z]) + d * (r + foam + roll + flare)
            UV[i, j] = ((th / 360 + 0.5) % 1.0, 0.08 + 0.92 * (z - VEST_BOTTOM) / (VEST_TOP - VEST_BOTTOM))
    obj = grid_mesh("vest", P, UV, keep)
    thicken(obj, 0.012)
    return obj


def _edges_dist(pos, z_hem=VEST_BOTTOM):
    """Distance (m, roughly) from each texel to the vest's openings, for piping."""
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    th = np.degrees(np.arctan2(x, -y)) % 360
    r = np.hypot(x, y)
    d = np.abs(z - z_hem)
    a = np.abs((th + 180) % 360 - 180)
    nl = np.where(a < 62, np.minimum(1.478 + 0.045 * (a / 62) ** 1.6, VEST_TOP), VEST_TOP)
    d = np.minimum(d, np.abs(z - nl))
    zc, bz, half = ARMHOLE
    for side in (90, 270):
        da = ((th - side + 180) % 360 - 180) / half
        db = (z - zc) / bz
        e = np.hypot(da, db)
        # Distance from the ellipse, scaled to metres by its size.
        scale = np.where(np.abs(db) > np.abs(da), bz, np.radians(half) * r)
        d = np.minimum(d, np.abs(e - 1) * scale)
    return d


def paint_vest(maps):
    inside = maps["inside"]
    pos = maps["pos"]
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    ax = np.abs(x)
    th = np.degrees(np.arctan2(x, -y)) % 360
    L = blur(maps["light"], inside, 2)
    ref = np.percentile(L[inside], 85) if inside.any() else 1.0
    s = np.clip(L / ref, 0, 1.5)
    ao = np.clip(blur(maps["ao"], inside, 2), 0, 1)
    s = s * (0.45 + 0.55 * ao)
    from skin import masses

    s = masses(s, centre=0.85, sharp=3.0, amount=0.5)
    pan = np.vectorize(panel)(th)
    # The rolls: a sheen along each crown, dark creases between them.
    f = (z - ROLL_LOW) / (ROLL_HIGH - ROLL_LOW) * ROLLS
    frac = f - np.floor(f)
    in_rolls = (z > ROLL_LOW) & (z < ROLL_HIGH)
    crown = np.exp(-(((frac - 0.62) / 0.16) ** 2)) * in_rolls * pan
    crease = (np.exp(-((frac / 0.07) ** 2)) + np.exp(-(((frac - 1) / 0.07) ** 2))) * in_rolls * pan
    s = s * (1 + 0.85 * crown - 0.65 * crease)
    g = 0.5 * s
    # Sunlit highlights warm toward orange, creases toward a deep wine.
    hi = np.clip(s - 1, 0, 1)[..., None]
    lo = np.clip(1 - s, 0, 1)[..., None]
    detail = g[..., None] * (1 + hi * np.array([0.0, 0.35, 0.05]) + lo * np.array([0.0, -0.15, -0.05]))
    mask = np.zeros_like(detail)
    mask[..., 0] = 1
    # Side panels and the shoulders in the second colour, with a mesh texture.
    side = 1 - pan
    shoulder = smoothstep(1.43, 1.45, z) * (1 - smoothstep(0.0, 0.02, -y - 0.09))
    second = np.clip(np.maximum(side, shoulder * (pan < 0.99)), 0, 1)
    mesh = (np.sin(x * 700 + z * 120) * np.sin(z * 700) > 0.25) * second
    detail = detail * (1 - 0.1 * mesh[..., None])
    mask = mask * (1 - second[..., None]) + np.array([0, 1.0, 0]) * second[..., None]
    # Accent piping round every opening and down the zip; a zip pull.
    edge = _edges_dist(pos)
    piping = smoothstep(0.0055, 0.0035, edge)
    zipline = smoothstep(0.004, 0.0025, ax) * (y < -0.04)
    acc = np.clip(piping + zipline, 0, 1)
    detail = detail * (1 - acc[..., None]) + np.repeat((0.55 * np.clip(s, 0.4, 1.3))[..., None], 3, axis=2) * acc[..., None]
    mask = mask * (1 - acc[..., None]) + np.array([0, 0, 1.0]) * acc[..., None]
    teeth = zipline * (np.sin(z * 2400) > 0) * smoothstep(0.0025, 0.001, ax)
    detail = detail * (1 - 0.35 * teeth[..., None])
    pull = np.exp(-((ax / 0.006) ** 2) - ((z - 1.44) / 0.012) ** 2) * (y < -0.05)
    detail = detail * (1 - pull[..., None]) + np.array([0.06, 0.06, 0.07]) * pull[..., None]
    mask = mask * (1 - pull[..., None])
    # The inside and the rims, dark.
    v = np.linspace(1, 0, inside.shape[0])[:, None] * np.ones((1, inside.shape[1]))
    inner = v < 0.078
    detail = np.where(inner[..., None], detail * 0.45, detail)
    return np.clip(detail, 0, 1), np.clip(mask, 0, 1)


def lift_uvs(obj, v0=0.08):
    """Moves the outside's UVs up so the inside and rims (see `thicken`) get the bottom strip."""
    uv = obj.data.uv_layers.active.data
    for d in uv:
        d.uv = (d.uv[0], v0 + (1 - v0) * d.uv[1])


# ---------------------------------------------------------------- boardshorts

HEM = 0.5


def shorts(fig):
    """Loose boardshorts: a waistband at the hips, legs wide to just below the knee."""
    import uv as uvs

    cage = rings.Cage("shorts")
    R = figure.R
    waist = []
    for z, grow in ((1.085, 0.012), (1.04, 0.015), (0.98, 0.018), (0.93, 0.021), (0.885, 0.024)):
        W, F, B, yc, n = fig.torso_params(z)
        pts = []
        for i in range(figure.N_TORSO):
            t = 2 * math.pi * i / figure.N_TORSO
            s_, c_ = math.sin(t), math.cos(t)
            ex = 2.0 / n
            x = (W + grow) * math.copysign(abs(s_) ** ex, s_)
            d = (F + grow) if c_ >= 0 else (B + grow)
            y = yc - d * math.copysign(abs(c_) ** ex, c_)
            pts.append(np.array([x, y, z]))
        waist.append(cage.ring(pts, fig.torso_weights(0, 0) if z < 1.0 else figure.blend_w("hips", "spine", 0.4),
                               part="shorts"))
    for a, b in zip(waist, waist[1:]):
        cage.bridge(a, b, R["hips"])
    crotch = cage.vert((0, 0.008, 0.795), {"hips": 1.0}, part="shorts")
    bottom = waist[-1]
    loops = {1: bottom[0:9] + [crotch], -1: bottom[8:16] + [bottom[0], crotch]}
    for s in (1, -1):
        L = "L" if s > 0 else "R"
        hip, knee = fig.J[f"thigh.{L}"], fig.J[f"shin.{L}"]
        specs = []
        thigh_len = float(np.linalg.norm(knee - hip))
        for dist, grow in ((0.15, 0.026), (0.25, 0.032), (0.33, 0.039), (0.4, 0.046), (0.432, 0.05), (0.442, 0.05)):
            o, i_, f, b = fig.leg_at(dist, thigh_len)
            pts = fig.leg_ring(s, hip, knee, dist, o + grow, i_ + grow * 0.45, f + grow, b + grow * 1.1)
            w = figure.blend_w(f"thigh.{L}", f"shin.{L}", (dist - 0.36) / 0.16) if dist > 0.36 else {f"thigh.{L}": 1.0}
            specs.append((pts, w))
        ring_vs = [cage.ring(p, w, part="shorts") for p, w in specs]
        ring_vs[0] = cage.bridge_aligned(loops[s], ring_vs[0], R["thighs"])
        for k in range(1, len(ring_vs)):
            ring_vs[k] = figure._align(ring_vs[k - 1], ring_vs[k])
            cage.bridge(ring_vs[k - 1], ring_vs[k], R["thighs"])
        inner = figure._index_toward(ring_vs[1], (-s, 0, 0))
        cage.seam([loops[s][inner]] + [r[inner] for r in ring_vs])
    back = [w[8] for w in waist]
    cage.seam(back + [crotch])
    obj = cage.finish()
    uvs.unwrap(obj)
    blend.select_only(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.pack_islands(rotate=True, scale=True, margin=0.01)
    bpy.ops.object.mode_set(mode="OBJECT")
    lift_uvs(obj)
    rings.subdivide(obj, 1)
    thicken(obj, 0.006)
    for n in ("part", "region"):
        a = obj.data.attributes.get(n)
        if a:
            obj.data.attributes.remove(a)
    return obj


def paint_shorts(maps):
    inside = maps["inside"]
    pos = maps["pos"]
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    ax = np.abs(x)
    L = blur(maps["light"], inside, 2)
    ref = np.percentile(L[inside], 85) if inside.any() else 1.0
    s = np.clip(L / ref, 0, 1.4)
    ao = np.clip(blur(maps["ao"], inside, 2), 0, 1)
    s = s * (0.45 + 0.55 * ao)
    # Folds: soft creases running from the crotch out round the thighs, and a few at the hem.
    legs = z < 0.87
    side_x = ax - 0.1
    fold1 = np.sin((z * 38 + side_x * 60) * 2 * np.pi * 0.5) * legs
    fold2 = (fbm(pos * np.array([3, 3, 1]), 28, octaves=3, seed=4) - 0.5) * 2
    s = s * (1 + 0.1 * fold1 * smoothstep(0.82, 0.7, z) * smoothstep(0.5, 0.6, z) + 0.16 * fold2)
    # Creases: from the crotch out over the thighs, behind the knees, gathered under the waistband.
    for sgn in (1, -1):
        cx = sgn * (0.03 + (0.86 - z) * 0.9)
        crease = smoothstep(0.004, 0.0, np.abs(x - cx)) * smoothstep(0.88, 0.84, z) * smoothstep(0.66, 0.72, z)
        s = s * (1 - 0.22 * crease * (y < 0))
    gather = (np.sin(x * 260) * 0.5 + 0.5) * smoothstep(1.05, 1.035, z) * smoothstep(1.0, 1.02, z)
    s = s * (1 - 0.12 * gather)
    # Side pockets: the opening's seam down from the waistband, and a flap's edge.
    for sgn in (1, -1):
        px = sgn * (0.13 - (1.04 - z) * 0.5)
        pocket = smoothstep(0.003, 0.001, np.abs(x - px)) * smoothstep(1.045, 1.03, z) * smoothstep(0.9, 0.93, z)
        s = s * (1 - 0.3 * pocket * (y < 0.0))
    knee_back = smoothstep(0.03, 0.0, np.abs(z - 0.56)) * (y > 0.02) * legs
    s = s * (1 - 0.15 * knee_back * (0.5 + 0.5 * np.sin(x * 400)))
    detail = np.repeat((0.5 * s)[..., None], 3, axis=2)
    mask = np.zeros_like(detail)
    mask[..., 0] = 1

    def put(area, which, shade=None):
        nonlocal detail, mask
        area = np.clip(area, 0, 1)[..., None]
        col = np.zeros(3)
        col[which] = 1
        mask = mask * (1 - area) + col * area
        if shade is not None:
            detail = detail * (1 - area) + shade[..., None] * area

    # Waistband and hem bands in the second colour; a side panel down each outer leg.
    put(smoothstep(1.05, 1.056, z), 1)
    put(smoothstep(HEM + 0.028, HEM + 0.023, z) * legs, 1)
    leg_x = np.where(x > 0, x - 0.1, x + 0.1)
    outer = np.abs(leg_x - np.sign(x) * 0.085) < 0.03
    th = np.degrees(np.arctan2(np.abs(leg_x), -(y - 0.0)))
    panel = smoothstep(60, 70, th) * smoothstep(118, 108, th) * legs * smoothstep(HEM + 0.03, HEM + 0.035, z)
    put(panel, 1)
    # Accent piping either side of the panel, and a wave across the left leg.
    pipe = (np.exp(-(((th - 64) / 2.2) ** 2)) + np.exp(-(((th - 114) / 2.2) ** 2))) * legs
    put(pipe * smoothstep(HEM + 0.03, HEM + 0.035, z), 2, 0.55 * np.clip(s, 0.4, 1.3))
    # A breaking wave up the left leg: a bold crest in the accent with a second-colour shadow under it.
    around = np.degrees(np.arctan2(leg_x, -y)) % 360
    crest = 0.6 + 0.07 * np.sin(np.radians(around) * 1.0 + 0.6) + 0.035 * np.sin(np.radians(around) * 3.0)
    curl = np.exp(-(((around - 40) % 360 - 0) / 26) ** 2)
    crest = crest + 0.05 * curl
    body_w = smoothstep(crest + 0.004, crest - 0.004, z) * smoothstep(HEM + 0.03, HEM + 0.04, z)
    lip = smoothstep(0.011, 0.007, np.abs(z - crest))
    foam = body_w * (fbm(pos, 70, octaves=2, seed=12) > 0.55) * smoothstep(crest - 0.05, crest - 0.01, z)
    left = (x > 0) * legs * (1 - panel)
    put(body_w * left * 0.85, 1)
    put(np.clip(lip + foam, 0, 1) * left, 2, 0.55 * np.clip(s, 0.4, 1.3))
    # The drawstring: two cords at the front.
    for sx in (-0.014, 0.014):
        cord = smoothstep(0.003, 0.0018, np.abs(x - sx - (1.06 - z) * 0.08 * np.sign(sx))) * (z < 1.055) * (z > 0.99)
        cord = cord * (y < -0.05)
        put(cord, 2, 0.6 * np.clip(s, 0.5, 1.2))
        eyelet = np.exp(-(((x - sx) / 0.003) ** 2) - ((z - 1.06) / 0.003) ** 2) * (y < -0.05)
        put(eyelet, 2, 0.3 * np.ones_like(s))
    fly = smoothstep(0.003, 0.0015, np.abs(x - 0.012)) * (z < 1.045) * (z > 0.92) * (y < -0.05)
    detail = detail * (1 - 0.3 * fly[..., None])
    v = np.linspace(1, 0, inside.shape[0])[:, None] * np.ones((1, inside.shape[1]))
    detail = np.where((v < 0.078)[..., None], detail * 0.5, detail)
    return np.clip(detail, 0, 1), np.clip(mask, 0, 1)


# ---------------------------------------------------------------- swimsuit

SUIT_BOTTOM, SUIT_TOP = 0.82, 1.52
SUIT_ROWS, SUIT_COLS = 52, 48
# Its edges by angle from the front (degrees, either side): the leg line (a moderate cut, up to the top of the
# thighs: the body shows its hips' sides below that), the top (a scoop at the front, deep under the arms, low
# across the back).
LEG_LINE = ([0, 14, 30, 45, 60, 75, 90, 105, 120, 135, 150, 166, 180],
            [0.835, 0.848, 0.886, 0.926, 0.944, 0.951, 0.952, 0.951, 0.944, 0.924, 0.884, 0.852, 0.84])
SUIT_LINE = ([0, 15, 30, 42, 48, 54, 62, 72, 90, 110, 130, 150, 180],
             [1.378, 1.381, 1.392, 1.404, 1.398, 1.372, 1.346, 1.33, 1.318, 1.296, 1.272, 1.262, 1.262])
# The straps: up from the front over the top of each shoulder, down the back to meet between the shoulder blades.
STRAP_LINE = ([40, 50, 65, 80, 95, 110, 125, 140, 155, 170, 180],
              [1.39, 1.42, 1.46, 1.494, 1.505, 1.494, 1.468, 1.43, 1.392, 1.356, 1.342])
STRAP_HALF = 0.013


def suit_field(th, z, straps=True):
    """How far inside the swimsuit a point (angle from the front in degrees, height) is, roughly in metres:
    positive inside, 0 on its edges."""
    a = np.abs((np.asarray(th) + 180) % 360 - 180)
    z = np.asarray(z, dtype=np.float64)
    panel = np.minimum(z - np.interp(a, *LEG_LINE), np.interp(a, *SUIT_LINE) - z)
    # Down the middle of the back from where the straps meet: a band widening into the back panel.
    back = (180 - a) * 0.0018
    half = 0.024 + 0.05 * smoothstep(1.34, 1.25, z)
    spine = np.where(z < 1.35, half - back, np.minimum(half - back, 1.35 - z))
    body = _soft_max(panel, spine, 0.005)
    if not straps:
        return body
    strap = STRAP_HALF - np.abs(z - np.interp(a, *STRAP_LINE))
    strap = np.where((a > 36) & (a <= 180), strap, -1.0)
    return np.maximum(body, strap)


def _soft_max(a, b, k):
    m = np.maximum(a, b)
    return m + k * np.log(np.exp((a - m) / k) + np.exp((b - m) / k)) - k * math.log(2) * np.exp(-np.abs(a - b) / k)


def swimsuit(body):
    """A sporty one-piece: a moderate leg, a scoop neck, a racer back; tight to the body."""
    fig = body.fig
    rows, cols = SUIT_ROWS, SUIT_COLS
    T = np.array([[360.0 * j / cols for j in range(cols)] for _ in range(rows + 1)])
    Z = np.array([[SUIT_BOTTOM + (SUIT_TOP - SUIT_BOTTOM) * i / rows] * cols for i in range(rows + 1)])
    keep = np.zeros((rows, cols), dtype=bool)
    for i in range(rows):
        for j in range(cols):
            keep[i, j] = suit_field(360.0 * (j + 0.5) / cols, (Z[i, 0] + Z[i + 1, 0]) / 2, False) > 0
    # Edge vertices go onto the edge (a few steps down the field's slope), so the edges run smooth.
    used = np.zeros((rows + 1, cols), dtype=bool)
    for i in range(rows):
        for j in range(cols):
            if keep[i, j]:
                used[i, j] = used[i + 1, j] = used[i, (j + 1) % cols] = used[i + 1, (j + 1) % cols] = True
    deg = 0.0025
    for i in range(rows + 1):
        for j in range(cols):
            if not used[i, j]:
                continue
            near = [keep[ii, jj % cols] for ii in (i - 1, i) for jj in (j - 1, j) if 0 <= ii < rows]
            if all(near) and len(near) == 4:
                continue
            th, z = T[i, j], Z[i, j]
            for _ in range(6):
                f = float(suit_field(th, z, False))
                g_t = (float(suit_field(th + 0.5, z, False)) - float(suit_field(th - 0.5, z, False))) / (1.0 * deg)
                g_z = (float(suit_field(th, z + 0.001, False)) - float(suit_field(th, z - 0.001, False))) / 0.002
                gg = g_t * g_t + g_z * g_z
                if gg < 1e-9:
                    break
                th, z = th - f * g_t / gg / deg, z - f * g_z / gg
            T[i, j], Z[i, j] = th, z
    P = np.zeros((rows + 1, cols, 3))
    UV = np.zeros((rows + 1, cols, 2))
    for i in range(rows + 1):
        for j in range(cols):
            th, z = T[i, j], Z[i, j]
            P[i, j] = _suit_point(body, th, z, 0.0028)
            UV[i, j] = ((th / 360) % 1.0, 0.25 + 0.75 * (z - SUIT_BOTTOM) / (SUIT_TOP - SUIT_BOTTOM))
    # Stretched fabric: smooth (the edges stay where they are), bridging hollows (between the legs at the back),
    # never closer to the skin than it was fitted.
    inner = np.zeros((rows + 1, cols), dtype=bool)
    for i in range(1, rows):
        for j in range(cols):
            inner[i, j] = all(keep[ii, jj % cols] for ii in (i - 1, i) for jj in (j - 1, j))
    for _ in range(10):
        Q = P.copy()
        for i in range(rows + 1):
            for j in range(cols):
                if not used[i, j]:
                    continue
                if inner[i, j]:
                    avg = (P[i - 1, j] + P[i + 1, j] + P[i, j - 1] + P[i, (j + 1) % cols]) / 4
                    Q[i, j] = P[i, j] * 0.4 + avg * 0.6
                Q[i, j] = body.clear(Q[i, j], 0.0028)
        P = Q
    obj = grid_mesh("swimsuit", P, UV, keep)
    # The straps: ribbons along their own lines from the front panel over the shoulders to the back.
    for s in (1, -1):
        obj = _join(obj, _strap(body, s))
    # One sheet, no inside: it is skin tight (an inner layer this close would shadow the outside in stripes).
    # Every face looks away from the body.
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    inward = [f for f in bm.faces
              if f.normal.dot(f.calc_center_median() - Vector((0, _axis_y(fig, f.calc_center_median().z),
                                                                 f.calc_center_median().z))) < 0]
    bmesh.ops.reverse_faces(bm, faces=inward)
    bm.to_mesh(me)
    bm.free()
    return obj


def _suit_point(body, th, z, off):
    """The point `off` out from the body at (angle from the front in degrees, height), for the swimsuit."""
    fig = body.fig
    yc = _axis_y(fig, z)
    a = math.radians(th)
    d = np.array([math.sin(a), -math.cos(a), 0.0])
    # Over the top of the shoulders the rays look a little up, onto the slope; between the legs they come down
    # from inside the hips.
    origin = np.array([0, yc, min(z, 1.5)])
    if z > 1.44:
        d = d + np.array([0, 0, (z - 1.44) * 6])
    hit = body.out(origin, d)
    # Near the middle line low down (between the legs), rays from inside the hips aimed down, blended in.
    t = th % 360
    mid = min(t, 360 - t, abs(t - 180))
    w = smoothstep(42.0, 20.0, mid) * smoothstep(0.94, 0.88, z)
    if w > 0:
        low = body.out(np.array([0, yc, 0.95]), d * 0.09 + np.array([0, 0, z - 0.95]))
        hit = hit * (1 - w) + low * w
    return body.clear(hit, off)


def _strap(body, s, n=28):
    """One strap (side `s`): a ribbon along STRAP_LINE, a little proud of the panels it runs into."""
    a0, a1 = STRAP_LINE[0][0] - 2, STRAP_LINE[0][-1]
    P = np.zeros((3, n + 1, 3))
    UV = np.zeros((3, n + 1, 2))
    for k in range(n + 1):
        a = a0 + (a1 - a0) * k / n
        zc = float(np.interp(a, *STRAP_LINE))
        # Across the line (in angle-metres): its slope makes the strap's width hold where the line climbs.
        dz = (float(np.interp(a + 1, *STRAP_LINE)) - float(np.interp(a - 1, *STRAP_LINE))) / (2 * 0.0025)
        across = np.array([-dz, 1.0]) / math.hypot(dz, 1.0)
        for e, sgn in enumerate((-1, 0, 1)):
            aa = a + sgn * across[0] * STRAP_HALF / 0.0025
            zz = zc + sgn * across[1] * STRAP_HALF
            P[e, k] = _suit_point(body, s * aa, zz, 0.0036)
            UV[e, k] = (0.05 + 0.9 * k / n, (0.02 + 0.045 * e) + (0.11 if s < 0 else 0.0))
    keep = np.ones((2, n + 1), dtype=bool)
    keep[:, n] = False
    return grid_mesh("strap", P, UV, keep)


def _join(a, b):
    blend.deselect()
    a.select_set(True)
    b.select_set(True)
    bpy.context.view_layer.objects.active = a
    bpy.ops.object.join()
    return a


def paint_swimsuit(maps):
    """The main colour, a curving side panel in the second colour, piping round every edge and the brand's mark
    on the left hip in the accent."""
    inside = maps["inside"]
    pos = maps["pos"]
    fig = maps["fig"]
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    yc = np.interp(z, [r[0] for r in fig.TORSO], [r[4] for r in fig.TORSO])
    th = np.degrees(np.arctan2(x, -(y - yc))) % 360
    a = np.abs((th + 180) % 360 - 180)
    L = blur(maps["light"], inside, 2)
    ref = np.percentile(L[inside], 85) if inside.any() else 1.0
    s = np.clip(L / ref, 0, 1.45)
    ao = np.clip(blur(maps["ao"], inside, 2), 0, 1)
    s = s * (0.45 + 0.55 * ao)
    # Lycra: a sheen where it stretches over curves, a few fine creases at the hips.
    curv = np.clip((maps["curv"] - 0.5) * 6, -1, 1)
    s = s * (1 + 0.12 * np.maximum(curv, 0))
    detail = np.repeat((0.5 * s)[..., None], 3, axis=2)
    mask = np.zeros_like(detail)
    mask[..., 0] = 1

    def put(area, which, shade=None):
        nonlocal detail, mask
        area = np.clip(area, 0, 1)[..., None]
        col = np.zeros(3)
        col[which] = 1
        mask = mask * (1 - area) + col * area
        if shade is not None:
            detail = detail * (1 - area) + shade[..., None] * area

    # A side panel from under each arm sweeping forward to the hip.
    sweep = 92 - (1.32 - z) * 95
    panel = smoothstep(9, 6, np.abs(a - sweep)) * smoothstep(0.96, 1.0, z) * smoothstep(1.33, 1.29, z)
    put(panel, 1)
    # Piping along every edge.
    edge = suit_field(th, z)
    put(smoothstep(0.0045, 0.003, edge), 2, 0.55 * np.clip(s, 0.4, 1.3))
    # The brand's mark on the left hip.
    mark = (x > 0) * smoothstep(0.012, 0.009, np.abs(a - 52)) * smoothstep(0.009, 0.006, np.abs(z - 1.02))
    put(mark, 2)
    return np.clip(detail, 0, 1), np.clip(mask, 0, 1)


# ---------------------------------------------------------------- water shoes


# The left shoe's rings, from the collar round the shin down to the toe, on the male-sized foot (see
# figure.foot_point): centre, axis, outer, inner, top, bottom.
SHOE_PATH = [
    ((0.104, 0.006, 0.29), (0, 0, -1), 0.054, 0.052, 0.056, 0.054),
    ((0.104, 0.01, 0.235), (0, 0, -1), 0.058, 0.056, 0.06, 0.058),
    ((0.104, 0.016, 0.17), (0, 0, -1), 0.066, 0.062, 0.068, 0.064),
    ((0.104, 0.022, 0.105), (0, 0, -1), 0.074, 0.068, 0.078, 0.074),
    ((0.104, 0.024, 0.066), (0, -0.25, -0.97), 0.077, 0.07, 0.092, 0.074),
    ((0.107, -0.026, 0.054), (0, -0.9, -0.43), 0.077, 0.07, 0.076, 0.064),
    ((0.109, -0.078, 0.048), (0, -1, -0.12), 0.079, 0.072, 0.062, 0.054),
    ((0.111, -0.13, 0.044), (0, -1, -0.04), 0.081, 0.072, 0.05, 0.048),
    ((0.111, -0.176, 0.04), (0, -1, 0.02), 0.075, 0.066, 0.044, 0.044),
    ((0.11, -0.208, 0.038), (0, -1, 0.1), 0.06, 0.053, 0.035, 0.04),
]


def shoes(fig):
    """Chunky high-top water shoes: a thick sole, a toe bumper, two straps."""
    import uv as uvs

    cage = rings.Cage("shoes")
    R = figure.R
    size = fig.FOOT_SIZE
    for s in (1, -1):
        L = "L" if s > 0 else "R"
        n = 12
        path = [(fig.foot_point(s, c), *rest) for c, *rest in SHOE_PATH]
        prev = None
        made = []
        for k, (c, axis, o, i_, top, bottom) in enumerate(path):
            axis = np.asarray(axis, dtype=np.float64)
            vertical = abs(axis[2]) > 0.9
            e1, e2, _ = rings.frame_of(axis, (0, -1, 0) if vertical else (0, 0, 1))
            if np.dot(e1, (s, 0, 0)) < 0:
                e1 = -e1
            o, i_, top, bottom = o * 1.1 * size, i_ * 1.1 * size, top * 1.08 * size, bottom * 1.08 * size
            pts = rings.place(c, e1, e2, rings.outline(n, o, i_, top, bottom, power=2.1 if vertical else 2.4,
                                                       start=math.pi / n))
            # A flat sole: nothing below the ground, a little out at the sole's edge.
            pts = [np.array([p[0], p[1], max(p[2], 0.0)]) for p in pts]
            if k == 4:
                # The heel: out behind.
                pts = [p + np.array([0, 0.02, 0]) * size * max(0.0, (p[1] - c[1]) / (0.06 * size)) for p in pts]
            w = {f"foot.{L}": 1.0} if k > 2 else figure.blend_w(f"shin.{L}", f"foot.{L}", 0.1 + 0.3 * k)
            if k >= 8:
                w = figure.blend_w(f"foot.{L}", f"toes.{L}", 0.7)
            ring = cage.ring(pts, w, part=f"shoe.{L}")
            if prev is not None:
                ring = figure._align(prev, ring)
                cage.bridge(prev, ring, R["feet"])
            made.append(ring)
            prev = ring
        tip = fig.foot_point(s, np.array(SHOE_PATH[-1][0]) + np.array([0, -0.016, -0.004]))
        cage.cap(prev, tip, figure.blend_w(f"foot.{L}", f"toes.{L}", 0.8), R["feet"], part=f"shoe.{L}")
        sole = figure._index_toward(made[6], (0, 0, -1))
        cage.seam([r[sole] for r in made[3:]])
        back = figure._index_toward(made[0], (0, 1, 0))
        cage.seam([made[0][back], made[1][back], made[2][back], made[3][back]])
        cage.seam(made[3], closed=True)
    obj = cage.finish()
    uvs.unwrap(obj)
    blend.select_only(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.pack_islands(rotate=True, scale=True, margin=0.01)
    bpy.ops.object.mode_set(mode="OBJECT")
    rings.subdivide(obj, 1)
    # The bottom flat again after smoothing.
    co = np.empty(len(obj.data.vertices) * 3)
    obj.data.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    co[:, 2] = np.where(co[:, 2] < 0.004, 0.0, co[:, 2])
    obj.data.vertices.foreach_set("co", co.ravel())
    obj.data.update()
    for nm in ("part", "region"):
        a = obj.data.attributes.get(nm)
        if a:
            obj.data.attributes.remove(a)
    return obj


def paint_shoes(maps):
    inside = maps["inside"]
    pos = maps["fig"].foot_design(maps["pos"])
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    L = blur(maps["light"], inside, 2)
    ref = np.percentile(L[inside], 85) if inside.any() else 1.0
    s = np.clip(L / ref, 0, 1.4)
    ao = np.clip(blur(maps["ao"], inside, 2), 0, 1)
    s = s * (0.45 + 0.55 * ao)
    mesh = (np.sin(x * 1500 + y * 900) * np.sin(z * 1500 - y * 700) > 0.3)
    s = s * (1 - 0.06 * mesh)
    detail = np.repeat((0.5 * s)[..., None], 3, axis=2)
    mask = np.zeros_like(detail)
    mask[..., 0] = 1

    def put(area, which, shade=None):
        nonlocal detail, mask
        area = np.clip(area, 0, 1)[..., None]
        col = np.zeros(3)
        col[which] = 1
        mask = mask * (1 - area) + col * area
        if shade is not None:
            detail = detail * (1 - area) + shade[..., None] * area

    # The sole and toe bumper: rubber in the second colour, ribbed at its edge.
    sole = smoothstep(0.044, 0.038, z)
    toe = smoothstep(-0.16, -0.18, y) * smoothstep(0.06, 0.05, z)
    rib = (np.sin(y * 900) > 0.6) * smoothstep(0.014, 0.008, np.abs(z - 0.018))
    put(np.clip(sole + toe, 0, 1), 1, (0.5 * s) * (1 - 0.2 * rib))
    # Two straps over the instep with their buckles, and the collar's binding.
    straps = [smoothstep(0.013, 0.01, np.abs(z - 0.15)), smoothstep(0.013, 0.01, np.abs(z - 0.235))]
    for yy, zz in ((-0.05, 0.095), (-0.1, 0.075)):
        straps.append(smoothstep(0.012, 0.009, np.abs((y - yy) * 0.9 + (z - zz) * 0.45)) * (z > 0.04))
    for strap in straps:
        put(strap, 1, 0.42 * np.clip(s, 0.4, 1.3))
        buckle = strap * smoothstep(0.012, 0.008, np.abs(np.abs(x) - 0.145))
        put(buckle, 2, 0.6 * np.ones_like(s))
    collar = smoothstep(0.272, 0.28, z)
    put(collar, 1)
    # Laces up the front, over a tongue.
    lx = np.abs(x) - 0.104 - np.sign(x) * 0.0
    front = (y < -0.01) & (z > 0.06) & (z < 0.27)
    tongue = smoothstep(0.022, 0.016, np.abs(np.abs(x) - np.abs(x) + (np.abs(x) - 0.106))) * front
    put(tongue * 0.9, 1, 0.38 * np.clip(s, 0.4, 1.3))
    zl = (z - 0.06) / 0.022
    cross = np.minimum(np.abs((zl % 1) - 0.5 + (np.abs(x) - 0.106) / 0.03), np.abs((zl % 1) - 0.5 - (np.abs(x) - 0.106) / 0.03))
    laces = smoothstep(0.12, 0.06, cross) * smoothstep(0.018, 0.012, np.abs(np.abs(x) - 0.106)) * front
    put(laces, 2, 0.6 * np.clip(s, 0.5, 1.3))
    pull = smoothstep(0.007, 0.005, np.abs(x - np.sign(x) * 0.104)) * smoothstep(0.23, 0.24, z) * (y > 0.04)
    put(pull, 2)
    return np.clip(detail, 0, 1), np.clip(mask, 0, 1)
