"""Painting the body and face from their baked maps.

The detail map holds tint factors per channel where the mask is set (0.5 is
the tint itself), a plain sRGB colour elsewhere; the mask says which tint:
R skin, G eyes, B hair. The baked light becomes the paint's shading, with
warm, saturated shadows the way skin was painted on the old consoles.
"""

import numpy as np

from paint import fbm, smoothstep


def light_reference(maps, pct=80):
    """The baked light that paints as the tint itself: most of the body is at or below it."""
    inside = maps["inside"]
    return float(np.percentile(maps["light"][inside], pct)) if inside.any() else 1.0


def blur(img, inside, r=2):
    """A box blur of `img` that stays within the islands (`inside`), so it never bleeds across seams."""
    m = inside.astype(np.float64)
    a = img * m
    for axis in (0, 1):
        acc_a, acc_m = np.zeros_like(a), np.zeros_like(m)
        for d in range(-r, r + 1):
            acc_a += np.roll(a, d, axis=axis)
            acc_m += np.roll(m, d, axis=axis)
        a, m = acc_a, acc_m
    return np.where(inside, a / np.maximum(m, 1e-6), img)


def masses(s, centre=0.8, sharp=4.2, amount=0.7):
    """Groups the light into light and shadow masses with a soft edge between, the way it was painted."""
    curve = centre + 0.42 * np.tanh((s - centre) * sharp)
    return s * (1 - amount) + curve * amount


def shading(maps, ref, gamma=1.3, floor=0.16, top=1.12):
    """The baked light as a 0-ish to 1.2 shading value (1 = a surface facing the front, unshadowed)."""
    L = blur(maps["light"], maps["inside"], 2)
    s = np.clip(L / max(ref, 1e-6), 0, top)
    s = s**gamma
    ao = np.clip(blur(maps["ao"], maps["inside"], 2), 0, 1)
    s = s * (0.5 + 0.5 * ao)
    return masses(np.maximum(s, floor))


def skin_factors(s, warmth=1.0, maps=None, mottle=9.0):
    """Tint factors for skin at shading `s`: shadows warmer and more saturated, lights a touch golden; with the
    maps, a painter's mottling and the cool light the sea throws up into the undersides."""
    g = 0.5 * s
    dark = np.clip(1 - s, 0, 1)[..., None]
    light = np.clip(s - 1, 0, 1)[..., None]
    hue = 1 + warmth * (dark * np.array([0.3, -0.06, -0.32]) + light * np.array([0.03, 0.0, -0.1]))
    # Painted skin is never grey: a golden warmth through the midtones.
    mid = np.exp(-(((s - 0.95) / 0.35) ** 2))[..., None]
    hue = hue * (1 + warmth * mid * np.array([0.05, 0.0, -0.12]))
    out = g[..., None] * hue
    if maps is not None:
        pos = maps["pos"]
        warm = fbm(pos, mottle, octaves=3, seed=21) - 0.5
        out = out * (1 + warm[..., None] * np.array([0.12, 0.02, -0.1]))
        under = np.clip(-maps["nrm"][..., 2], 0, 1) ** 1.5
        out = out * (1 + under[..., None] * np.array([-0.02, 0.06, 0.16]) * 0.9) + under[..., None] * 0.025
    return out


def limb(pos, a, b, up, front=(0.0, -1.0, 0.0)):
    """Where texels are around a bone: along it (0 at `a`, 1 at `b`), the angle around it (0 toward `up`,
    90 degrees toward `front`), and the distance from it."""
    a, b = np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64)
    d = b - a
    L = np.linalg.norm(d)
    d = d / L
    up = np.asarray(up, dtype=np.float64)
    up = up - d * np.dot(up, d)
    up /= np.linalg.norm(up)
    fr = np.cross(d, up)
    if np.dot(fr, front) < 0:
        fr = -fr
    q = pos - a
    t = q @ d / L
    r = q - (t * L)[..., None] * d
    u, f = r @ up, r @ fr
    return t, np.degrees(np.arctan2(f, u)), np.hypot(u, f)


