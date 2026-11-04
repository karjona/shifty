"""The male rider's skeleton and body, sculpted as distance fields.

Blender space: z up, the rider faces -y, their left is +x, metres, feet on
z = 0. Rest pose: an A-pose (arms 45 degrees down, palms toward the body).
"""

import math

import numpy as np

from sdf import (
    Bump,
    Displace,
    Capsule,
    Ellipsoid,
    Loft,
    Profile,
    RoundBox,
    RoundCone,
    Sphere,
    Subtract,
    Union,
    frame,
    normalize,
    rot,
)

HEIGHT = 1.78
A = math.radians(45)
UPPER_ARM = 0.285
FOREARM = 0.26
PALM = 0.095


def arm_dir(s):
    return np.array([s * math.cos(A), 0.0, -math.sin(A)])


def joints():
    j = {
        "root": (0, 0, 0),
        "hips": (0, 0.0, 0.96),
        "spine": (0, 0.005, 1.08),
        "chest": (0, 0.012, 1.24),
        "neck": (0, 0.03, 1.465),
        "head": (0, 0.022, 1.585),
    }
    for s, L in ((1, "L"), (-1, "R")):
        sh = np.array([s * 0.195, 0.02, 1.428])
        el = sh + arm_dir(s) * UPPER_ARM
        wr = el + arm_dir(s) * FOREARM + np.array([0, -0.012, 0])
        kn = wr + arm_dir(s) * PALM
        j[f"clavicle.{L}"] = (s * 0.025, -0.005, 1.445)
        j[f"upperarm.{L}"] = tuple(sh)
        j[f"forearm.{L}"] = tuple(el)
        j[f"hand.{L}"] = tuple(wr)
        j[f"fingers.{L}"] = tuple(kn)
        j[f"thigh.{L}"] = (s * 0.088, 0.0, 0.925)
        j[f"shin.{L}"] = (s * 0.097, -0.012, 0.505)
        j[f"foot.{L}"] = (s * 0.1, 0.02, 0.085)
        j[f"toes.{L}"] = (s * 0.105, -0.115, 0.02)
    return {k: np.array(v, dtype=np.float64) for k, v in j.items()}


J = joints()

# Bone tails, for the armature (Blender bones need a length).
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


def _torso():
    # (z, half width, front, back, centre shift forward)
    keys = [
        (0.855, 0.07, 0.06, 0.06, 0.0),
        (0.895, 0.142, 0.085, 0.098, 0.0),
        (0.945, 0.152, 0.088, 0.1, 0.0),
        (1.0, 0.15, 0.087, 0.093, 0.0),
        (1.06, 0.147, 0.086, 0.088, 0.0),
        (1.12, 0.149, 0.087, 0.088, 0.0),
        (1.2, 0.154, 0.092, 0.092, 0.0),
        (1.28, 0.166, 0.099, 0.098, 0.0),
        (1.35, 0.17, 0.101, 0.1, -0.003),
        (1.4, 0.165, 0.094, 0.096, -0.008),
        (1.44, 0.13, 0.076, 0.085, -0.016),
        (1.48, 0.068, 0.052, 0.06, -0.022),
    ]
    z0, z1 = keys[0][0], keys[-1][0]
    lk = [((z - z0) / (z1 - z0), w, f, b, c) for z, w, f, b, c in keys]
    trunk = Profile((0, 0, z0), (0, 0, z1), lk, n=(2.4, 2.2), cap=(0.05, 0.03), bone="spine")
    parts = [trunk]
    for s in (1, -1):
        parts += [
            # Pecs, lats, shoulder blades, glutes.
            Ellipsoid((s * 0.066, -0.08, 1.35), (0.075, 0.022, 0.05), rot(0.15, s * 0.12, s * 0.12), bone="chest"),
            Ellipsoid((s * 0.12, 0.035, 1.3), (0.025, 0.065, 0.1), bone="chest"),
            Ellipsoid((s * 0.078, 0.086, 1.355), (0.062, 0.022, 0.07), rot(0, s * 0.2, 0), bone="chest"),
            Ellipsoid((s * 0.062, 0.058, 0.905), (0.066, 0.042, 0.072), rot(0, s * 0.15, 0), bone="hips"),
            # Trapezius, from the neck out to the shoulder.
            RoundCone((s * 0.035, 0.035, 1.49), (s * 0.175, 0.025, 1.448), 0.042, 0.03, bone="chest"),
        ]
    parts.append(Ellipsoid((0, -0.07, 1.13), (0.066, 0.028, 0.12), bone="spine"))
    body = Union(*parts, k=0.03)
    groove = Capsule((0, 0.103, 1.05), (0, 0.103, 1.38), 0.004)
    return Subtract(body, groove, k=0.012)


