"""People for the middle distance: a crowd behind a barrier, a waiter, club members at a table. Simple cel figures
(limbs and bodies as tapered tubes, a head with its hair or hat), each from a `look` (skin, hair, clothes, height)
in a `pose`. Poses come in pairs to swap between, held on twos like an anime's background characters.

A figure stands on y = 0 at the origin facing +z, their left toward +x. Everything is the `solid` class.

    look(seed)                         a made-up person: a dict to pass on (or to change: `hat`, `top`, `bottom`...)
    figure(look, pose="stand")         their meshes in a pose (a name from POSES)
    figure(look, pose, only="body")    only the body (legs, trunk, head), or only="arms" (arms, hands, what they hold)
    pair(look, name)                   a pair of poses to swap between (a name from PAIRS): (body, arms_a, arms_b)
    pair(look, name, whole=True)       ...as two whole figures (the legs move too): (figure_a, figure_b)
"""

import math

import numpy as np

import kit
from kit import RX, RY, S, T, ball, box, lathe, taper, tube

SKINS = [0xF4CFA6, 0xE6B184, 0xCB915F, 0xA26B43, 0x754A30, 0xF8DDBF]
HAIRS = [0x2B1F1A, 0x4E3220, 0x7E5230, 0xD9B45E, 0xB54B2A, 0xCFCAC2, 0x1B1B20, 0x8E3B2A]
TOPS = [0xF6F1E6, 0xE84A3A, 0x2B6FD0, 0xF2B632, 0x2F9A6B, 0xF08FA8, 0x1E2C5C, 0xF27A2C, 0x6FC3D8, 0xE8E0D0, 0x8A4FB0]
BOTTOMS = [0x1E2C5C, 0xE8DCC4, 0x3A4048, 0xC8683F, 0x2F6E8A, 0xF6F1E6, 0x6B4A30]
SHOES = [0xF6F1E6, 0x3A3A40, 0xC8683F, 0x2B6FD0]
HATS = [0xF6F1E6, 0xE84A3A, 0x2B6FD0, 0xF2B632, 0x1E2C5C]
INK = 0x23242A

# Lengths of a 1.7 m figure.
UPPER_ARM, FOREARM = 0.27, 0.27
THIGH, SHIN = 0.42, 0.42
HIP = 0.9
SHOULDER = (0.2, 0.5)
NECK = 0.57
HEAD = 0.72

#: Poses: where the hands go (left, right), and how the body holds itself. Heights are for a 1.7 m figure.
POSES = {
    "stand": {"hands": ((0.25, 0.86, 0.05), (-0.25, 0.86, 0.05))},
    "hips": {"hands": ((0.23, 1.02, -0.02), (-0.25, 0.86, 0.05)), "bend": ((1, 0, -0.6), None)},
    "clap_a": {"hands": ((0.035, 1.3, 0.3), (-0.035, 1.3, 0.3))},
    "clap_b": {"hands": ((0.16, 1.27, 0.27), (-0.16, 1.27, 0.27)), "head": (-0.08, 0)},
    "cheer_a": {"hands": ((0.34, 1.97, 0.02), (-0.34, 1.97, 0.02)), "head": (-0.15, 0)},
    "cheer_b": {"hands": ((0.25, 2.04, 0.08), (-0.25, 2.04, 0.08)), "head": (-0.22, 0), "rise": 0.05},
    "fist_a": {"hands": ((0.25, 0.9, 0.08), (-0.22, 2.0, 0.06)), "head": (-0.12, 0)},
    "fist_b": {"hands": ((0.25, 0.9, 0.08), (-0.3, 1.8, 0.14)), "head": (-0.05, 0), "lean": 0.04},
    "wave_a": {"hands": ((0.25, 0.86, 0.05), (-0.3, 1.93, 0.06))},
    "wave_b": {"hands": ((0.25, 0.86, 0.05), (-0.47, 1.84, 0.06)), "head": (0, 0.1)},
    "photo_a": {"hands": ((0.1, 1.57, 0.2), (-0.1, 1.57, 0.2)), "prop": "camera", "at": (0, 1.59, 0.25), "bend": ((1, -0.6, 0), (-1, -0.6, 0))},
    "photo_b": {"hands": ((0.1, 1.33, 0.25), (-0.1, 1.33, 0.25)), "prop": "camera", "at": (0, 1.35, 0.3), "head": (-0.12, 0)},
    "phone_a": {"hands": ((0.17, 1.84, 0.2), (-0.25, 0.86, 0.05)), "prop": "phone", "at": (0.17, 1.92, 0.22), "head": (-0.14, 0)},
    "phone_b": {"hands": ((0.22, 1.78, 0.23), (-0.22, 1.0, 0.1)), "prop": "phone", "at": (0.22, 1.86, 0.25), "head": (-0.1, 0.12)},
    "lean": {"hands": ((0.17, 1.03, 0.36), (-0.17, 1.03, 0.36)), "lean": 0.28, "hip": (0, 0, -0.1)},
    "sit_a": {"hands": ((0.16, 0.66, 0.3), (-0.16, 0.66, 0.3)), "sit": True},
    "sit_b": {"hands": ((0.16, 0.66, 0.3), (-0.22, 1.12, 0.34)), "sit": True, "prop": "glass", "at": (-0.22, 1.2, 0.34), "head": (-0.06, 0.2)},
    "waiter_a": {"hands": ((0.3, 1.36, 0.14), (-0.25, 0.9, -0.08)), "prop": "tray", "at": (0.3, 1.42, 0.14), "feet": (0.16, -0.14)},
    "waiter_b": {"hands": ((0.3, 1.38, 0.14), (-0.25, 0.9, 0.12)), "prop": "tray", "at": (0.3, 1.44, 0.14), "feet": (-0.14, 0.16), "rise": 0.02},
}