def _ang(x, centre, width):
    d = (x - centre + 180) % 360 - 180
    return np.exp(-((d / width) ** 2))


def anatomy(pos):
    """Painted definition: a multiplier on the shading (below 1 darkens, above lights)."""
    import male

    J = male.J
    m = np.ones(pos.shape[:2])
    # Round limbs: lit down their front and outer side, shaded behind and inside, whatever the pose.
    for sgn, L in ((1, "L"), (-1, "R")):
        side = pos[..., 0] * sgn > 0.12
        for a, b in (("upperarm", "forearm"), ("forearm", "hand")):
            t, ang, rad = limb(pos, J[f"{a}.{L}"], J[f"{b}.{L}"], male.arm_up(sgn))
            on = side & (rad < 0.09) & (t > 0.05) & (t < 1.0)
            m = np.where(on, m * (1 + 0.28 * np.tanh(2.2 * np.cos(np.radians(ang - 40)))), m)
        legside = pos[..., 0] * sgn > -0.005
        for a, b in (("thigh", "shin"), ("shin", "foot")):
            t, ang, rad = limb(pos, J[f"{a}.{L}"], J[f"{b}.{L}"], (sgn, 0, 0))
            on = legside & (rad < 0.1) & (t > 0.02) & (t < 1.0)
            m = np.where(on, m * (1 + 0.22 * np.tanh(2.2 * np.cos(np.radians(ang - 60)))), m)
    for sgn, L in ((1, "L"), (-1, "R")):
        side = smoothstep(0.1 * -sgn, 0.14 * sgn, pos[..., 0] * 1.0) if False else (pos[..., 0] * sgn > 0.12)
        up = male.arm_up(sgn)
        t, ang, rad = limb(pos, J[f"upperarm.{L}"], J[f"forearm.{L}"], up)
        on = side & (rad < 0.1) & (t > -0.15) & (t < 1.1)
        # Deltoid: lit cap, a shadowed edge where it meets the arm (lower in front, higher behind).
        edge = 0.42 + 0.08 * np.cos(np.radians(ang - 90))
        delt = smoothstep(0.06, 0.0, np.abs(t - edge)) * _ang(ang, 0, 75)
        m = np.where(on, m * (1 - 0.418 * delt), m)
        m = np.where(on, m * (1 + 0.190 * smoothstep(0.3, 0.05, t) * _ang(ang, 0, 70)), m)
        # Biceps (front) lit, its edges shadowed; triceps behind.
        bic = _ang(ang, 95, 30) * smoothstep(0.35, 0.55, t) * smoothstep(0.95, 0.75, t)
        m = np.where(on, m * (1 + 0.228 * bic), m)
        groove = (_ang(ang, 140, 12) + _ang(ang, 45, 12)) * smoothstep(0.4, 0.6, t) * smoothstep(1.0, 0.8, t)
        m = np.where(on, m * (1 - 0.266 * groove), m)
        tri = _ang(ang, -100, 30) * smoothstep(0.25, 0.45, t) * smoothstep(0.85, 0.65, t)
        m = np.where(on, m * (1 + 0.114 * tri), m)
        # Elbow: the crease inside it, the point behind.
        t2, ang2, rad2 = limb(pos, J[f"forearm.{L}"], J[f"hand.{L}"], up)
        on2 = side & (rad2 < 0.08) & (t2 > -0.2) & (t2 < 1.05)
        crease = _ang(ang2, 100, 35) * smoothstep(0.08, 0.0, np.abs(t2 - 0.02))
        m = np.where(on2, m * (1 - 0.380 * crease), m)
        # Forearm: the muscle along its top near the elbow, the tendons thinning to the wrist.
        top = _ang(ang2, 40, 40) * smoothstep(0.0, 0.15, t2) * smoothstep(0.6, 0.3, t2)
        m = np.where(on2, m * (1 + 0.190 * top), m)
        dip = _ang(ang2, 130, 25) * smoothstep(0.15, 0.35, t2) * smoothstep(0.85, 0.6, t2)
        m = np.where(on2, m * (1 - 0.190 * dip), m)
        wrist = smoothstep(0.035, 0.0, np.abs(t2 - 0.97)) * _ang(ang2, -90, 60)
        m = np.where(on2, m * (1 - 0.190 * wrist), m)

        # Legs: knee cap, the hollow under it, the calf's two heads, the shin bone's edge, the ankle.
        sideL = pos[..., 0] * sgn > -0.005
        t3, ang3, rad3 = limb(pos, J[f"thigh.{L}"], J[f"shin.{L}"], (sgn, 0, 0))
        on3 = sideL & (rad3 < 0.11) & (t3 > 0.0) & (t3 < 1.05)
        knee_cap = _ang(ang3, 90, 40) * smoothstep(0.08, 0.0, np.abs(t3 - 0.97))
        m = np.where(on3, m * (1 + 0.228 * knee_cap), m)
        quad = _ang(ang3, 60, 30) * smoothstep(0.07, 0.0, np.abs(t3 - 0.85))
        m = np.where(on3, m * (1 - 0.190 * quad), m)
        t4, ang4, rad4 = limb(pos, J[f"shin.{L}"], J[f"foot.{L}"], (sgn, 0, 0))
        on4 = sideL & (rad4 < 0.1) & (t4 > -0.1) & (t4 < 1.0)
        under_knee = _ang(ang4, 90, 30) * smoothstep(0.05, 0.0, np.abs(t4 - 0.06))
        m = np.where(on4, m * (1 - 0.266 * under_knee), m)
        knee_side = (_ang(ang4, 30, 18) + _ang(ang4, 150, 18)) * smoothstep(0.06, 0.0, np.abs(t4 - 0.02))
        m = np.where(on4, m * (1 - 0.190 * knee_side), m)
        calf = (_ang(ang4, -60, 30) + _ang(ang4, -125, 30)) * smoothstep(0.1, 0.25, t4) * smoothstep(0.5, 0.33, t4)
        m = np.where(on4, m * (1 + 0.190 * calf), m)
        calf_edge = _ang(ang4, -90, 10) * smoothstep(0.12, 0.25, t4) * smoothstep(0.55, 0.4, t4)
        m = np.where(on4, m * (1 - 0.152 * calf_edge), m)
        under_calf = (_ang(ang4, -40, 35) + _ang(ang4, -145, 35)) * smoothstep(0.42, 0.52, t4) * smoothstep(0.7, 0.55, t4)
        m = np.where(on4, m * (1 - 0.228 * under_calf), m)
        shin = _ang(ang4, 75, 12) * smoothstep(0.1, 0.25, t4) * smoothstep(0.95, 0.75, t4)
        m = np.where(on4, m * (1 + 0.152 * shin), m)

    # Neck: the two cords from behind the ears to the notch between the collarbones; the collarbones.
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    neck = smoothstep(1.44, 1.47, z) * smoothstep(1.56, 1.53, z)
    for sgn in (1, -1):
        t = np.clip((z - 1.465) / 0.09, 0, 1)
        cx = sgn * (0.012 + 0.045 * t)
        cy = -0.05 + 0.06 * t
        dist = np.hypot(x - cx, (y - cy) * 0.6)
        cord = smoothstep(0.012, 0.004, dist) * neck * (y < 0.02)
        m = m * (1 + 0.152 * cord)
        m = m * (1 - 0.228 * smoothstep(0.012, 0.0, np.abs(np.hypot(x - cx * 0.6, (y - cy) * 0.6) - 0.016)) * neck
                 * (y < 0.0) * (np.abs(x) < np.abs(cx)))
        clav = np.exp(-(((z - (1.448 + 0.01 * np.abs(x) / 0.17)) / 0.006) ** 2)) * smoothstep(0.02, 0.04, x * sgn)
        clav = clav * smoothstep(0.18, 0.14, x * sgn) * (y < -0.04)
        m = m * (1 + 0.190 * clav)
        below = np.exp(-(((z - (1.432 + 0.01 * np.abs(x) / 0.17)) / 0.007) ** 2)) * smoothstep(0.03, 0.05, x * sgn)
        below = below * smoothstep(0.17, 0.13, x * sgn) * (y < -0.04)
        m = m * (1 - 0.190 * below)
    notch = np.exp(-((x / 0.012) ** 2) - ((z - 1.452) / 0.008) ** 2) * (y < -0.03)
    m = m * (1 - 0.380 * notch)

    # Chest and belly (under the vest most of the time): the pecs' lower edge, the middle line, the abs.
    front = y < -0.04
    pec = np.exp(-(((z - (1.28 + 0.035 * (np.abs(x) / 0.15) ** 2)) / 0.012) ** 2)) * smoothstep(0.0, 0.03, np.abs(x))
    pec = pec * smoothstep(0.17, 0.13, np.abs(x)) * front
    m = m * (1 - 0.342 * pec)
    mid = np.exp(-((x / 0.006) ** 2)) * smoothstep(1.06, 1.12, z) * smoothstep(1.38, 1.3, z) * front
    m = m * (1 - 0.190 * mid)
    for zz in (1.215, 1.165, 1.115):
        ab = np.exp(-(((z - zz) / 0.006) ** 2)) * smoothstep(0.065, 0.045, np.abs(x)) * front
        m = m * (1 - 0.133 * ab)
    navel = np.exp(-((x / 0.006) ** 2) - ((z - 1.06) / 0.008) ** 2) * front
    m = m * (1 - 0.450 * navel)
    return m