def _arm(s):
    L = "L" if s > 0 else "R"
    sh, el, wr, kn = (J[f"{b}.{L}"] for b in ("upperarm", "forearm", "hand", "fingers"))
    d = arm_dir(s)
    front = np.array([0.0, -1.0, 0.0])
    upper = Loft(
        sh - d * 0.02,
        el,
        [(0, 0.068, 0.066), (0.3, 0.064, 0.062), (0.6, 0.059, 0.055), (0.88, 0.048, 0.046), (1, 0.045, 0.043)],
        side=front,
        bone=f"upperarm.{L}",
    )
    Rf = frame(d, front)
    # Deltoid over the shoulder, biceps in front, triceps behind.
    delt = Ellipsoid(sh + d * 0.035 + np.array([0, 0.003, 0.012]), (0.072, 0.068, 0.088), frame(d, (0, 0, 1)),
                     bone=f"upperarm.{L}")
    bic = Ellipsoid(sh + d * 0.16 + front * 0.024, (0.037, 0.038, 0.088), Rf, bone=f"upperarm.{L}")
    tri = Ellipsoid(sh + d * 0.12 - front * 0.026, (0.037, 0.041, 0.095), Rf, bone=f"upperarm.{L}")
    fore = Loft(
        el,
        wr,
        [(0, 0.049, 0.047), (0.18, 0.056, 0.051), (0.45, 0.049, 0.042), (0.8, 0.035, 0.027), (1, 0.03, 0.022)],
        side=front,
        bone=f"forearm.{L}",
    )
    elbow = Sphere(el - front * 0.031, 0.02, bone=f"forearm.{L}")
    hand = _hand(s, wr, kn, d, front)
    return Union(Union(upper, delt, bic, tri, k=0.025), Union(fore, elbow, k=0.02), hand, k=0.02)


def _hand(s, wr, kn, d, front):
    L = "L" if s > 0 else "R"
    # The palm faces the body: its normal is inward and down.
    palm_n = normalize(np.cross(d, front)) * (1 if s > 0 else -1)
    if palm_n[0] * s > 0:
        palm_n = -palm_n
    R = np.stack([front, palm_n, d], axis=1)
    palm = RoundBox(wr + d * 0.05, (0.036, 0.011, 0.036), 0.011, R, bone=f"hand.{L}")
    heel = Ellipsoid(wr + d * 0.025 + front * 0.012, (0.03, 0.017, 0.03), R, bone=f"hand.{L}")
    parts = [palm, heel]
    # Fingers: index in front, pinky behind, each in two segments curled a little toward the palm.
    for off, length, r in ((-0.027, 0.088, 0.0098), (-0.009, 0.095, 0.0102), (0.009, 0.09, 0.0098),
                           (0.026, 0.074, 0.0088)):
        base = kn + front * -off * 1.0 + palm_n * 0.002
        mid = base + d * length * 0.55 + palm_n * 0.008
        tip = mid + normalize(d + palm_n * 0.45) * length * 0.45
        parts += [
            RoundCone(base, mid, r * 1.06, r, bone=f"fingers.{L}"),
            RoundCone(mid, tip, r, r * 0.88, bone=f"fingers.{L}"),
        ]
    # Thumb: off the front of the palm, toward the fingers.
    t0 = wr + d * 0.02 + front * 0.03 + palm_n * 0.01
    t1 = t0 + normalize(d * 0.8 + front * 0.6 + palm_n * 0.4) * 0.045
    t2 = t1 + normalize(d + palm_n * 0.5 + front * 0.1) * 0.035
    parts += [RoundCone(t0, t1, 0.016, 0.0115, bone=f"hand.{L}"), RoundCone(t1, t2, 0.0115, 0.0095, bone=f"hand.{L}")]
    return Union(*parts, k=0.008)