#: Poses to swap between.
PAIRS = {
    "clap": ("clap_a", "clap_b"),
    "cheer": ("cheer_a", "cheer_b"),
    "fist": ("fist_a", "fist_b"),
    "wave": ("wave_a", "wave_b"),
    "photo": ("photo_a", "photo_b"),
    "phone": ("phone_a", "phone_b"),
    "sit": ("sit_a", "sit_b"),
    "waiter": ("waiter_a", "waiter_b"),
}


def look(seed):
    """A made-up person."""
    rng = np.random.default_rng(seed * 7919 + 13)
    pick = lambda options: options[int(rng.integers(len(options)))]  # noqa: E731
    woman = bool(rng.integers(2))
    return {
        "skin": pick(SKINS),
        "hair": pick(HAIRS),
        # 0 short, 1 bob, 2 bun, 3 ponytail, 4 cap, 5 sun hat, 6 cropped.
        "style": int(pick([1, 2, 3, 5, 1, 3] if woman else [0, 0, 4, 6, 0, 4])),
        "hat": pick(HATS),
        "top": pick(TOPS),
        "bottom": pick(BOTTOMS),
        "shoes": pick(SHOES),
        # 0 trousers, 1 shorts, 2 skirt.
        "legs": int(pick([0, 1, 2, 2, 1] if woman else [0, 1, 1])),
        "sleeves": bool(rng.integers(3) == 0),
        "shades": bool(rng.integers(3) == 0),
        "height": float(rng.uniform(1.58, 1.74) if woman else rng.uniform(1.68, 1.86)),
        "build": float(rng.uniform(0.9, 1.0) if woman else rng.uniform(0.98, 1.12)),
    }


def _joint(a, b, l1, l2, bend):
    """The elbow or knee between `a` and `b`, bent toward `bend`; and `b` pulled in if it is out of reach."""
    a, b, bend = np.asarray(a, dtype=float), np.asarray(b, dtype=float), np.asarray(bend, dtype=float)
    d = b - a
    dist = np.linalg.norm(d)
    reach = (l1 + l2) * 0.995
    if dist > reach:
        b = a + d / dist * reach
        dist = reach
    along = d / max(dist, 1e-6)
    k = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist)
    h = math.sqrt(max(l1 * l1 - k * k, 0.0))
    perp = bend - along * np.dot(bend, along)
    perp /= max(np.linalg.norm(perp), 1e-6)
    return a + along * k + perp * h, b


def _point(m, p):
    return (m @ np.array([p[0], p[1], p[2], 1.0]))[:3]


