"""Painting the MakeHuman face: the head's own light and shadow, and the colour of MakeHuman's skin and brows, baked onto our head and laid out as tint factors (see skin.skin_factors).

The shapes all come from the detailed head (the sockets, the nose, the lips are really there); the painting
groups its light into masses, crisps the features and keeps every colour relative to the skin, so one texture
works for every skin tone, eye colour and hair colour.
"""

import numpy as np

import hair
import mhhead
from paint import fbm, smoothstep
from skin import blur, masses, skin_factors


# The iris's radius (m): a little under half the eye's opening, so the lids cut its top.
IRIS = 0.0052

# Each body's own paint on the face: how wide the upper lash line is (m), how much redder the lips are (a tint
# factor change, RGB) and how far they reach (where MakeHuman's skin is this much redder), and a warmth over
# the cheekbones.
LOOKS = {
    "male": {"lash": 0.0016, "lips": (-0.04, -0.12, -0.1), "lips_from": 0.05, "blush": 0.0},
    "female": {"lash": 0.0023, "lips": (0.04, -0.3, -0.2), "lips_from": 0.03, "blush": 1.0},
}


def _ids(maps):
    return {n: i for i, n in maps["parts"].items()}


def shading(maps, ref):
    """The light on the head: the portrait light on the face, the overhead light round the rest."""
    msk = maps["inside"]
    pos, nrm = maps["pos"], maps["nrm"]
    y = pos[..., 1]
    face = smoothstep(-0.02, -0.06, y) * smoothstep(-0.1, -0.45, nrm[..., 1])
    over = blur(maps["light"], msk, 2) / max(ref, 1e-6)
    lit = over
    if "light_front" in maps:
        F = blur(maps["light_front"], msk, 2)
        sel = msk & (face > 0.5)
        fref = np.percentile(F[sel], 70) if sel.any() else 1.0
        lit = over * (1 - face) + np.clip(F / max(fref, 1e-6), 0, 1.35) * face
    ao = np.clip(blur(maps["ao"], msk, 1), 0, 1)
    s = np.clip(lit, 0, 1.3) * (0.62 + 0.38 * ao)
    c = np.clip((maps["curv"] - 0.5) * 6, -1, 1)
    s = s * (1 + 0.2 * np.minimum(c, 0) + 0.06 * np.maximum(c, 0))
    soft = masses(np.maximum(s, 0.28), centre=0.86, sharp=4.4, amount=0.62)
    # On the face the light is painted as shapes: a shadow tone and a light tone with a narrow edge between,
    # and the brightest planes (the brow, the nose's ridge, the cheekbone) a step lighter still.
    tone = 0.6 + 0.4 * smoothstep(0.52, 0.74, s) + 0.1 * smoothstep(1.0, 1.15, s)
    return soft * (1 - 0.6 * face) + tone * 0.6 * face, face


def relative_skin(maps, tex, area):
    """MakeHuman's skin colour over its own median: lips redder, the scalp and the stubble darker."""
    sk = tex["skin"]
    ref = np.median(sk[area], axis=0) if area.any() else np.ones(3)
    rel = sk / np.maximum(ref, 1e-3)
    rel = np.stack([blur(rel[..., i], maps["inside"], 3) for i in range(3)], -1)
    return np.clip(rel, 0.55, 1.35)