def paint_skin(maps, ref):
    """The body (everything below the jaw): shading, painted definition, warmth at the joints."""
    s = shading(maps, ref)
    curv = maps["curv"]
    c = np.clip((curv - 0.5) * 6, -1, 1)
    s = s * (1 + 0.18 * np.minimum(c, 0) + 0.08 * np.maximum(c, 0))
    pos = maps["pos"]
    # The head's shadow on the neck: a clean shape under the jaw, darkest under the chin, fading down the neck.
    zn, yn, xn = pos[..., 2], pos[..., 1], np.abs(pos[..., 0])
    neck = smoothstep(1.47, 1.5, zn) * (zn < 1.575) * (xn < 0.085)
    s = s + (np.maximum(s, 0.95) - s) * neck
    jaw_line = 1.552 - 0.02 * smoothstep(0.0, 0.06, xn) - 0.012 * smoothstep(-0.05, 0.02, yn)
    cast = smoothstep(jaw_line - 0.028, jaw_line - 0.004, zn) * neck * smoothstep(0.05, -0.02, yn)
    s = s * (1 - 0.45 * cast)
    # Painted definition as value laid over the light, so it shows the same in the light and in the shade.
    s = s + (anatomy(pos) - 1) * 0.85
    # Brush work: soft vertical strokes of value, the way skin was hand-painted.
    strokes = fbm(pos * np.array([60.0, 60.0, 9.0]), 1.0, octaves=2, seed=31) - 0.5
    s = s * (1 + 0.07 * strokes)
    detail = skin_factors(s, maps=maps)
    z = pos[..., 2]
    # Knees and elbows a little ruddier.
    ruddy = smoothstep(0.04, 0.0, np.abs(z - 0.5)) * smoothstep(-0.03, -0.06, pos[..., 1])
    detail *= 1 + ruddy[..., None] * np.array([0.06, -0.02, -0.04])
    mask = np.zeros_like(detail)
    mask[..., 0] = 1
    return np.clip(detail, 0, 1), mask