def _head(lk):
    """A head on the origin (its middle), facing +z, with its hair or hat."""
    skin, hair = lk["skin"], lk["hair"]
    parts = [lathe([(0.0, -0.165), (0.07, -0.14), (0.105, -0.06), (0.113, 0.03), (0.085, 0.105), (0.0, 0.132)], 8, skin)]
    # The face is longer than the skull is deep.
    parts[0].P[:, 2] = parts[0].P[:, 2] * 0.95 + np.clip(-parts[0].P[:, 1], 0, 1) * 0.12
    style = lk["style"]
    cap = ball(0.124, 7, 4, hair, squash=1.02)
    if style == 6:
        parts.append(ball(0.121, 7, 4, hair, squash=1.0).at(0, 0.03, -0.016))
    else:
        parts.append(cap.at(0, 0.03, -0.022))
    if style == 0:
        # A quiff at the front.
        parts.append(ball(0.06, 5, 3, hair, squash=0.7).at(0.01, 0.125, 0.06))
    if style == 1:
        parts.append(lathe([(0.1, -0.2), (0.135, -0.14), (0.13, 0.0), (0.09, 0.08)], 8, hair, arc=math.pi * 1.25).xf(RY(math.pi * 0.875 + math.pi / 2)))
    if style == 2:
        parts.append(ball(0.062, 6, 3, hair).at(0, 0.15, -0.07))
    if style == 3:
        parts.append(tube([(0, 0.06, -0.12), (0, 0.0, -0.2), (0, -0.2, -0.2)], [0.045, 0.05, 0.02], 5, hair))
    if style == 4:
        hat = lk["hat"]
        parts.append(ball(0.127, 7, 4, hat, squash=0.95).at(0, 0.04, -0.012))
        parts.append(box(0.18, 0.014, 0.15, hat).xf(T(0, 0.045, 0.16) @ RX(0.2)))
    if style == 5:
        hat = 0xEBD9A8
        parts.append(lathe([(0.27, 0.07), (0.13, 0.085), (0.13, 0.085), (0.115, 0.17), (0.0, 0.19)], 10, hat))
        parts.append(lathe([(0.27, 0.07), (0.13, 0.062)], 10, kit.shade(hat, 0.8)).flipped())
        parts.append(lathe([(0.132, 0.088), (0.126, 0.12)], 10, lk["top"]))
    if lk["shades"]:
        parts.append(box(0.19, 0.04, 0.03, INK).at(0, -0.005, 0.098))
    else:
        for x in (-0.042, 0.042):
            parts.append(kit.quad((x - 0.012, -0.027, 0.109), (x + 0.012, -0.027, 0.109), (x + 0.012, 0.003, 0.111), (x - 0.012, 0.003, 0.111), INK))
    return parts


def _prop(name):
    if name == "camera":
        return [
            box(0.15, 0.1, 0.07, INK).at(0, -0.05, -0.035),
            lathe([(0.045, 0.0), (0.05, 0.02), (0.05, 0.09), (0.05, 0.09), (0.036, 0.09)], 8, 0x4A4E58).xf(RX(math.pi / 2)),
            box(0.05, 0.025, 0.05, 0x4A4E58).at(0.03, 0.05, -0.035),
        ]
    if name == "phone":
        return [box(0.075, 0.15, 0.012, INK).at(0, -0.075, 0), box(0.06, 0.12, 0.004, 0x9FD8F0).at(0, -0.06, -0.008)]
    if name == "glass":
        return [lathe([(0.018, 0.0), (0.035, 0.07), (0.035, 0.07), (0.03, 0.07)], 6, 0xF6E2A0)]
    if name == "tray":
        parts = [lathe([(0.0, 0.0), (0.2, 0.0), (0.2, 0.0), (0.21, 0.022), (0.21, 0.022), (0.0, 0.015)], 10, 0xC9CED6)]
        for x, z, c in ((0.07, 0.03, 0xF6E2A0), (-0.06, 0.06, 0xF08A5C), (-0.01, -0.09, 0xF6E2A0)):
            parts.append(lathe([(0.012, 0.015), (0.012, 0.07), (0.035, 0.1), (0.035, 0.15), (0.035, 0.15), (0.0, 0.15)], 6, c).at(x, 0, z))
        return parts
    return []