def lid_lines(pos, eye, skin_area, reach=0.004):
    """For skin texels round the eyes: the distance to the eye above its middle (the upper lid's edge), below
    it (the lower lid's), and how far toward the outer corner (0-1)."""
    from mathutils import Vector
    from mathutils.kdtree import KDTree

    far = np.full(pos.shape[:2], 1.0)
    upper, lower, outer = far.copy(), far.copy(), np.zeros(pos.shape[:2])
    ep = pos[eye]
    if not len(ep):
        return upper, lower, outer
    for side in (1, -1):
        e = ep[np.sign(ep[:, 0]) == side]
        if not len(e):
            continue
        c = e.mean(axis=0)
        half = np.ptp(e[:, 0]) / 2
        step = max(1, len(e) // 30000)
        e = e[::step]
        kd = KDTree(len(e))
        for i, p in enumerate(e):
            kd.insert(Vector(p), i)
        kd.balance()
        near = skin_area & (np.abs(pos[..., 0] - c[0]) < half + reach) & (np.abs(pos[..., 2] - c[2]) < 0.02)
        near &= pos[..., 1] < c[1] + 0.01
        ii, jj = np.nonzero(near)
        for i, j in zip(ii, jj):
            p = pos[i, j]
            d = kd.find(Vector(p))[2]
            if p[2] >= c[2] - 0.0008:
                upper[i, j] = d
            else:
                lower[i, j] = d
            outer[i, j] = np.clip((abs(p[0]) - abs(c[0])) / max(half, 1e-4) * 0.5 + 0.5, 0, 1)
    return upper, lower, outer


def distance_to(pos, target, area, box):
    """For texels of `area` inside `box` ((x0, x1), (z0, z1)): the distance to the nearest `target` texel
    (1 elsewhere)."""
    from mathutils import Vector
    from mathutils.kdtree import KDTree

    out = np.full(pos.shape[:2], 1.0)
    t = pos[target]
    if not len(t):
        return out
    t = t[:: max(1, len(t) // 30000)]
    kd = KDTree(len(t))
    for i, p in enumerate(t):
        kd.insert(Vector(p), i)
    kd.balance()
    (x0, x1), (z0, z1) = box
    sel = area & (pos[..., 0] > x0) & (pos[..., 0] < x1) & (pos[..., 2] > z0) & (pos[..., 2] < z1)
    for i, j in zip(*np.nonzero(sel)):
        out[i, j] = kd.find(Vector(pos[i, j]))[2]
    return out


def paint_face(maps, ref, tex, flat=False):
    """The face's (detail, mask), or with `flat` its colour without the light. The brows and the beard are
    overlays of their own (see `brows`, `beard`)."""
    msk = maps["inside"]
    ids = _ids(maps)
    part = maps["part"]
    eye = (part == ids.get("eye", -1)) & msk
    mouth = (maps.get("low_part", part) == ids.get("mouth", -1)) & msk
    s, face = shading(maps, ref)
    if flat:
        s = np.ones_like(s)
    pos = maps["pos"]
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    skin_area = msk & ~eye & ~mouth

    rel = relative_skin(maps, tex, skin_area & (face > 0.5))
    # The sea's cool light from below is kept off the face (it reads as bruising under the nose and lips).
    nrm = maps["nrm"].copy()
    nrm[..., 2] *= 1 - 0.8 * face
    detail = skin_factors(s, warmth=1.0, maps=dict(maps, nrm=nrm), mottle=40.0)
    detail = detail * (1 + 0.7 * (rel - 1))
    # The lips: where MakeHuman's skin turns red, a touch more of it, and darker at the line between them.
    red = rel[..., 0] - 0.5 * (rel[..., 1] + rel[..., 2])
    look = LOOKS[maps["fig"].name]
    lips = smoothstep(look["lips_from"], look["lips_from"] + 0.11, red) * face
    detail = detail * (1 + lips[..., None] * np.array(look["lips"]))
    if look["blush"]:
        eye_z = mhhead.landmark("eye_l", maps["fig"].name)[2]
        for sgn in (1, -1):
            cheek = np.exp(-(((x - sgn * 0.043) / 0.014) ** 2) - ((z - (eye_z - 0.03)) / 0.011) ** 2)
            detail = detail * (1 + (cheek * face * look["blush"])[..., None] * np.array([0.03, -0.05, -0.04]))
    mask = np.zeros_like(detail)
    mask[..., 0] = 1

    def paint(area, colour, tint=None):
        nonlocal detail, mask
        a = np.clip(area, 0, 1)[..., None]
        detail = detail * (1 - a) + np.broadcast_to(colour, detail.shape) * a
        m = np.zeros(3)
        if tint is not None:
            m[tint] = 1
        mask = mask * (1 - a) + m * a

    # ---- the mouth: a dark line where the lips meet (the skin's own colour).
    detail = np.where(mouth[..., None], detail * 0.22, detail)
    if mouth.any():
        mp = pos[mouth]
        mx = float(np.abs(mp[:, 0]).max())
        mz = float(mp[:, 2].mean())
        d = distance_to(pos, mouth, skin_area, ((-mx - 0.008, mx + 0.008), (mz - 0.012, mz + 0.012)))
        line = blur(smoothstep(0.0024, 0.0008, d), msk, 2)
        detail = detail * (1 - line[..., None] * np.array([0.5, 0.6, 0.62]))

    # ---- the eyes: where MakeHuman's eyeball shows through the lids; the white kept plain. The irises are the
    # eye presets' (see `features`).
    eye_s = np.clip(s, 0.4, 1.05)[..., None]
    sclera = np.array([0.86, 0.84, 0.8]) * eye_s
    detail = np.where(eye[..., None], sclera, detail)
    mask = np.where(eye[..., None], 0.0, mask)

    # ---- lashes: a dark line along the upper lid, heavier toward the outer corner, a faint one under the eye.
    upper, lower, outer = lid_lines(pos, eye, skin_area)
    w = look["lash"]
    paint(smoothstep(w, w / 2, upper) * (0.75 + 0.25 * outer), np.array([0.05, 0.04, 0.04]))
    detail = detail * (1 - 0.25 * smoothstep(0.0011, 0.0004, lower))[..., None]

    # ---- the scalp under the hair, in the hair's colour, so the roots never show skin.
    centre = mhhead.landmark("centre", maps["fig"].name)
    cx, cy = centre[0], centre[1]
    az = np.degrees(np.arctan2(np.abs(x - cx), -(y - cy)))
    keys = np.arange(0, 181)
    line = np.interp(az, keys, [hair.hairline_z(maps["fig"], a) for a in keys])
    scalp = smoothstep(line - 0.002, line + 0.006, z) * skin_area
    paint(scalp, np.ones(3) * 0.3 * np.clip(s, 0.5, 1.1)[..., None], tint=2)
    return np.clip(detail, 0, 1), np.clip(mask, 0, 1)


# How dark the overlays paint in the hair's colour (a tint factor: 0.5 is the colour itself). The game
# composites them over the face the same way (render/cel/rider.ts).
BROW_TONE = 0.15
BEARD_TONE = 0.4


# How much of each brow preset's hairs fill into its solid shape (where the coverage starts and is full): the
# bushy brow fills out, the thin one stays a line.
BROW_FILL = {"male": [(0.06, 0.45), (0.035, 0.28), (0.04, 0.32), (0.05, 0.36), (0.06, 0.36)],
             "female": [(0.12, 0.5), (0.1, 0.46), (0.08, 0.42), (0.1, 0.46), (0.1, 0.46)]}


def brows(maps, brow_tex, n=0):
    """Brow preset `n`'s coverage of the face (0-1): MakeHuman's brow filled into a solid shape with its hairs at
    the edges."""
    msk = maps["inside"]
    ids = _ids(maps)
    part = maps["part"]
    eye = (part == ids.get("eye", -1)) & msk
    mouth = (maps.get("low_part", part) == ids.get("mouth", -1)) & msk
    b = np.clip(brow_tex[..., 0], 0, 1)
    b = np.maximum(b, blur(b, msk, 2))
    # (Past the islands' edges too, so the texels just outside them don't draw a line.)
    lo, hi = BROW_FILL[maps["fig"].name][n]
    return smoothstep(lo, hi, b) * ~eye * ~mouth * 0.97


def _landmarks(maps):
    """Where the beard's shapes hang from, on the detailed head: the mouth (centre, half width, z), the nose's
    base and the bottom of the chin."""
    pos = maps["pos"]
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    # (Only texels the bake reached: rays can miss the detailed head behind the lips.)
    msk = maps["inside"] & (np.linalg.norm(pos, axis=-1) > 0.5)
    ids = _ids(maps)
    part = maps["part"]
    mouth = (maps.get("low_part", part) == ids.get("mouth", -1)) & msk
    mp = pos[mouth]
    mx, mz = float(np.abs(mp[:, 0]).max()), float(np.median(mp[:, 2]))
    eye_z = mhhead.landmark("eye_l", maps["fig"].name)[2]
    mid = msk & (np.abs(x) < 0.004)
    # The nose's tip is the face's most forward point between the mouth and the eyes; its base, the deepest
    # point between the tip and the lips.
    between = mid & (z > mz + 0.006) & (z < eye_z - 0.01)
    tip_z = float(z[between][np.argmin(y[between])])
    under = mid & (z > mz + 0.006) & (z < tip_z)
    base_z = float(z[under][np.argmax(y[under])])
    # The chin's front, then its bottom: where the face below the mouth turns to look down.
    below = mid & (z < mz - 0.01) & (maps["nrm"][..., 1] < -0.2)
    chin_z = float(z[below].min()) if below.any() else mz - 0.045
    return {"mx": mx, "mz": mz, "nose": base_z, "chin": chin_z, "eye": float(eye_z)}


def _smooth_max(a, b, k):
    """The larger of two margins, rounded where they meet (over about `k`)."""
    m = np.maximum(a, b)
    return m + k * np.log(np.exp((a - m) / k) + np.exp((b - m) / k))


def beard(maps, tex, kind):
    """A beard preset's coverage of the face (0-1): 1 stubble, 2 a moustache, 3 a goatee, 4 a short beard."""
    msk = maps["inside"]
    pos = maps["pos"]
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    ax = np.abs(x)
    m = _landmarks(maps)
    ids = _ids(maps)
    part = maps["part"]
    eye = (part == ids.get("eye", -1)) & msk
    mouth = (maps.get("low_part", part) == ids.get("mouth", -1)) & msk
    skin = ~eye & ~mouth
    face = smoothstep(-0.02, -0.06, y) * smoothstep(-0.1, -0.45, maps["nrm"][..., 1])
    rel = relative_skin(maps, tex, msk & skin & (face > 0.5))
    red = rel[..., 0] - 0.5 * (rel[..., 1] + rel[..., 2])
    lips = blur(smoothstep(0.03, 0.12, red) * smoothstep(0.014, 0.008, np.abs(z - m["mz"])), msk, 2)
    mx, mz = m["mx"], m["mz"]
    ear = mhhead.landmark("ear", maps["fig"].name)
    # Hair grows in tufts: the edges break up.
    rough = (fbm(pos, 260, octaves=2, seed=21) - 0.5) * 0.0024

    def area(margin, soft=0.0009):
        return smoothstep(-soft, soft, margin + rough)

    # The moustache: a chevron over the whole upper lip, from just under the nose, wider than the mouth and
    # dropping toward its ends.
    lip_top = mz + 0.0045 + 0.0035 * smoothstep(mx, 0.0, ax)
    moustache = np.minimum.reduce([
        (m["nose"] - 0.003 - 0.007 * smoothstep(0.0, mx + 0.009, ax)) - z,
        z - (lip_top - 0.0012 - 0.006 * smoothstep(0.55 * mx, mx + 0.009, ax)),
        (mx + 0.009) - ax,
        -0.02 - y,
    ])
    # The chin: under the lower lip and round the chin, narrowing to it.
    lip_bottom = mz - 0.0055 - 0.003 * smoothstep(mx, 0.0, ax)
    chin = np.minimum.reduce([
        lip_bottom - z,
        z - (m["chin"] - 0.005),
        (mx * 0.95) - ax - 0.35 * np.maximum(0, lip_bottom - 0.012 - z),
    ])
    # Joining the two round the corners of the mouth.
    corners = np.minimum.reduce([0.0035 - np.abs(ax - (mx + 0.0035)), lip_top - z, z - (lip_bottom - 0.004)])
    # The whole beard: along the jaw from the corners of the mouth, up in front of the ears as sideburns,
    # under the jaw down to a neckline (above where the head meets the neck).
    cheek = mz + 0.01 + 0.022 * smoothstep(mx + 0.004, ear[0] - 0.01, ax) ** 1.4
    neck = (m["chin"] - 0.008) + (mz - 0.022 - (m["chin"] - 0.008)) * smoothstep(0.01, ear[0] - 0.012, ax) ** 1.3
    jaw = np.minimum.reduce([cheek - z, z - neck, (ear[1] - 0.01) - y])
    # Sideburns: down in front of the ears, narrowing as they rise.
    rise = np.clip((z - mz) / max(m["eye"] - mz, 1e-3), 0, 1)
    sideburn = np.minimum.reduce([(ear[1] - 0.009) - y, y - (ear[1] - 0.027 + 0.011 * rise),
                                  (m["eye"] - 0.006) - z, z - neck])
    full = np.maximum(_smooth_max(jaw, sideburn, 0.003), moustache)
    if kind == 1:
        # Darkest on the chin and the upper lip, fading up the cheeks.
        a = area(full, 0.003) * (0.12 + 0.2 * smoothstep(cheek - 0.002, cheek - 0.022, z)
                                 + 0.1 * smoothstep(ear[0] - 0.02, mx, ax))
    elif kind == 2:
        a = area(moustache)
    elif kind == 3:
        a = area(np.maximum.reduce([moustache, chin, corners]))
    else:
        a = area(full)
    return np.clip(a * skin * (1 - lips), 0, 1)


# ---------------------------------------------------------------- the feature presets

# How the presets' paint shows (tint factors, as the game composites it: render/cel/rider.ts): ink lines, the
# iris in the eye's colour, its catchlight.
INK_TONE = 0.03
IRIS_TONE = 0.41
GLINT_TONE = 0.95
# The portrait light the face's paint is lit by (toward it), and how strongly a preset's change of shape moves
# the cel shade line (light lost or gained, before it is clipped to -1..1).
PORTRAIT_KEY = np.array([-0.75, -1.0, 0.8]) / np.linalg.norm([-0.75, -1.0, 0.8])
SHAPE_SHADE = 3.0
SHAPE_DEAD = 0.25

# What each eye preset draws over the face's own lash line: the iris's size, how heavy the upper lash is
# (toward the outer corner), a flick past the outer corner (and its angle up), a lower lash line (all along it,
# or toward the outer corner), the lid's crease (how far above the lid, how dark) and a shade under the eye.
# Per body: the female's all have a heavier lash with a flick, and a bigger iris.
EYE_STYLES = {
    "male": [
        {},
        {"lash": 1.7, "flick": 1.0, "lower_outer": 0.7},
        {"iris": 1.28, "lower": 0.55, "crease": (0.0042, 0.5)},
        {"lash": 2.0, "crease": (0.0024, 0.85), "bag": 0.7},
        {"lash": 1.3, "flick": 0.8, "flick_angle": -24, "crease": (0.0034, 0.6), "lower_outer": 0.6},
    ],
    "female": [
        {"lash": 1.6, "flick": 0.9, "iris": 1.12, "lower_outer": 0.35},
        {"lash": 2.0, "flick": 1.0, "iris": 1.06, "lower_outer": 0.6},
        {"lash": 1.6, "flick": 0.6, "iris": 1.32, "lower": 0.45, "crease": (0.0042, 0.45)},
        {"lash": 2.2, "flick": 0.8, "iris": 1.1, "crease": (0.0026, 0.7)},
        {"lash": 1.6, "flick": 0.7, "flick_angle": -18, "iris": 1.16, "crease": (0.0034, 0.5), "lower_outer": 0.5},
    ],
}
# And each mouth preset: creases round the corners of a grin, a shade under the lower lip, the edge of the
# upper lip, a heavier line where the lips meet, the corners turned down, the crease above the chin, the
# corners tucked in. Noses draw only by their shape's light.
MOUTH_STYLES = [
    {},
    {"smile": 1.0, "line": 0.4},
    {"under_lip": 0.8, "bow": 0.45},
    {"line": 0.7, "stern": 1.0, "chin": 0.6},
    {"under_lip": 0.6, "corners": 0.9},
]
NOSE_STYLES = [{}, {}, {}, {}, {}]


def _segment(p, a, b):
    """Each point's distance to the segment a-b, and how far along it it is (0-1)."""
    ab = b - a
    t = np.clip(((p - a) @ ab) / max(float(ab @ ab), 1e-12), 0, 1)
    return np.linalg.norm(p - (a + t[..., None] * ab), axis=-1), t


def _eye_features(lp0, lp, eye, skin, style, ink, shade, iris, glint):
    r = IRIS * style.get("iris", 1.0)
    x, y, z = lp[..., 0], lp[..., 1], lp[..., 2]
    upper, lower, outer = lid_lines(lp, eye, skin, reach=0.009)
    for side in (1, -1):
        sel = eye & (np.sign(lp0[..., 0]) == side)
        if not sel.any():
            continue
        c0, c = lp0[sel].mean(axis=0), lp[sel].mean(axis=0)
        # The eyeball stays where it is when the lids move: the iris follows the opening across, and only a
        # little up and down, so the lids cut it.
        cx, cz = c[0], c0[2] + 0.35 * (c[2] - c0[2])
        d = np.hypot(x - cx, z - cz)
        # A round disc with a dark rim, lighter below the pupil where the light comes through, and a catchlight
        # up toward the light.
        disc = smoothstep(r * 1.06, r * 0.94, d) * sel
        below = smoothstep(cz + 0.2 * r, cz - 0.6 * r, z)
        f = 0.24 + 0.17 * smoothstep(r, 0.5 * r, d) * (0.4 + 0.6 * below)
        np.maximum(iris, disc, out=iris)
        # (The rim darker: ink over the iris, as much as takes its colour down to `f`.)
        np.maximum(ink, (1 - np.sqrt(f / IRIS_TONE)) * disc, out=ink)
        np.maximum(ink, smoothstep(0.44 * r, 0.36 * r, d) * sel, out=ink)
        dc = np.hypot(x - (cx - 0.3 * r), z - (cz + 0.3 * r))
        np.maximum(glint, smoothstep(0.2 * r, 0.12 * r, dc) * sel * 0.9, out=glint)
        if style.get("flick"):
            # From the outer corner, out and up, tapering.
            pts = lp[sel]
            k = pts[np.argmax(pts[:, 0] * side)]
            a = np.radians(style.get("flick_angle", 26))
            tip = k + np.array([side * np.cos(a), 0.0, np.sin(a)]) * 0.005
            dist, t = _segment(lp[..., [0, 2]], k[[0, 2]], tip[[0, 2]])
            width = 0.0011 * (1 - t) + 0.00015
            near = skin & (np.abs(y - k[1]) < 0.012) & (np.sign(x) == side)
            np.maximum(ink, smoothstep(width, width * 0.55, dist) * near * style["flick"], out=ink)
    side_ok = skin
    w = style.get("lash", 1.0)
    if w > 1:
        t = 0.0016 * (1 + (w - 1) * (0.35 + 0.65 * outer))
        np.maximum(ink, smoothstep(t, 0.55 * t, upper) * (0.75 + 0.25 * outer) * side_ok, out=ink)
    low = style.get("lower", 0.0) * smoothstep(0.001, 0.0004, lower) * smoothstep(0.05, 0.2, outer)
    low = low + style.get("lower_outer", 0.0) * smoothstep(0.0012, 0.0005, lower) * smoothstep(0.45, 0.85, outer)
    np.maximum(ink, np.clip(low, 0, 1) * side_ok, out=ink)
    if "crease" in style:
        h, k = style["crease"]
        band = smoothstep(0.0006, 0.00025, np.abs(upper - h))
        along = smoothstep(0.08, 0.3, outer) * smoothstep(1.0, 0.86, outer)
        np.maximum(ink, band * along * k * side_ok, out=ink)
    if style.get("bag"):
        band = smoothstep(0.0011, 0.0004, np.abs(lower - 0.0034))
        along = smoothstep(0.25, 0.45, outer) * smoothstep(0.95, 0.75, outer)
        np.maximum(shade, band * along * style["bag"] * side_ok, out=shade)


def _mouth_features(lp, mouth, skin, lips, style, ink, shade, msk):
    x, y, z = lp[..., 0], lp[..., 1], lp[..., 2]
    ax = np.abs(x)
    mp = lp[mouth]
    mx, mz = float(np.abs(mp[:, 0]).max()), float(np.median(mp[:, 2]))
    near = skin & (y < float(mp[:, 1].max()) + 0.012)
    mid = msk & (ax < 0.004) & (lips > 0.5)
    lower_z = float(z[mid & (z < mz)].min()) if (mid & (z < mz)).any() else mz - 0.008
    if style.get("line"):
        d = distance_to(lp, mouth, skin, ((-mx - 0.006, mx + 0.006), (mz - 0.01, mz + 0.01)))
        line = smoothstep(0.0013, 0.0005, d) * smoothstep(mx + 0.002, mx - 0.004, ax)
        np.maximum(ink, line * style["line"], out=ink)
    for side in (1, -1):
        pts = mp[np.sign(mp[:, 0]) == side]
        if not len(pts):
            continue
        k = pts[np.argmax(pts[:, 0] * side)]
        here = near & (np.sign(x) == side)
        if style.get("smile"):
            # A bracket round the corner, open toward it.
            q = k + np.array([-side * 0.0035, 0.0, 0.0006])
            rr = 0.0064
            th = np.degrees(np.arctan2(z - q[2], side * (x - q[0])))
            ring = np.abs(np.hypot(x - q[0], z - q[2]) - rr)
            taper = smoothstep(-58, -30, th) * smoothstep(52, 22, th)
            width = 0.00085 * taper + 0.0001
            np.maximum(ink, smoothstep(width, width * 0.5, ring) * taper * here * style["smile"], out=ink)
        if style.get("stern"):
            dist, t = _segment(lp[..., [0, 2]], (k + np.array([side * 0.0006, 0, -0.0004]))[[0, 2]],
                               (k + np.array([side * 0.0019, 0, -0.0045]))[[0, 2]])
            width = 0.0008 * (1 - t) + 0.00015
            np.maximum(ink, smoothstep(width, width * 0.5, dist) * here * 0.8 * style["stern"], out=ink)
        if style.get("corners"):
            dc = np.hypot(x - (k[0] + side * 0.0004), z - k[2])
            np.maximum(ink, smoothstep(0.0013, 0.0006, dc) * near * style["corners"], out=ink)
    if style.get("under_lip"):
        # A shade under the lower lip, widest in the middle.
        e = np.hypot(x / max(0.62 * mx, 1e-4), (z - (lower_z - 0.0017)) / 0.0017)
        np.maximum(shade, smoothstep(1.0, 0.6, e) * near * ~(lips > 0.5) * style["under_lip"], out=shade)
    if style.get("bow"):
        edge = smoothstep(0.2, 0.45, lips) * smoothstep(0.85, 0.6, lips) * (z > mz + 0.001)
        np.maximum(ink, edge * smoothstep(0.85 * mx, 0.4 * mx, ax) * near * style["bow"], out=ink)
    if style.get("chin"):
        cz = lower_z - 0.0085
        e = np.hypot(x / 0.0065, (z - (cz + 0.0018 * (x / 0.0065) ** 2)) / 0.0006)
        np.maximum(ink, smoothstep(1.0, 0.5, e) * near * style["chin"], out=ink)


def _portrait(n):
    """How the portrait light falls on a surface facing `n` (0-1)."""
    n = n / (np.linalg.norm(n, axis=-1, keepdims=True) + 1e-12)
    return np.clip(n @ PORTRAIT_KEY, 0, 1)


def features(maps, offsets, normals, tex):
    """Each eye, nose and mouth preset's paint over the face, painted on the preset's own shape: {name: (h, w,
    3)}, as ink lines, how the preset moves the cel shade line (0.5 not at all, lower toward light, higher
    toward shade), and the iris (in the eye's colour) up to 0.5 then its catchlight above. `offsets` are how far
    each preset moves each texel of the game mesh ({`<part>.<n>`: (h, w, 3)}), `normals` which way the mesh faces
    there, as designed ("") and with each preset."""
    msk = maps["inside"]
    ids = _ids(maps)
    part = maps["part"]
    eye = (part == ids.get("eye", -1)) & msk
    mouth = (maps.get("low_part", part) == ids.get("mouth", -1)) & msk
    skin = msk & ~eye & ~mouth
    lp0 = maps.get("low_pos", maps["pos"])
    pos = maps["pos"]
    face = smoothstep(-0.02, -0.06, pos[..., 1]) * smoothstep(-0.1, -0.45, maps["nrm"][..., 1])
    rel = relative_skin(maps, tex, skin & (face > 0.5))
    red = rel[..., 0] - 0.5 * (rel[..., 1] + rel[..., 2])
    mz = float(np.median(lp0[mouth][:, 2])) if mouth.any() else 0.0
    lips = smoothstep(0.05, 0.16, red) * smoothstep(0.016, 0.01, np.abs(lp0[..., 2] - mz)) * face
    zero = np.zeros_like(lp0)
    light0 = _portrait(normals[""])
    out = {}
    body = maps["fig"].name
    for name, styles in (("eyes", EYE_STYLES[body]), ("nose", NOSE_STYLES), ("mouth", MOUTH_STYLES)):
        for n, style in enumerate(styles):
            if name != "eyes" and n == 0:
                continue
            off = offsets.get(f"{name}.{n}", zero)
            lp = lp0 + off
            ink, shade, iris, glint = (np.zeros(msk.shape) for _ in range(4))
            if name == "eyes":
                _eye_features(lp0, lp, eye, skin, style, ink, shade, iris, glint)
            elif name == "mouth":
                _mouth_features(lp, mouth, skin, lips, style, ink, shade, msk)
            # Where the preset changes the shape, the light it gains or loses moves the shade line.
            moved = blur(smoothstep(0.0001, 0.0006, np.linalg.norm(off, axis=-1)), msk, 4) * skin
            lost = blur(light0 - _portrait(normals.get(f"{name}.{n}", normals[""])), msk, 2) * SHAPE_SHADE
            # (Small changes leave the line where it is; light gained counts for less, so a preset never carves a
            # lit patch out of the face's shade.)
            lost = np.sign(lost) * np.maximum(np.abs(lost) - SHAPE_DEAD, 0) * moved
            lost = np.where(lost < 0, 0.5 * lost, lost)
            push = np.clip(lost + shade, -1, 1)
            # (The catchlight sits inside the iris: the two share a channel, the catchlight in its upper half.)
            rgb = np.stack([ink * msk, 0.5 + 0.5 * push * msk,
                            (0.5 * np.clip(iris, 0, 1) + 0.5 * np.clip(glint, 0, 1)) * msk], axis=-1)
            out[f"{name}.{n}"] = np.clip(rgb, 0, 1)
    return out