def _leg(s):
    L = "L" if s > 0 else "R"
    hp, kn, an, toe = (J[f"{b}.{L}"] for b in ("thigh", "shin", "foot", "toes"))
    front = np.array([0.0, -1.0, 0.0])
    thigh = Loft(
        hp + np.array([s * 0.0, 0, 0.035]),
        kn,
        [(0, 0.088, 0.086), (0.15, 0.09, 0.087), (0.5, 0.08, 0.075), (0.85, 0.06, 0.056), (1, 0.053, 0.05)],
        side=front,
        bone=f"thigh.{L}",
    )
    d = normalize(kn - hp)
    Rt = frame(d, front)
    quad = Ellipsoid(hp + d * 0.2 + front * 0.03 + np.array([s * 0.008, 0, 0]), (0.05, 0.058, 0.16), Rt,
                     bone=f"thigh.{L}")
    knee = Sphere(kn + front * 0.03 + np.array([0, 0, 0.01]), 0.024, bone=f"shin.{L}")
    shin = Loft(
        kn,
        an,
        [(0, 0.053, 0.053), (0.2, 0.057, 0.054), (0.5, 0.047, 0.044), (0.85, 0.034, 0.031), (1, 0.032, 0.03)],
        side=front,
        bone=f"shin.{L}",
    )
    ds = normalize(an - kn)
    calf = Ellipsoid(kn + ds * 0.13 - front * 0.032 + np.array([-s * 0.004, 0, 0]), (0.042, 0.052, 0.11),
                     frame(ds, front), bone=f"shin.{L}")
    malleoli = [Sphere(an + np.array([s * 0.024, 0.0, 0.0]), 0.017, bone=f"foot.{L}"),
                Sphere(an + np.array([-s * 0.02, -0.004, 0.01]), 0.017, bone=f"foot.{L}")]
    foot = Profile(
        (an[0], 0.05, 0.034),
        (toe[0] + s * 0.008, -0.178, 0.022),
        [(0.0, 0.032, 0.036, 0.034), (0.25, 0.038, 0.05, 0.03), (0.5, 0.043, 0.038, 0.026),
         (0.72, 0.047, 0.028, 0.022), (0.9, 0.045, 0.02, 0.02), (1.0, 0.036, 0.015, 0.016)],
        side=(1, 0, 0),
        front=(0, 0, 1),
        n=(2.2, 3.2),
        cap=(0.03, 0.02),
        bone=f"foot.{L}",
    )
    foot = Union(foot, *malleoli, k=0.02)
    return Union(Union(thigh, quad, k=0.03), Union(knee, shin, calf, k=0.02), foot, k=0.02)


def _neck():
    neck = RoundCone((0, 0.028, 1.43), (0, 0.014, 1.6), 0.064, 0.057, bone="neck")
    sterno = [Capsule((s * 0.046, 0.018, 1.59), (s * 0.016, -0.045, 1.46), 0.013, bone="neck") for s in (1, -1)]
    return Union(neck, *sterno, k=0.02)


