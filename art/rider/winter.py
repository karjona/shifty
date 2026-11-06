"""The winter kit, box-modelled around a body like the summer kit (see kit.py): cages of rings
round the body's own measures, subdivided, baked on themselves and painted into colourway masks.
"""

import math

import bpy
import numpy as np

import blend
import figure
import rings
import uv as uvs
from paint import fbm, smoothstep
from skin import blur, masses

# ---------------------------------------------------------------- puffer jacket

# Rings up the torso: (height, how far out from the body, kind). Puffs and seams alternate into the
# baffles; the arm holes sit in the rings the body has them in (ARMPIT, CHEST_HIGH, SHOULDER).
PUFFER_TORSO = [
    (0.915, 0.02, "hem"),
    (0.95, 0.021, "seam"),
    (0.995, 0.036, "puff"),
    (1.04, 0.021, "seam"),
    (1.085, 0.037, "puff"),
    (1.13, 0.021, "seam"),
    (1.175, 0.037, "puff"),
    (1.22, 0.021, "seam"),
    (1.265, 0.036, "puff"),
    (1.33, 0.024, "seam"),
    (1.392, 0.034, "puff"),
    (1.452, 0.026, "seam"),
    (1.512, 0.022, "neck"),
]
ARM_RINGS = (9, 10, 11)
# Down each sleeve: (distance from the shoulder joint along the arm, how far out from the arm, kind).
PUFFER_SLEEVE = [
    (0.02, 0.022, "seam"),
    (0.07, 0.034, "puff"),
    (0.12, 0.02, "seam"),
    (0.17, 0.033, "puff"),
    (0.22, 0.019, "seam"),
    (0.27, 0.031, "puff"),
    (0.32, 0.018, "seam"),
    (0.37, 0.029, "puff"),
    (0.42, 0.017, "seam"),
    (0.465, 0.026, "puff"),
    (0.505, 0.013, "cuff"),
    (0.545, 0.012, "cuff"),
]
# Where the seams between baffles run (torso heights, sleeve distances), for the painter.
TORSO_SEAMS = [z for z, _, k in PUFFER_TORSO if k == "seam"]
SLEEVE_SEAMS = [d for d, _, k in PUFFER_SLEEVE if k == "seam"]
YOKE = 1.405
HEM_BAND = 0.95
CUFF = 0.49


def _torso_shape(fig, z):
    """The jacket's base outline at height z: the body's, hanging straight down from the chest."""
    W, F, B, yc, n = fig.torso_params(z)
    cz = fig.CHEST_Z
    if z < cz:
        cw, cf, cb, _, _ = fig.torso_params(cz)
        k = (cz - z) / 0.33
        W = max(W, cw - 0.004 - 0.012 * k)
        F = max(F, cf - 0.004 - 0.012 * k)
        B = max(B, cb - 0.002 - 0.006 * k)
        n = max(n, 2.45)
    return W, F, B, yc, n


def _torso_ring(fig, z, grow, kind):
    W, F, B, yc, n = _torso_shape(fig, z)
    pts = []
    for i in range(figure.N_TORSO):
        t = 2 * math.pi * i / figure.N_TORSO
        s, c = math.sin(t), math.cos(t)
        ex = 2.0 / n
        x = (W + grow) * math.copysign(abs(s) ** ex, s)
        d = (F if c >= 0 else B) + grow
        y = yc - d * math.copysign(abs(c) ** ex, c)
        zz = z
        side = abs(s)
        if kind == "seam" and abs(z - 1.452) < 1e-6:
            # Over the shoulders: up onto them, a dip at the collarbones' middle.
            zz += (fig.SHOULDER_RISE + grow * 0.8) * side**3 - 0.006 * max(0.0, c) ** 4
        if kind == "neck":
            zz += 0.014 * max(0.0, -c) - 0.004 * max(0.0, c) ** 3 + 0.012 * side**2
        pts.append(np.array([x, y, zz]))
    return pts


def _torso_weights(z, k, i):
    if z < 1.0:
        w = {"hips": 1.0}
    elif z < 1.16:
        w = figure.blend_w("hips", "spine", (z - 1.0) / 0.16)
    elif z < 1.32:
        w = figure.blend_w("spine", "chest", (z - 1.16) / 0.16)
    else:
        w = {"chest": 1.0}
    for s, L in ((1, "L"), (-1, "R")):
        if k in ARM_RINGS and i in figure.HOLE[s]:
            share = {9: 0.25, 10: 0.35, 11: 0.4}[k] * (1.0 if i == figure.HOLE[s][1] else 0.7)
            w = {b: v * (1 - share) for b, v in w.items()}
            w[f"upperarm.{L}"] = share
    return w


def _sleeve_radius(fig, d):
    """The arm's rough radius `d` along it from the shoulder (the sleeve doesn't follow the muscles)."""
    r = float(np.interp(d, [0.0, 0.12, 0.285, 0.42, 0.55], [0.078, 0.066, 0.05, 0.043, 0.033]))
    return r * fig.ARM_GIRTH


def _sleeve_weights(fig, s, d):
    L = "L" if s > 0 else "R"
    elbow, wrist = fig.UPPER_ARM, fig.UPPER_ARM + fig.FOREARM
    if d < 0.05:
        return {f"upperarm.{L}": 0.75, "chest": 0.25}
    if abs(d - elbow) < 0.07:
        return figure.blend_w(f"upperarm.{L}", f"forearm.{L}", (d - (elbow - 0.07)) / 0.14)
    if d < elbow:
        return {f"upperarm.{L}": 1.0}
    if d > wrist - 0.05:
        return figure.blend_w(f"forearm.{L}", f"hand.{L}", (d - (wrist - 0.05)) / 0.1)
    return {f"forearm.{L}": 1.0}


