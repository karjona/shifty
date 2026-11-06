"""The male rider's body: an athletic young man, heroic proportions (see figure.py for how it is built)."""

import math

import numpy as np

from figure import Figure


class Male(Figure):
    name = "male"

    JOINTS = {
        "root": (0, 0, 0),
        "hips": (0, 0.0, 0.965),
        "spine": (0, 0.005, 1.085),
        "chest": (0, 0.012, 1.245),
        "neck": (0, 0.03, 1.47),
        "head": (0, 0.03, 1.575),
        # One side's (the left's; the right mirrors it).
        "clavicle": (0.025, -0.005, 1.445),
        "upperarm": (0.205, 0.022, 1.438),
        "thigh": (0.09, 0.0, 0.93),
        "shin": (0.098, -0.01, 0.505),
        "foot": (0.102, 0.022, 0.088),
        "toes": (0.106, -0.118, 0.022),
    }
    UPPER_ARM = 0.285
    FOREARM = 0.262
    PALM = 0.092

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
    SHOULDER_RISE = 0.022
    # Where a jacket hangs straight down from.
    CHEST_Z = 1.25

    def chest(self, k, s, c):
        # Pecs: forward and a touch down at their lower edge.
        if k in (5, 6, 7) and c > 0.3:
            return {5: 0.004, 6: 0.008, 7: 0.004}[k] * (1 - abs(abs(s) - 0.45) * 1.6)
        return 0.0

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
    HAND_SIZE = 1.0
    # How strongly muscle is painted on (skin.anatomy).
    MUSCLE = 1.0
    # The arms' girth against the male's (for loose sleeves).
    ARM_GIRTH = 1.0

    # Muscle on the arm rings, by ring: (angle from the top toward the front, width, push in m).
    ARM_BUMPS = {
        2: ((math.pi / 2, 0.55, 0.007), (-math.pi / 2, 0.6, 0.004)),
        3: ((math.pi / 2, 0.55, 0.006), (-math.pi / 2, 0.6, 0.005)),
        5: ((-math.pi / 2, 0.35, 0.006),),
        6: ((math.pi / 4, 0.6, 0.006), (-math.pi * 0.6, 0.5, 0.002)),
        7: ((math.pi / 4, 0.6, 0.004),),
    }

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
    # The foot's rings from the ankle to the toes (the left foot): centre, axis, (outer, inner, top, bottom).
    FOOT = [
        ((0.104, 0.018, 0.058), (0, -0.35, -0.94), (0.034, 0.034, 0.05, 0.045)),
        ((0.104, -0.02, 0.045), (0, -0.85, -0.5), (0.036, 0.034, 0.04, 0.04)),
        ((0.106, -0.07, 0.038), (0, -1, -0.12), (0.042, 0.037, 0.032, 0.03)),
        ((0.108, -0.125, 0.03), (0, -1, -0.05), (0.046, 0.04, 0.026, 0.022)),
        ((0.108, -0.165, 0.024), (0, -1, 0.0), (0.042, 0.036, 0.02, 0.016)),
    ]
    FOOT_SIZE = 1.0
    CROTCH = (0, 0.006, 0.84)
    # The neck's top ring: centre, half width, front, back, muscle (the four bumps of the neck's cords).
    NECK = ((0, 0.026, 1.53), 0.072, 0.056, 0.064, 0.006)

    # The hairline (see hair.hairline_z): over the forehead, a sideburn in front of the ear, over and behind it.
    HAIRLINE = [(0, 1.737), (30, 1.733), (50, 1.722), (62, 1.7), (68, 1.652), (74, 1.652), (80, 1.69), (100, 1.692),
                (116, 1.632), (150, 1.6), (180, 1.596)]

    HEAD_PIVOT = np.array([0.0, 0.03, 1.548])
    HEAD_SCALE = 0.97
    # Broader than life: wider than it is deep or tall.
    HEAD_WIDEN = 1.07
    # Below the nose, a little shorter.
    LOWER_Z, LOWER_K = 1.625, 0.95


MALE = Male()