def head(proxy=False):
    """The head; `proxy` gives just its broad forms (no nose or ears), for shading the face smoothly."""
    base = [
        Ellipsoid((0, 0.022, 1.668), (0.076, 0.098, 0.106), bone="head"),
        Ellipsoid((0, -0.025, 1.6), (0.064, 0.064, 0.065), bone="head"),
        Ellipsoid((0, -0.012, 1.566), (0.063, 0.07, 0.04), bone="head"),
        Ellipsoid((0, -0.066, 1.542), (0.026, 0.02, 0.018), bone="head"),
    ]
    base += [Sphere((s * 0.057, 0.014, 1.569), 0.019, bone="head") for s in (1, -1)]
    skull = Union(*base, k=0.03)
    # Broad planes only: the features themselves are painted.
    bumps = [
        Bump((0, -0.088, 1.664), (0.014, 0.02, 0.012), 0.0025),
        Bump((0, -0.083, 1.578), (0.028, 0.022, 0.016), 0.0045),
        Bump((0, -0.08, 1.567), (0.02, 0.016, 0.008), 0.0025),
    ]
    for s in (1, -1):
        bumps += [
            Bump((s * 0.03, -0.085, 1.668), (0.032, 0.02, 0.013), 0.0045),
            Bump((s * 0.032, -0.09, 1.649), (0.022, 0.026, 0.016), -0.006),
            Bump((s * 0.05, -0.06, 1.628), (0.03, 0.03, 0.022), 0.004),
            Bump((s * 0.07, -0.04, 1.675), (0.016, 0.03, 0.022), -0.003),
        ]
    face = Displace(skull, *bumps)
    if proxy:
        return face
    nose = [
        RoundCone((0, -0.084, 1.652), (0, -0.098, 1.607), 0.0078, 0.0098, bone="head"),
        Sphere((0, -0.096, 1.603), 0.0108, bone="head"),
        Sphere((0.0122, -0.087, 1.599), 0.008, bone="head"),
        Sphere((-0.0122, -0.087, 1.599), 0.008, bone="head"),
    ]
    ears = []
    for s in (1, -1):
        R = rot(-0.15, 0, s * 0.3)
        ear = Ellipsoid((s * 0.074, 0.018, 1.628), (0.008, 0.018, 0.031), R, bone="head")
        bowl = Ellipsoid((s * 0.08, 0.014, 1.622), (0.005, 0.011, 0.018), R)
        ears.append(Subtract(ear, bowl, k=0.003))
    face = Union(face, Union(*nose, k=0.009), k=0.016)
    return Union(face, *ears, k=0.01)


def body():
    trunk = _torso()
    return Union(trunk, _neck(), head(), _arm(1), _arm(-1), _leg(1), _leg(-1), k=0.022)


def chains():
    """The body's parts and the bones each one hangs from, root first (for skin weights)."""
    out = {
        "trunk": (_torso(), ["hips", "spine", "chest"]),
        "neck": (_neck(), ["neck"]),
        "head": (head(), ["head"]),
    }
    for s, L in ((1, "L"), (-1, "R")):
        out[f"arm.{L}"] = (_arm(s), [f"clavicle.{L}", f"upperarm.{L}", f"forearm.{L}", f"hand.{L}", f"fingers.{L}"])
        out[f"leg.{L}"] = (_leg(s), [f"thigh.{L}", f"shin.{L}", f"foot.{L}", f"toes.{L}"])
    return out


def face_normals(p, n):
    """Face shading: over the front of the face, normals lean toward the broad forms, so the nose and
    mouth light softly and their shapes come from the paint."""
    import sdf

    p = np.asarray(p)
    front = np.clip((-p[:, 1] - 0.035) / 0.04, 0, 1) * np.clip((p[:, 2] - 1.535) / 0.02, 0, 1)
    front *= np.clip((1.7 - p[:, 2]) / 0.02, 0, 1)
    pick = front > 0
    out = n.copy()
    if pick.any():
        smooth = sdf.gradient(head(proxy=True), p[pick], h=0.01)
        w = front[pick, None] * 0.8
        mixed = n[pick] * (1 - w) + smooth * w
        out[pick] = mixed / np.linalg.norm(mixed, axis=1, keepdims=True)
    return out


