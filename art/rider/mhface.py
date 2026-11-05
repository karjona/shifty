"""Painting the MakeHuman face: the head's own light and shadow, and the colour of MakeHuman's skin and brows, baked onto our head and laid out as tint factors (see skin.skin_factors).

The shapes all come from the detailed head (the sockets, the nose, the lips are really there); the painting
groups its light into masses, crisps the features and keeps every colour relative to the skin, so one texture
works for every skin tone, eye colour and hair colour.
"""

import numpy as np

import hair
from paint import smoothstep
from skin import blur, masses, skin_factors


# The iris's radius (m): a little under half the eye's opening, so the lids cut its top.
IRIS = 0.0052


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
    """The face's (detail, mask), or with `flat` its colour without the light."""
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
    lips = smoothstep(0.05, 0.16, red) * face
    detail = detail * (1 + lips[..., None] * np.array([-0.04, -0.12, -0.1]))
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

    # ---- the eyes: where MakeHuman's eyeball shows through the lids; the white kept plain.
    eye_s = np.clip(s, 0.4, 1.05)[..., None]
    sclera = np.array([0.86, 0.84, 0.8]) * eye_s
    detail = np.where(eye[..., None], sclera, detail)
    mask = np.where(eye[..., None], 0.0, mask)
    # The iris painted as a round disc in the middle of the opening, on the game mesh's own surface: a dark
    # rim, lighter below the pupil where the light comes through, a catchlight up toward the light.
    lp = maps.get("low_pos", pos)
    for side in (1, -1):
        sel = eye & (np.sign(lp[..., 0]) == side)
        if not sel.any():
            continue
        c = lp[sel].mean(axis=0)
        r = IRIS
        d = np.hypot(lp[..., 0] - c[0], lp[..., 2] - c[2])
        disc = smoothstep(r * 1.06, r * 0.94, d) * eye
        below = smoothstep(c[2] + 0.2 * r, c[2] - 0.6 * r, lp[..., 2])
        f = 0.24 + 0.17 * smoothstep(r, 0.5 * r, d) * (0.4 + 0.6 * below)
        paint(disc, f[..., None] * np.clip(s, 0.6, 1.05)[..., None] * np.ones(3), tint=1)
        paint(smoothstep(0.44 * r, 0.36 * r, d) * eye, np.array([0.02, 0.02, 0.025]))
        dc = np.hypot(lp[..., 0] - (c[0] - 0.3 * r), lp[..., 2] - (c[2] + 0.3 * r))
        paint(smoothstep(0.2 * r, 0.12 * r, dc) * eye * 0.9, np.array([0.95, 0.95, 0.95]))

    # ---- brows: MakeHuman's brow, filled into a solid shape with its hairs at the edges; hair colour, darker.
    b = np.clip(tex["brow"][..., 0], 0, 1)
    b = np.maximum(b, blur(b, msk, 2))
    brow = smoothstep(0.06, 0.45, b) * skin_area
    paint(brow * 0.97, np.ones(3) * 0.15 * np.clip(s, 0.6, 1.1)[..., None], tint=2)

    # ---- lashes: a dark line along the upper lid, heavier toward the outer corner, a faint one under the eye.
    upper, lower, outer = lid_lines(pos, eye, skin_area)
    paint(smoothstep(0.0016, 0.0008, upper) * (0.75 + 0.25 * outer), np.array([0.05, 0.04, 0.04]))
    detail = detail * (1 - 0.25 * smoothstep(0.0011, 0.0004, lower))[..., None]

    # ---- the scalp under the hair, in the hair's colour, so the roots never show skin.
    cx, cy = hair.CENTRE[0], hair.CENTRE[1]
    az = np.degrees(np.arctan2(np.abs(x - cx), -(y - cy)))
    keys = np.arange(0, 181)
    line = np.interp(az, keys, [hair.hairline_z(a) for a in keys])
    scalp = smoothstep(line - 0.002, line + 0.006, z) * skin_area
    paint(scalp, np.ones(3) * 0.3 * np.clip(s, 0.5, 1.1)[..., None], tint=2)
    return np.clip(detail, 0, 1), np.clip(mask, 0, 1)