def figure(lk, pose="stand", only=None, body_of=None):
    """A person in a pose (see POSES): their meshes. `only` keeps the body ("body": legs, trunk and head) or the
    arms ("arms": with the hands and what they hold); `body_of` holds the body as another pose does."""
    p = POSES[pose]
    q = POSES[body_of] if body_of else p
    skin, top, bottom = lk["skin"], lk["top"], lk["bottom"]
    sit = q.get("sit", False)
    rise = q.get("rise", 0.0)
    hx, hy, hz = q.get("hip", (0, 0, 0))
    hip = np.array([hx, (0.5 if sit else HIP) + hy + rise, hz])
    lean = q.get("lean", 0.0) + (0.06 if sit else 0.0)
    body = T(*hip) @ RX(lean)
    wide = lk["build"]
    parts = []

    if only != "arms":
        # The trunk: hips to shoulders, wider than deep.
        profile = [(0.165, -0.04), (0.17, 0.04), (0.17, 0.04), (0.14, 0.2), (0.18, 0.4), (0.205, 0.5), (0.205, 0.5), (0.1, 0.56), (0.1, 0.56), (0.05, NECK + 0.05)]
        colours = [bottom, bottom, top, top, top, top, top, top, skin, skin]
        if lk["legs"] == 2:
            colours[:2] = [top, top]
        trunk = lathe(profile, 7, top, colours=colours)
        trunk.P[:, 0] *= np.where(trunk.P[:, 1] > 0.52, 1.0, wide)
        trunk.P[:, 2] *= np.where(trunk.P[:, 1] > 0.52, 1.0, 0.62)
        parts.append(trunk.xf(body))
        if lk["legs"] == 2:
            skirt = lathe([(0.15, 0.18), (0.18, 0.04), (0.25 if not sit else 0.2, -0.42 if not sit else -0.12)], 7, bottom)
            skirt.P[:, 2] *= 0.75
            if sit:
                skirt.P[:, 2] += np.clip(-skirt.P[:, 1], 0, 1) * 1.6
            parts.append(skirt.xf(T(*hip)))
        tilt, turn = q.get("head", (0.0, 0.0))
        head = body @ T(0, HEAD, 0.012) @ RY(turn) @ RX(tilt - lean * 0.7)
        parts += kit.xf(_head(lk), head)

        # Legs: hip, knee, ankle, and a shoe.
        stride = q.get("feet", (0.0, 0.0))
        for i, side in enumerate((1, -1)):
            top_of_leg = hip + np.array([side * 0.09 * wide, 0, 0])
            if sit:
                ankle = np.array([side * 0.11, 0.09, hip[2] + 0.44])
                bend = (0, 1, 0.4)
            else:
                ankle = np.array([side * 0.105, 0.09 + (0.05 if stride[i] < 0 else 0), hip[2] + stride[i]])
                bend = (0, 0, 1)
            knee, ankle = _joint(top_of_leg, ankle, THIGH, SHIN, bend)
            if lk["legs"] == 0:
                parts.append(tube([top_of_leg, knee, ankle], [0.082, 0.062, 0.05], 5, bottom, caps=False))
            else:
                parts.append(tube([top_of_leg, knee, ankle], [0.074, 0.055, 0.042], 5, skin, caps=False))
                if lk["legs"] == 1:
                    parts.append(tube([top_of_leg, top_of_leg + (knee - top_of_leg) * 0.7], [0.088, 0.08], 5, bottom))
            parts.append(taper(0.1, 0.25, 0.08, 0.15, 0.085, lk["shoes"]).xf(T(ankle[0], 0, ankle[2] + 0.05)))

    if only != "body":
        # Arms: shoulder, elbow, hand.
        bends = p.get("bend", (None, None))
        lift = np.array([0, rise, 0])
        for i, side in enumerate((1, -1)):
            shoulder = _point(body, (side * SHOULDER[0] * wide, SHOULDER[1] - 0.03, 0))
            hand = np.array(p["hands"][i], dtype=float) + lift
            bend = bends[i] if bends[i] is not None else (side * 0.7, -0.5, -0.6)
            elbow, hand = _joint(shoulder, hand, UPPER_ARM, FOREARM, bend)
            parts.append(tube([shoulder, elbow, hand], [0.05, 0.04, 0.034], 5, skin, caps=False))
            if lk["sleeves"]:
                parts.append(tube([shoulder, elbow, elbow + (hand - elbow) * 0.75], [0.058, 0.048, 0.042], 5, top))
            else:
                parts.append(tube([shoulder, shoulder + (elbow - shoulder) * 0.55], [0.06, 0.054], 5, top))
            parts.append(ball(0.046, 5, 3, skin).xf(T(*(hand + (hand - elbow) / FOREARM * 0.03))))
        if "prop" in p:
            parts += kit.xf(_prop(p["prop"]), T(*(np.array(p["at"], dtype=float) + lift)))

    return kit.xf(parts, S(lk["height"] / 1.7))


def pair(lk, name, whole=False):
    """A pair of poses to swap between (see PAIRS): the body as the first holds it and the arms of each, or with
    `whole` both figures entire."""
    a, b = PAIRS[name]
    if whole:
        return figure(lk, a), figure(lk, b)
    return figure(lk, a, "body"), figure(lk, a, "arms"), figure(lk, b, "arms", a)