def _ring_round(cage, centre, axis, e2_hint, rx, ry, weights, n, part):
    e1, e2, _ = rings.frame_of(axis, e2_hint)
    pts = rings.place(centre, e1, e2, rings.outline(n, rx, rx, ry, ry, power=2.0))
    return cage.ring(pts, weights, part=part)


def puffer(fig):
    """A quilted down jacket: baffles round the body and down the sleeves, a stand-up collar, closed."""
    cage = rings.Cage("puffer")
    region = 0
    tr = []
    for k, (z, grow, kind) in enumerate(PUFFER_TORSO):
        pts = _torso_ring(fig, z, grow, kind)
        tr.append([cage.vert(p, _torso_weights(z, k, i), part="torso") for i, p in enumerate(pts)])
    a_, b_, c_ = ARM_RINGS
    for k in range(len(tr) - 1):
        skip = {3, 4, 11, 12} if k in (a_, b_) else set()
        for i in range(figure.N_TORSO):
            if i in skip:
                continue
            j = (i + 1) % figure.N_TORSO
            cage.face([tr[k][i], tr[k][j], tr[k + 1][j], tr[k + 1][i]], region)
    for s in (1, -1):
        cage.bm.verts.remove(tr[b_][figure.HOLE[s][1]])
    holes = {}
    for s in (1, -1):
        a, b, c = figure.HOLE[s]
        holes[s] = [tr[a_][a], tr[a_][b], tr[a_][c], tr[b_][c], tr[c_][c], tr[c_][b], tr[c_][a], tr[b_][a]]
    # The hem folds inside.
    hem_in = cage.ring(_torso_ring(fig, 0.935, 0.008, "hem"), [_torso_weights(0.93, 0, i) for i in range(16)],
                       part="torso")
    cage.bridge(tr[0], hem_in, region)
    # The collar: in from the top of the shoulders, then up round the neck, lower in front, folded inside.
    collar = []
    (_, ny, _), nw, nf, nb, _ = fig.NECK
    for z, gx, gy, front in ((1.537, 0.044, 0.04, 0.0), (1.568, 0.039, 0.036, 0.028), (1.598, 0.036, 0.034, 0.05)):
        pts = rings.place((0, ny, z), np.array([1.0, 0, 0]), np.array([0, -1.0, 0]),
                          rings.outline(figure.N_TORSO, nw + gx, nw + gx, nf + gy, nb + gy, power=2.0,
                                        start=math.pi / 2))
        pts = [p - np.array([0, 0, front * max(0.0, -(p[1] - ny) / (nf + gy)) ** 2]) for p in pts]
        ring = cage.ring(pts, figure.blend_w("chest", "neck", 0.35 if z < 1.55 else 0.5), part="collar")
        collar.append(figure._align(collar[-1] if collar else tr[-1], ring))
    cage.bridge(tr[-1], collar[0], region)
    cage.bridge(collar[0], collar[1], region)
    cage.bridge(collar[1], collar[2], region)
    top = collar[-1]
    lip = figure._align(top, cage.ring([np.array(v.co[:]) * np.array([0.9, 1.0, 1.0]) + np.array([0, 0.0025, -0.012])
                                      for v in top], figure.blend_w("chest", "neck", 0.5), part="collar"))
    cage.bridge(top, lip, region)
    # The sleeves.
    sleeves = {}
    for s in (1, -1):
        L = "L" if s > 0 else "R"
        sh = fig.J[f"upperarm.{L}"]
        d = figure.arm_dir(s)
        up = figure.arm_up(s)
        made = []
        for dist, grow, kind in PUFFER_SLEEVE:
            r = _sleeve_radius(fig, dist) + grow
            # A little flatter front to back than across, the way a sleeve hangs.
            ring = _ring_round(cage, sh + d * dist, d, (0, -1, 0), r * 1.04, r * 0.97, _sleeve_weights(fig, s, dist), 8,
                               f"sleeve.{L}")
            if made:
                ring = figure._align(made[-1], ring)
                cage.bridge(made[-1], ring, region)
            else:
                ring = cage.bridge_aligned(holes[s], ring, region)
            made.append(ring)
        end = PUFFER_SLEEVE[-1][0] - 0.016
        inner = _ring_round(cage, sh + d * end, d, (0, -1, 0), _sleeve_radius(fig, end) + 0.003,
                            _sleeve_radius(fig, end) + 0.002, _sleeve_weights(fig, s, end), 8, f"sleeve.{L}")
        inner = figure._align(made[-1], inner)
        cage.bridge(made[-1], inner, region)
        sleeves[s] = made
        # Seams: round the arm hole, under the arm to the cuff.
        cage.seam(holes[s], closed=True)
        under = figure._index_toward(made[1], -up)
        cage.seam([holes[s][under]] + [r_[under] for r_ in made] + [inner[under]])
    # Seams: down the back to the top of the collar, round the collar's base.
    back = 8
    cage.seam([hem_in[back]] + [r_[back] for r_ in tr] + [ring[figure._index_toward(ring, (0, 1, 0))]
                                                          for ring in collar + [lip]])
    cage.seam(collar[0], closed=True)
    obj = cage.finish()
    _face_out(fig, obj)
    uvs.unwrap(obj)
    blend.select_only(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.pack_islands(rotate=True, scale=True, margin=0.008)
    bpy.ops.object.mode_set(mode="OBJECT")
    rings.subdivide(obj, 1)
    for nm in ("part", "region"):
        a = obj.data.attributes.get(nm)
        if a:
            obj.data.attributes.remove(a)
    return obj


def _outward(fig, c):
    """Away from the body's middle at point c: from the arm's axis on a sleeve, from the torso's otherwise."""
    s = 1 if c[0] > 0 else -1
    sh = fig.J["upperarm.L" if s > 0 else "upperarm.R"]
    d = figure.arm_dir(s)
    t = float(np.dot(c - sh, d))
    if abs(c[0]) > 0.24 and t > 0.05:
        return c - sh - t * d
    return c - np.array([0.0, 0.02, c[2]])


def _face_out(fig, obj):
    """Turns the mesh's faces to look away from the body (an open mesh can come out of the cage inside out)."""
    me = obj.data
    inward = sum(np.dot(_outward(fig, np.array(p.center[:])), p.normal[:]) < 0 for p in me.polygons)
    if inward > len(me.polygons) / 2:
        blend.flip(obj)


def _arm_coords(fig, pos):
    """For each texel: whether it is on a sleeve, and how far down the arm it is from the shoulder joint."""
    sleeve = np.zeros(pos.shape[:2], dtype=bool)
    dist = np.zeros(pos.shape[:2])
    for s, L in ((1, "L"), (-1, "R")):
        sh = fig.J[f"upperarm.{L}"]
        d = figure.arm_dir(s)
        rel = pos - sh
        t = rel @ d
        radial = np.linalg.norm(rel - t[..., None] * d, axis=-1)
        on = (np.sign(pos[..., 0]) == s) & (t > 0.0) & (radial < 0.16)
        # The shoulder: the sleeve starts where the arm hole is (sideways of the shoulder joint).
        on &= t > 0.012 + 0.03 * np.clip((pos[..., 2] - 1.4) / 0.08, 0, 1)
        sleeve |= on
        dist = np.where(on, t, dist)
    return sleeve, dist


def paint_puffer(maps):
    inside = maps["inside"]
    pos = maps["pos"]
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    ax = np.abs(x)
    L = blur(maps["light"], inside, 2)
    ref = np.percentile(L[inside], 85) if inside.any() else 1.0
    s = np.clip(L / ref, 0, 1.45)
    ao = np.clip(blur(maps["ao"], inside, 2), 0, 1)
    s = s * (0.4 + 0.6 * ao)
    s = masses(s, centre=0.85, sharp=3.2, amount=0.45)
    fig = maps["fig"]
    sleeve, dist = _arm_coords(fig, pos)
    collar = (z > 1.525) & ~sleeve
    # Stitched seams between the baffles: a dark line, the fabric drawn in toward it.
    seam_t = np.min([np.abs(z - zs) for zs in TORSO_SEAMS], axis=0)
    seam_s = np.min([np.abs(dist - ds) for ds in SLEEVE_SEAMS], axis=0)
    seam = np.where(sleeve, seam_s, seam_t)
    quilted = np.where(sleeve, dist < CUFF, (z > HEM_BAND + 0.004) & (z < 1.5))
    stitch = smoothstep(0.0024, 0.0009, seam) * quilted
    pinch = smoothstep(0.012, 0.0, seam) * quilted
    s = s * (1 - 0.18 * pinch) * (1 - 0.5 * stitch)
    # Nylon creases: soft wrinkles across the puffs, and where the sleeves bend.
    crumple = (fbm(pos * np.array([1.0, 1.0, 2.2]), 34, octaves=3, seed=9) - 0.5) * 2
    s = s * (1 + 0.07 * crumple * quilted)
    elbow = smoothstep(0.05, 0.0, np.abs(dist - fig.UPPER_ARM)) * sleeve
    s = s * (1 - 0.12 * elbow * (0.5 + 0.5 * np.sin(dist * 900)))
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

    # Colour blocks in the second colour: the yoke over the shoulders (and the tops of the sleeves), the
    # collar, the cuffs and the hem band.
    # (Lower at the front and back than over the shoulders.)
    yoke = smoothstep(YOKE - 0.002, YOKE + 0.002, z + 0.012 * np.cos(2 * np.arctan2(x, -y)))
    yoke = np.where(sleeve, smoothstep(0.075, 0.07, dist) * smoothstep(1.4, 1.43, z), yoke * ~sleeve)
    put(yoke, 1)
    put(collar, 1)
    put(np.where(sleeve, smoothstep(CUFF - 0.002, CUFF + 0.002, dist), 0), 1)
    put(np.where(sleeve, 0, smoothstep(HEM_BAND + 0.003, HEM_BAND - 0.001, z)), 1)
    # Accent: piping along the yoke's edge, the zip up the front to the collar's top, its pull, and a patch on
    # the chest with the brand's mark.
    yoke_edge = np.abs(yoke - 0.5) < 0.42
    put(yoke_edge * (yoke > 0.05) * (yoke < 0.95) * ~collar, 2, 0.5 * np.clip(s, 0.5, 1.2))
    front = y < -0.03
    zip_ = smoothstep(0.0042, 0.0028, ax) * front * (z > 0.918)
    put(zip_, 2, 0.55 * np.clip(s, 0.6, 1.2))
    teeth = zip_ * (np.sin(z * 2600) > 0) * smoothstep(0.0024, 0.001, ax)
    detail = detail * (1 - 0.3 * teeth[..., None])
    pull = np.exp(-((ax / 0.006) ** 2) - ((z - 1.555) / 0.011) ** 2) * front
    put(pull, 2, 0.35 * np.ones_like(s))
    px, pz = 0.085, 1.33
    patch = smoothstep(0.022, 0.019, np.abs(x - px)) * smoothstep(0.012, 0.009, np.abs(z - pz)) * front * ~sleeve
    put(patch, 2)
    mark = patch * (np.abs(np.abs(x - px) - np.abs(z - pz) * 1.6) < 0.0035) * smoothstep(0.017, 0.014, np.abs(x - px))
    put(mark, 1)
    # A sleeve pocket on the left upper arm, a zip across it.
    pocket = sleeve & (x > 0) & (np.abs(dist - 0.16) < 0.032) & (np.abs(y) < 0.05)
    s_p = np.where(pocket & (np.abs(dist - 0.13) < 0.0025), 0.6, 1.0)
    detail = detail * s_p[..., None]
    return np.clip(detail, 0, 1), np.clip(mask, 0, 1)


# ---------------------------------------------------------------- snowboard pants

# Down each leg: (distance along the thigh, or along the shin past the knee, how far out from the leg).
PANTS_THIGH = [(0.15, 0.034), (0.25, 0.04), (0.33, 0.046), (0.4, 0.05)]
PANTS_SHIN = [(0.04, 0.054), (0.11, 0.056), (0.19, 0.056), (0.26, 0.058), (0.32, 0.062), (0.37, 0.066)]
PANTS_HEM = 0.37
KNEE = (0.465, 0.6)


def pants(fig):
    """Loose snowboard pants: a waistband at the hips, straight legs falling over the boots."""
    cage = rings.Cage("pants")
    R = figure.R
    waist = []
    for z, grow in ((1.085, 0.016), (1.04, 0.019), (0.98, 0.022), (0.93, 0.026), (0.885, 0.03)):
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
                               part="pants"))
    for a, b in zip(waist, waist[1:]):
        cage.bridge(a, b, R["hips"])
    crotch = cage.vert((0, 0.008, 0.79), {"hips": 1.0}, part="pants")
    bottom = waist[-1]
    loops = {1: bottom[0:9] + [crotch], -1: bottom[8:16] + [bottom[0], crotch]}
    for s in (1, -1):
        L = "L" if s > 0 else "R"
        hip, knee, ankle = fig.J[f"thigh.{L}"], fig.J[f"shin.{L}"], fig.J[f"foot.{L}"]
        thigh_len = float(np.linalg.norm(knee - hip))
        specs = []
        for dist, grow in PANTS_THIGH:
            o, i_, f, b = fig.leg_at(dist, thigh_len)
            specs.append(fig.leg_ring(s, hip, knee, dist, o + grow, i_ + grow * 0.5, f + grow, b + grow))
        for dist, grow in PANTS_SHIN:
            # The shin's own shape, smoothed out under loose cloth.
            o, i_, f, b = [float(np.interp(dist, [r[0] for r in fig.SHIN], [r[k] for r in fig.SHIN]))
                           for k in (1, 2, 3, 4)]
            r = max((o + i_ + f + b) / 4, 0.048)
            specs.append(fig.leg_ring(s, knee, ankle, dist, r + grow, r + grow * 0.8, r + grow, r + grow))
        ring_vs = [cage.ring(p, {f"thigh.{L}": 1.0}, part="pants") for p in specs]
        ring_vs[0] = cage.bridge_aligned(loops[s], ring_vs[0], R["thighs"])
        for k in range(1, len(ring_vs)):
            ring_vs[k] = figure._align(ring_vs[k - 1], ring_vs[k])
            cage.bridge(ring_vs[k - 1], ring_vs[k], R["thighs"])
        # The hem turns in.
        o, i_, f, b = (fig.SHIN[-2][k] for k in (1, 2, 3, 4))
        r = max((o + i_ + f + b) / 4, 0.048)
        lip = figure._align(ring_vs[-1], cage.ring(fig.leg_ring(s, knee, ankle, PANTS_HEM - 0.018, r + 0.05, r + 0.04,
                                                                r + 0.05, r + 0.05), {f"shin.{L}": 1.0}, part="pants"))
        cage.bridge(ring_vs[-1], lip, R["thighs"])
        inner = figure._index_toward(ring_vs[1], (-s, 0, 0))
        cage.seam([loops[s][inner]] + [r_[inner] for r_ in ring_vs] + [lip[inner]])
    cage.seam([w[8] for w in waist] + [crotch])
    obj = cage.finish()
    if sum(np.dot(np.array(p.center[:]) - np.array([np.sign(p.center[0]) * 0.1 if p.center[2] < 0.86 else 0, 0.0,
                                                       p.center[2]]), p.normal[:]) < 0
           for p in obj.data.polygons) > len(obj.data.polygons) / 2:
        blend.flip(obj)
    uvs.unwrap(obj)
    blend.select_only(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.pack_islands(rotate=True, scale=True, margin=0.008)
    bpy.ops.object.mode_set(mode="OBJECT")
    rings.subdivide(obj, 1)
    for nm in ("part", "region"):
        a = obj.data.attributes.get(nm)
        if a:
            obj.data.attributes.remove(a)
    return obj


def paint_pants(maps):
    inside = maps["inside"]
    pos = maps["pos"]
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    ax = np.abs(x)
    L = blur(maps["light"], inside, 2)
    ref = np.percentile(L[inside], 85) if inside.any() else 1.0
    s = np.clip(L / ref, 0, 1.4)
    ao = np.clip(blur(maps["ao"], inside, 2), 0, 1)
    s = s * (0.45 + 0.55 * ao)
    legs = z < 0.86
    leg_x = np.where(x > 0, x - 0.1, x + 0.1)
    # Folds: the cloth stacks over the boots, creases behind the knees and from the crotch.
    stack = smoothstep(0.3, 0.16, z) * legs
    s = s * (1 + 0.14 * stack * np.sin(z * 160 + np.sin(np.arctan2(leg_x, -y) * 3) * 2))
    fold = (fbm(pos * np.array([3.0, 3.0, 1.0]), 22, octaves=3, seed=14) - 0.5) * 2
    s = s * (1 + 0.12 * fold * legs)
    behind = smoothstep(0.04, 0.0, np.abs(z - 0.52)) * (y > 0.02) * legs
    s = s * (1 - 0.16 * behind * (0.5 + 0.5 * np.sin(leg_x * 300)))
    for sgn in (1, -1):
        cx = sgn * (0.03 + (0.86 - z) * 0.9)
        crease = smoothstep(0.004, 0.0, np.abs(x - cx)) * smoothstep(0.88, 0.84, z) * smoothstep(0.66, 0.72, z)
        s = s * (1 - 0.2 * crease * (y < 0))
    # A side seam down each leg.
    side = np.degrees(np.arctan2(np.abs(leg_x), -y))
    seam = smoothstep(2.0, 0.6, np.abs(side - 90)) * legs
    s = s * (1 - 0.3 * seam)
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

    # Reinforced knees, the waistband and the hem's scuff guard in the second colour.
    k0, k1 = KNEE
    knee = smoothstep(k0, k0 + 0.004, z) * smoothstep(k1, k1 - 0.004, z) * smoothstep(-0.005, -0.015, y)
    knee = knee * smoothstep(52, 46, side) * legs
    put(knee, 1)
    put(smoothstep(1.035, 1.04, z), 1)
    put(smoothstep(0.155, 0.15, z) * legs, 1)
    # Accent: a vent zip down the outside of each thigh, a logo patch on the left thigh.
    vent = smoothstep(2.4, 1.2, np.abs(side - 84)) * smoothstep(0.86, 0.85, z) * smoothstep(0.7, 0.71, z)
    put(vent, 2, 0.55 * np.clip(s, 0.5, 1.2))
    logo = (x > 0) * smoothstep(0.016, 0.013, np.abs(leg_x - 0.02)) * smoothstep(0.011, 0.008, np.abs(z - 0.79))
    put(logo * (y < 0), 2)
    return np.clip(detail, 0, 1), np.clip(mask, 0, 1)


# ---------------------------------------------------------------- snowboard boots

# From the padded collar round the shin down to the toe: (centre, axis, outer, inner, front or top, back or
# bottom), x as the foot's own (the side's sign applied).
BOOT_PATH = [
    ((0.0, 0.008, 0.315), (0, 0, -1), 0.061, 0.057, 0.064, 0.062),
    ((0.0, 0.01, 0.275), (0, 0, -1), 0.063, 0.059, 0.067, 0.064),
    ((0.0, 0.014, 0.215), (0, 0, -1), 0.067, 0.063, 0.073, 0.068),
    ((0.0, 0.02, 0.155), (0, 0, -1), 0.073, 0.067, 0.082, 0.075),
    ((0.0, 0.026, 0.105), (0, 0, -1), 0.079, 0.073, 0.09, 0.081),
    ((0.0, 0.028, 0.068), (0, -0.25, -0.97), 0.083, 0.076, 0.1, 0.082),
    ((0.003, -0.028, 0.062), (0, -0.9, -0.43), 0.084, 0.077, 0.087, 0.07),
    ((0.005, -0.084, 0.054), (0, -1, -0.12), 0.086, 0.078, 0.071, 0.061),
    ((0.007, -0.14, 0.05), (0, -1, -0.04), 0.087, 0.078, 0.06, 0.053),
    ((0.007, -0.188, 0.047), (0, -1, 0.02), 0.083, 0.074, 0.053, 0.048),
    ((0.006, -0.218, 0.048), (0, -1, 0.1), 0.074, 0.066, 0.052, 0.049),
]
BOOT_X = 0.104
BOOT_SOLE = 0.042
BOOT_COLLAR = 0.29


def boots(fig):
    """Chunky snowboard boots: a padded collar high up the shin, a thick sole, a rounded toe box."""
    cage = rings.Cage("boots")
    R = figure.R
    size = fig.FOOT_SIZE
    for s in (1, -1):
        L = "L" if s > 0 else "R"
        n = 12
        prev = None
        made = []
        for k, (c, axis, o, i_, top, bottom) in enumerate(BOOT_PATH):
            c = fig.foot_point(s, (BOOT_X + c[0], c[1], c[2]))
            o, i_, top, bottom = o * size, i_ * size, top * size, bottom * size
            axis = np.asarray(axis, dtype=np.float64)
            vertical = abs(axis[2]) > 0.9
            e1, e2, _ = rings.frame_of(axis, (0, -1, 0) if vertical else (0, 0, 1))
            if np.dot(e1, (s, 0, 0)) < 0:
                e1 = -e1
            pts = rings.place(c, e1, e2, rings.outline(n, o, i_, top, bottom, power=2.2 if vertical else 2.7,
                                                       start=math.pi / n))
            # A flat sole: nothing below the ground, and the outsole standing out a little round the foot.
            pts = [np.array([p[0], p[1], max(p[2], 0.0)]) for p in pts]
            if k >= 4:
                pts = [p + np.append((p[:2] - c[:2]) / (np.linalg.norm(p[:2] - c[:2]) + 1e-9), 0) * (0.006 * size)
                       * smoothstep(0.05 * size, 0.02 * size, p[2]) for p in pts]
            if k == 5:
                # The heel: out behind.
                pts = [p + np.array([0, 0.022, 0]) * size * max(0.0, (p[1] - c[1]) / (0.06 * size)) for p in pts]
            # The shaft goes with the shin, the foot with the foot.
            if k <= 2:
                w = figure.blend_w(f"shin.{L}", f"foot.{L}", 0.15 + 0.12 * k)
            elif k == 3:
                w = figure.blend_w(f"shin.{L}", f"foot.{L}", 0.65)
            elif k >= 9:
                w = figure.blend_w(f"foot.{L}", f"toes.{L}", 0.6)
            else:
                w = {f"foot.{L}": 1.0}
            ring = cage.ring(pts, w, part=f"boot.{L}")
            if prev is not None:
                ring = figure._align(prev, ring)
                cage.bridge(prev, ring, R["feet"])
            made.append(ring)
            prev = ring
        end = BOOT_PATH[-1][0]
        tip = fig.foot_point(s, (BOOT_X + end[0], end[1] - 0.013, end[2] - 0.002))
        cage.cap(prev, tip, figure.blend_w(f"foot.{L}", f"toes.{L}", 0.75), R["feet"], part=f"boot.{L}")
        # The collar turns in, padded.
        top = made[0]
        axis = fig.foot_point(s, (BOOT_X, 0.008, 0.0))
        lip = cage.ring([(np.array(v.co[:]) - axis) * np.array([0.82, 0.82, 1.0]) + axis + (0, 0, -0.012 * size)
                         for v in top],
                        figure.blend_w(f"shin.{L}", f"foot.{L}", 0.1), part=f"boot.{L}")
        lip = figure._align(top, lip)
        cage.bridge(lip, top, R["feet"])
        sole = figure._index_toward(made[7], (0, 0, -1))
        cage.seam([r[sole] for r in made[4:]])
        back = figure._index_toward(made[0], (0, 1, 0))
        cage.seam([lip[back]] + [made[k][back] for k in range(5)])
        cage.seam(made[4], closed=True)
    obj = cage.finish()
    if sum(np.dot(np.array(p.center[:]) - fig.foot_point(np.sign(p.center[0]), (BOOT_X, -0.07, 0.12)), p.normal[:])
           < 0 for p in obj.data.polygons) > len(obj.data.polygons) / 2:
        blend.flip(obj)
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


def paint_boots(maps):
    inside = maps["inside"]
    pos = maps["fig"].foot_design(maps["pos"])
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    fx = np.abs(x) - BOOT_X
    L = blur(maps["light"], inside, 2)
    ref = np.percentile(L[inside], 85) if inside.any() else 1.0
    s = np.clip(L / ref, 0, 1.4)
    ao = np.clip(blur(maps["ao"], inside, 2), 0, 1)
    s = s * (0.45 + 0.55 * ao)
    # Creases across the instep where the boot flexes, and the leather's grain.
    flex = smoothstep(0.03, 0.0, np.abs(z - 0.085 + 0.25 * (y + 0.05))) * (y < -0.01) * (y > -0.12)
    s = s * (1 - 0.1 * flex * (0.5 + 0.5 * np.sin(y * 420)))
    s = s * (1 + 0.05 * (fbm(pos * np.array([2.0, 2.0, 2.0]), 60, octaves=2, seed=31) - 0.5))
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

    # The outsole: rubber in the second colour, a groove round it and a tread at its edge; the toe cap and the
    # heel counter over it.
    sole = smoothstep(BOOT_SOLE + 0.002, BOOT_SOLE - 0.002, z)
    groove = smoothstep(0.0025, 0.001, np.abs(z - (BOOT_SOLE - 0.012)))
    tread = (np.sin((y - 0.4 * fx) * 700) > 0.3) * smoothstep(0.02, 0.012, z)
    put(sole, 1, (0.5 * s) * (1 - 0.35 * groove) * (1 - 0.25 * tread))
    toe = smoothstep(-0.2, -0.208, y) * smoothstep(0.078, 0.072, z)
    heel = smoothstep(0.034, 0.042, y) * smoothstep(0.1, 0.092, z)
    put(np.clip(toe + heel, 0, 1) * (1 - sole), 1)
    # Stitching round the caps.
    edge = (np.abs(toe - 0.5) < 0.42) | (np.abs(heel - 0.5) < 0.42)
    stitch = smoothstep(0.002, 0.001, np.abs(z - 0.078)) * (y < -0.2)
    detail = detail * (1 - 0.25 * (stitch * (np.sin(y * 2400) > 0))[..., None])
    detail = detail * (1 - 0.2 * (edge * (1 - sole) * 0.6)[..., None])
    # The padded collar in the second colour, with a pull loop at the back.
    collar = smoothstep(BOOT_COLLAR - 0.002, BOOT_COLLAR + 0.002, z)
    put(collar, 1, 0.5 * np.clip(s, 0.5, 1.2) * (1 - 0.18 * (np.sin(z * 900) > 0.6)))
    loop = smoothstep(0.009, 0.006, np.abs(fx)) * smoothstep(0.24, 0.25, z) * (y > 0.05)
    put(loop, 2)
    # The tongue up the front of the shaft and down the instep, and laces crossing over it in the accent, with
    # the eyelets either side.
    front = (y < -0.02) & (y > -0.125) & (z > 0.07 + 0.5 * np.maximum(0.0, -0.07 - y)) & (z < BOOT_COLLAR)
    reach = 0.024 + 0.004 * smoothstep(0.2, 0.1, z)
    tongue = smoothstep(reach + 0.002, reach - 0.002, np.abs(fx)) * front
    put(tongue, 1, 0.42 * np.clip(s, 0.4, 1.3))
    zl = (z - 0.07) / 0.026
    across = fx / 0.04
    cross = np.minimum(np.abs((zl % 1) - 0.5 + across), np.abs((zl % 1) - 0.5 - across))
    laces = smoothstep(0.11, 0.05, cross) * smoothstep(reach - 0.002, reach - 0.006, np.abs(fx)) * front
    put(laces, 2, 0.62 * np.clip(s, 0.5, 1.3))
    eyelets = (np.abs(np.abs(fx) - reach - 0.003) < 0.0025) & (np.abs((zl % 1) - 0.5) < 0.12) & front
    put(eyelets.astype(float), 2, 0.35 * np.ones_like(s))
    # A stripe down the outer side from the collar to the heel, and the brand's mark on it.
    out = fx > 0.03
    stripe = smoothstep(0.006, 0.003, np.abs(z - 0.2 + 0.9 * (y - 0.02))) * out * (z > 0.07) * (z < BOOT_COLLAR)
    put(stripe, 2)
    mark = out * smoothstep(0.012, 0.009, np.abs(y + 0.03)) * smoothstep(0.009, 0.006, np.abs(z - 0.105))
    put(mark, 2)
    return np.clip(detail, 0, 1), np.clip(mask, 0, 1)


# ---------------------------------------------------------------- gloves

# Padding over the hand (m): its back, the palm, its two edges; over each finger's top and bottom, its sides.
GLOVE_PAD = (0.0055, 0.006, 0.006, 0.006)
FINGER_PAD = (0.0045, 0.0013)
# A short cuff up the wrist, under the sleeve: (distance from the wrist joint, top, bottom, front, back).
GLOVE_CUFF = [(-0.036, 0.031, 0.03, 0.038, 0.036), (-0.012, 0.032, 0.031, 0.04, 0.038)]


def _glove_fingers(fig, cage, s):
    """The body's fingers (Figure._fingers) padded: thicker over the knuckles than across, a little longer."""
    L = "L" if s > 0 else "R"
    wr = fig.J[f"hand.{L}"]
    d = figure.arm_dir(s)
    up = figure.arm_up(s)
    front = np.array([0, -1.0, 0])
    tall, wide = FINGER_PAD
    for across, length, r in fig.FINGERS:
        length += 0.007
        base = wr + d * (fig.PALM - 0.004) + front * across + up * 0.002
        spread = front * across * 0.18
        made = []
        for i, t in enumerate((0.0, 0.33, 0.66, 1.0)):
            axis = d + spread - up * (0.18 * t + 0.1 * t * t)
            axis /= np.linalg.norm(axis)
            c = base + (d + spread * 0.5 - up * 0.08 * t) * length * t
            e1, e2, _ = rings.frame_of(axis, front)
            rr = r * (1 - 0.14 * t)
            w = (figure.blend_w(f"hand.{L}", f"fingers.{L}", 0.5 + 0.5 * t) if i
                 else figure.blend_w(f"hand.{L}", f"fingers.{L}", 0.35))
            ring = cage.ring(rings.place(c, e1, e2, rings.outline(6, rr + tall, rr * 0.95 + tall, rr * 1.05 + wide,
                                                                  rr + wide, power=2.2)), w, part=f"glove.{L}")
            if made:
                ring = figure._align(made[-1], ring)
                cage.bridge(made[-1], ring, figure.R["hands"])
            made.append(ring)
        cage.cap(made[0], base - d * 0.008, figure.blend_w(f"hand.{L}", f"fingers.{L}", 0.3), figure.R["hands"],
                 part=f"glove.{L}")
        end = np.mean([np.array(v.co[:]) for v in made[-1]], axis=0)
        cage.cap(made[-1], end + d * (r + tall) * 0.85, {f"fingers.{L}": 1.0}, figure.R["hands"], part=f"glove.{L}")
        cage.seam([r_[0] for r_ in made])


def _glove_thumb(fig, cage, s):
    L = "L" if s > 0 else "R"
    wr = fig.J[f"hand.{L}"]
    d = figure.arm_dir(s)
    up = figure.arm_up(s)
    front = np.array([0, -1.0, 0])
    k = fig.HAND_SIZE
    base = wr + d * (0.022 * k) + front * (0.03 * k) - up * (0.008 * k)
    axis = d * 0.55 + front * 0.55 - up * 0.45
    axis /= np.linalg.norm(axis)
    e1, e2, _ = rings.frame_of(axis, up)
    made = []
    for t, r1, r2 in ((0.0, 0.021, 0.019), (0.027, 0.0185, 0.0165), (0.049, 0.0155, 0.0145), (0.066, 0.013, 0.0125)):
        ring = cage.ring(rings.place(base + axis * (t * k), e1, e2, rings.outline(6, r1 * k, r1 * k, r2 * k, r2 * k)),
                         {f"hand.{L}": 1.0}, part=f"glove.{L}")
        if made:
            ring = figure._align(made[-1], ring)
            cage.bridge(made[-1], ring, figure.R["hands"])
        made.append(ring)
    back = cage.cap(made[0], base - axis * (0.012 * k), {f"hand.{L}": 1.0}, figure.R["hands"], part=f"glove.{L}")
    cage.cap(made[-1], base + axis * (0.078 * k), {f"hand.{L}": 1.0}, figure.R["hands"], part=f"glove.{L}")
    cage.seam([back] + [r[0] for r in made])


def gloves(fig):
    """Padded snowboard gloves: the hand's own shape a size up, the fingers thick over the knuckles, a short cuff
    under the sleeve."""
    cage = rings.Cage("gloves")
    top, bot, fr, bk = GLOVE_PAD
    for s in (1, -1):
        L = "L" if s > 0 else "R"
        wr = fig.J[f"hand.{L}"]
        h = fig.HAND_SIZE
        specs = [(dist, a * h, b * h, f * h, k * h) for dist, a, b, f, k in GLOVE_CUFF]
        specs += [(dist, a + top, b + bot, f + fr, k + bk) for dist, a, b, f, k in fig.HAND]
        made = []
        for dist, a, b, f, k in specs:
            if dist < 0:
                w = figure.blend_w(f"forearm.{L}", f"hand.{L}", 0.3 + 0.25 * (1 + dist / 0.036))
            elif dist <= 0.0:
                w = figure.blend_w(f"forearm.{L}", f"hand.{L}", 0.55)
            elif dist < fig.PALM - 0.01:
                w = {f"hand.{L}": 1.0}
            else:
                w = figure.blend_w(f"hand.{L}", f"fingers.{L}", (dist - (fig.PALM - 0.01)) / 0.03)
            ring = cage.ring(fig.arm_ring(s, wr, dist, a, b, f, k), w, part=f"glove.{L}")
            if made:
                ring = figure._align(made[-1], ring)
                cage.bridge(made[-1], ring, figure.R["hands"])
            made.append(ring)
        # The cuff's open end turns in.
        d0 = GLOVE_CUFF[0][0] + 0.008
        lip = figure._align(made[0], cage.ring(fig.arm_ring(s, wr, d0, 0.026 * h, 0.025 * h, 0.033 * h, 0.031 * h),
                                             figure.blend_w(f"forearm.{L}", f"hand.{L}", 0.3), part=f"glove.{L}"))
        cage.bridge(lip, made[0], figure.R["hands"])
        tip = np.mean([np.array(v.co[:]) for v in made[-1]], axis=0) + figure.arm_dir(s) * 0.007
        cage.cap(made[-1], tip, figure.blend_w(f"hand.{L}", f"fingers.{L}", 0.6), figure.R["hands"], part=f"glove.{L}")
        _glove_fingers(fig, cage, s)
        _glove_thumb(fig, cage, s)
        cage.seam(made[len(GLOVE_CUFF)], closed=True)
        back = figure._index_toward(made[len(GLOVE_CUFF) + 1], (0, 1, 0))
        cage.seam([lip[back]] + [r_[back] for r_ in made])
    obj = cage.finish()
    _glove_out(fig, obj)
    uvs.unwrap(obj)
    blend.select_only(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.pack_islands(rotate=True, scale=True, margin=0.01)
    bpy.ops.object.mode_set(mode="OBJECT")
    rings.subdivide(obj, 1)
    for nm in ("part", "region"):
        a = obj.data.attributes.get(nm)
        if a:
            obj.data.attributes.remove(a)
    return obj


def _hand_coords(fig, pos):
    """For each texel: the hand's side (+1 left, -1 right), how far along the arm from the wrist joint, and
    its direction up (the back of the hand) and front (toward the thumb) at the wrist."""
    side = np.where(pos[..., 0] >= 0, 1, -1)
    along = np.zeros(pos.shape[:2])
    for s, L in ((1, "L"), (-1, "R")):
        rel = pos - fig.J[f"hand.{L}"]
        along = np.where(side == s, rel @ figure.arm_dir(s), along)
    return side, along


def _glove_out(fig, obj):
    """Faces away from the hand's bones (a cage of caps and tubes can come out inside out)."""
    me = obj.data
    inward = 0
    for p in me.polygons:
        c = np.array(p.center[:])
        s = 1 if c[0] > 0 else -1
        L = "L" if s > 0 else "R"
        wr = fig.J[f"hand.{L}"]
        d = figure.arm_dir(s)
        t = float(np.dot(c - wr, d))
        inward += np.dot(c - (wr + d * np.clip(t, -0.04, 0.16)), p.normal[:]) < 0
    if inward > len(me.polygons) / 2:
        blend.flip(obj)


def paint_gloves(maps):
    inside = maps["inside"]
    pos = maps["pos"]
    nrm = maps["nrm"]
    L = blur(maps["light"], inside, 2)
    ref = np.percentile(L[inside], 85) if inside.any() else 1.0
    s = np.clip(L / ref, 0, 1.4)
    ao = np.clip(blur(maps["ao"], inside, 2), 0, 1)
    s = s * (0.42 + 0.58 * ao)
    fig = maps["fig"]
    side, along = _hand_coords(fig, pos)
    up = np.where(side[..., None] > 0, figure.arm_up(1), figure.arm_up(-1))
    upness = np.sum(nrm * up, axis=-1)
    knuckles = fig.PALM - 0.006
    # Padding: quilted rows across the back of the fingers and a padded panel over the knuckles.
    back = smoothstep(-0.1, 0.15, upness)
    rows = smoothstep(0.0022, 0.0008, np.abs(((along - knuckles) / 0.022) % 1 - 0.5) * 0.022) * (along > knuckles)
    s = s * (1 - 0.3 * rows * back)
    panel = smoothstep(0.002, 0.0, np.abs(along - knuckles)) + smoothstep(0.002, 0.0, np.abs(along - 0.03))
    s = s * (1 - 0.28 * np.clip(panel, 0, 1) * back)
    s = s * (1 + 0.05 * (fbm(pos, 120, octaves=2, seed=41) - 0.5))
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

    # The palm and the insides of the fingers: grippy leather in the second colour, with seams; the fingertips
    # wrapped in it too.
    palm = smoothstep(-0.12, -0.3, upness) * (along > 0.004)
    grip = (np.sin(pos[..., 0] * 1300) * np.sin(pos[..., 1] * 1300 + pos[..., 2] * 900) > 0.55) * palm
    put(palm, 1, 0.5 * np.clip(s, 0.4, 1.3) * (1 - 0.12 * grip))
    tips = smoothstep(knuckles + 0.064, knuckles + 0.07, along)
    put(tips, 1)
    # The cuff in the second colour, with a strap across the wrist (its pull tab in the accent).
    put(smoothstep(0.004, 0.0, along), 1, 0.5 * np.clip(s, 0.4, 1.2) * (1 - 0.15 * (np.sin(along * 1800) > 0.5)))
    strap = smoothstep(0.004, 0.002, np.abs(along - 0.013)) * back
    put(strap, 1, 0.42 * np.clip(s, 0.4, 1.2))
    front = np.array([0, -1.0, 0])
    tab = strap * smoothstep(0.0, 0.25, np.sum(nrm * front, axis=-1)) * smoothstep(0.003, 0.002, np.abs(along - 0.013))
    put(tab, 2)
    # The brand's mark on the back of the hand.
    rel = np.where(side[..., None] > 0, pos - fig.J["hand.L"], pos - fig.J["hand.R"])
    across = np.sum(rel * front, axis=-1)
    mark = smoothstep(0.008, 0.006, np.abs(along - 0.052)) * smoothstep(0.011, 0.009, np.abs(across - 0.004))
    put(mark * smoothstep(0.3, 0.6, upness), 2)
    return np.clip(detail, 0, 1), np.clip(mask, 0, 1)