def in_head(p):
    """Whether points belong to the face texture: the head above the jaw line and the hairline at the nape."""
    p = np.asarray(p)
    return p[:, 2] > 1.538 + 0.5 * np.maximum(0, p[:, 1] + 0.07)


REGIONS = ["torso", "hips", "thighs", "shins", "feet", "upperarms", "forearms", "hands"]


def regions(c):
    """Which body region each point (face centre) is in: an index into REGIONS."""
    c = np.asarray(c)
    names = ["trunk", "neck", "arm.L", "arm.R", "leg.L", "leg.R"]
    ch = chains()
    D = np.stack([ch[n][0].eval(c) for n in names], axis=1)
    near = np.array(names)[np.argmin(D, axis=1)]
    z = c[:, 2]
    out = np.where(z < 1.03, 1, 0)
    leg = np.char.startswith(near, "leg")
    out = np.where(leg, np.where(z >= 0.55, 2, np.where(z >= 0.11, 3, 4)), out)
    for s, L in ((1, "L"), (-1, "R")):
        arm = near == f"arm.{L}"
        along = (c - J[f"upperarm.{L}"]) @ arm_dir(s)
        out = np.where(arm, np.where(along < UPPER_ARM, 5, np.where(along < UPPER_ARM + FOREARM, 6, 7)), out)
    return out


def in_ear(c):
    """Whether a face centre is on an ear."""
    ax = abs(c[0])
    return ax > 0.069 and -0.012 < c[1] < 0.05 and 1.585 < c[2] < 1.672


def warm_spots():
    """Where skin shows more blood: (centre, radii)."""
    spots = [((0, -0.1, 1.603), (0.014, 0.02, 0.014))]
    for s in (1, -1):
        L = "L" if s > 0 else "R"
        spots += [
            ((s * 0.045, -0.072, 1.615), (0.024, 0.03, 0.02)),
            ((s * 0.078, 0.015, 1.63), (0.015, 0.03, 0.035)),
            (tuple(J[f"forearm.{L}"] + (0, 0.03, 0)), (0.03, 0.03, 0.03)),
            (tuple(J[f"shin.{L}"] + (0, -0.04, 0.01)), (0.04, 0.03, 0.04)),
            (tuple(J[f"fingers.{L}"]), (0.035, 0.035, 0.035)),
        ]
    return spots


def nails():
    """Fingernails: (centre, radii) on the backs of the fingertips."""
    out = []
    for s in (1, -1):
        L = "L" if s > 0 else "R"
        d = arm_dir(s)
        front = np.array([0.0, -1.0, 0.0])
        palm_n = normalize(np.cross(d, front)) * (1 if s > 0 else -1)
        if palm_n[0] * s > 0:
            palm_n = -palm_n
        kn = J[f"fingers.{L}"]
        for off, length in ((-0.027, 0.088), (-0.009, 0.095), (0.009, 0.09), (0.026, 0.074)):
            base = kn + front * -off + palm_n * 0.002
            mid = base + d * length * 0.55 + palm_n * 0.008
            tip = mid + normalize(d + palm_n * 0.45) * length * 0.45
            out.append((tuple(tip - normalize(d + palm_n * 0.45) * 0.007 - palm_n * 0.008), (0.009, 0.009, 0.009)))
    return out


EYE = (0.032, -0.0685, 1.648)
MOUTH_Z = 1.5735


def paint_face(c, m):
    from paint import blob, fbm, smoothstep

    p = m["pos"]
    x, y, z = p[..., 0], p[..., 1], p[..., 2]
    ax = np.abs(x)
    front = y < -0.04
    # Scalp under the hair and the sideburns: hair colour, darker at the roots.
    hairline = 1.705 + 0.012 * smoothstep(0.0, 0.06, ax)
    scalp = (smoothstep(hairline - 0.004, hairline + 0.004, z) * smoothstep(-0.06, -0.02, y + 0.06 * (ax > 0.05)))
    scalp = np.maximum(scalp, smoothstep(0.02, 0.05, y) * smoothstep(1.6, 1.64, z))
    burns = (smoothstep(0.066, 0.072, ax) * smoothstep(-0.03, -0.02, y) * (1 - smoothstep(0.012, 0.02, y))
             * smoothstep(1.6, 1.61, z) * (1 - smoothstep(1.665, 1.675, z)))
    hair = np.clip(scalp + burns, 0, 1)
    strands = fbm(p * np.array([1.0, 1.0, 0.3]), 900, 2, seed=11)
    c.tint(2, 1.0, hair)
    c.factor(np.stack([0.32 + 0.12 * strands] * 3, -1), hair)

    # Brows: an arch over each eye, thick at the inner end; strands run outward.
    bx = np.clip((ax - 0.011) / 0.043, 0, 1)
    bz = 1.6645 + 0.0045 * np.sin(np.pi * np.clip(bx * 1.15, 0, 1)) - 0.002 * bx
    bt = 0.0042 * (1 - bx) + 0.0018
    brow = (1 - smoothstep(bt * 0.6, bt, np.abs(z - bz))) * (ax > 0.009) * (ax < 0.056) * front
    brow *= smoothstep(0.009, 0.013, ax) * (1 - smoothstep(0.05, 0.056, ax))
    bstr = fbm(p * np.array([0.25, 1.0, 1.0]), 1400, 2, seed=5)
    c.tint(2, 1.0, brow * 0.95)
    c.factor(np.stack([0.3 + 0.18 * bstr] * 3, -1), brow * 0.95)

    for s in (1, -1):
        ex, ey, ez = s * EYE[0], EYE[1], EYE[2]
        dx = (x - ex) * s
        dz = z - ez
        near = (y < ey) & (np.abs(dx) < 0.03) & (np.abs(dz) < 0.03)
        half = 0.0135
        u = np.clip(1 - ((dx + 0.0015) / half) ** 2, 0, 1)
        upper = 0.0058 * u**0.55
        lower = -0.0037 * np.clip(1 - (dx / half) ** 2, 0, 1) ** 0.7
        opening = near & (dz < upper) & (dz > lower) & (np.abs(dx) < half)
        soft = opening * smoothstep(0, 0.0007, upper - dz) * smoothstep(0, 0.0005, dz - lower)
        # Whites, shaded under the lid and toward the corners.
        corner = smoothstep(0.004, half, np.abs(dx))
        white = 0.9 - 0.25 * smoothstep(-0.001, 0.004, dz) * 0.6 - 0.18 * corner
        c.colour(np.stack([white * 0.98, white * 0.95, white * 0.92], -1), soft)
        r = np.sqrt(dx**2 + (dz - 0.0003) ** 2)
        iris = soft * (1 - smoothstep(0.0053, 0.0059, r))
        rays = fbm(np.stack([np.arctan2(dz, dx) * 0.02, r * 0.2, np.zeros_like(r)], -1), 300, 2, seed=s + 20)
        ring = smoothstep(0.0042, 0.0057, r)
        ifac = 0.55 + 0.12 * (rays - 0.5) - 0.3 * ring + 0.12 * (1 - smoothstep(0.0022, 0.004, r))
        ifac = ifac - 0.22 * smoothstep(0.001, 0.0045, dz)
        c.tint(1, 1.0, iris)
        c.factor(np.stack([ifac] * 3, -1), iris)
        c.colour((0.04, 0.035, 0.035), soft * (1 - smoothstep(0.0021, 0.0025, r)))
        glint = blob(np.stack([dx, dz, np.zeros_like(dx)], -1), (-0.0018, 0.0018, 0), (0.0011, 0.0011, 1))
        c.colour((1, 1, 1), soft * np.clip(glint * 2, 0, 1) * 0.9)
        # Lash line along the upper lid, heavier toward the outer corner; a crease above.
        lid = near & (np.abs(dx) < half + 0.002)
        lash_w = 0.0007 + 0.0009 * smoothstep(-0.004, 0.012, dx)
        lash = lid * (1 - smoothstep(lash_w * 0.5, lash_w, np.abs(dz - upper - lash_w * 0.4)))
        c.colour((0.1, 0.07, 0.06), np.clip(lash, 0, 1) * 0.95)
        crease = lid * (1 - smoothstep(0.0, 0.0016, np.abs(dz - upper - 0.0058 * (0.6 + 0.4 * u))))
        c.shade(0.72, crease * 0.8)
        low = lid * (1 - smoothstep(0.0, 0.0008, np.abs(dz - lower + 0.0004)))
        c.shade(0.85, low * 0.7)
        under = near * blob(np.stack([dx, dz, np.zeros_like(dx)], -1), (0.001, -0.009, 0), (0.016, 0.006, 1))
        c.shade(np.stack([0.93, 0.9, 0.92], -1), under)

    # Lips: the upper with a bow, the lower fuller; a mouth line that lifts at one corner.
    lx = np.clip(ax / 0.023, 0, 1)
    smirk = 0.0016 * smoothstep(0.008, 0.022, x)
    mz = MOUTH_Z + smirk - 0.0008 * lx**2
    top = mz + 0.0072 * np.sqrt(np.clip(1 - lx**2, 0, 1)) - 0.0013 * blob(p, (0, -0.09, 1.58), (0.004, 0.05, 0.01))
    bottom = mz - 0.0088 * np.clip(1 - (ax / 0.0195) ** 2, 0, 1) ** 0.6
    lips = (z < top) & (z > bottom) & (y < -0.06) & (ax < 0.024)
    lsoft = lips * smoothstep(0, 0.0012, top - z) * smoothstep(0, 0.0012, z - bottom)
    lower_lip = smoothstep(mz - 0.001, mz - 0.003, z)
    lip = np.stack([0.47 + 0.05 * lower_lip, 0.32 + 0.04 * lower_lip, 0.34 + 0.03 * lower_lip], -1)
    c.factor(lip, lsoft * 0.95)
    line = (1 - smoothstep(0.0003, 0.0011, np.abs(z - mz))) * (ax < 0.024) * (y < -0.06)
    line *= 1 - smoothstep(0.019, 0.025, ax)
    c.shade(0.45, line)
    # A shadow under the lower lip and in the corners of the mouth.
    c.shade(0.88, blob(p, (0, -0.085, 1.561), (0.016, 0.03, 0.004)))
    for s in (1, -1):
        c.shade(0.85, blob(p, (s * 0.023, -0.082, MOUTH_Z + (0.0016 if s > 0 else 0)), (0.004, 0.02, 0.004)))
    # The nose, painted: a lit bridge, sides turning into shade, nostrils, a shadow under the tip.
    nose = (ax < 0.022) & (y < -0.08) & (z > 1.592) & (z < 1.66)
    c.shade(1 - 0.22 * smoothstep(0.004, 0.014, ax) * (z < 1.645), nose)
    c.shade(1.16, blob(p, (0, -0.1, 1.618), (0.004, 0.03, 0.022)))
    for s in (1, -1):
        c.shade(0.42, blob(p, (s * 0.0068, -0.093, 1.5965), (0.0034, 0.02, 0.0022)))
    c.shade(0.82, blob(p, (0, -0.094, 1.5905), (0.016, 0.03, 0.0035)))
    # Light catches the upper lip, the bridge of the nose and the chin.
    c.shade(1.14, blob(p, (0, -0.09, 1.5875), (0.011, 0.03, 0.006)))
    c.shade(1.08, blob(p, (0, -0.095, 1.635), (0.008, 0.03, 0.02)))
    c.shade(1.08, blob(p, (0, -0.08, 1.548), (0.016, 0.03, 0.01)))
