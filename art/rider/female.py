"""The female rider's body: an athletic young woman, heroic proportions (see figure.py for how it is built).

Built 1.78 m tall like the male, on nearly the same joint heights: narrower shoulders, a narrow waist over
wider hips, a bust, slimmer limbs, smaller hands and feet.
"""

import math

import numpy as np

from figure import Figure


class Female(Figure):
    name = "female"

    JOINTS = {
        "root": (0, 0, 0),
        "hips": (0, 0.004, 0.965),
        "spine": (0, 0.008, 1.09),
        "chest": (0, 0.012, 1.25),
        "neck": (0, 0.03, 1.47),
        "head": (0, 0.032, 1.575),
        # One side's (the left's; the right mirrors it).
        "clavicle": (0.022, -0.004, 1.445),
        "upperarm": (0.183, 0.02, 1.43),
        "thigh": (0.092, 0.002, 0.93),
        "shin": (0.092, -0.008, 0.505),
        "foot": (0.098, 0.02, 0.082),
        "toes": (0.1, -0.109, 0.02),
    }
    UPPER_ARM = 0.272
    FOREARM = 0.25
    PALM = 0.085

    # Rings from the crotch up: z, half width, front, back, centre y, squareness.
    TORSO = [
        (0.885, 0.168, 0.088, 0.118, 0.006, 2.3),
        (0.955, 0.176, 0.094, 0.122, 0.006, 2.4),
        (1.03, 0.156, 0.088, 0.1, 0.0, 2.5),
        (1.105, 0.124, 0.08, 0.082, 0.0, 2.4),
        (1.185, 0.13, 0.086, 0.084, 0.0, 2.4),
        (1.265, 0.142, 0.096, 0.088, 0.0, 2.5),
        (1.33, 0.158, 0.106, 0.092, 0.004, 2.6),
        (1.392, 0.162, 0.1, 0.092, 0.01, 2.7),
        (1.452, 0.172, 0.072, 0.082, 0.016, 2.8),
        (1.512, 0.122, 0.06, 0.07, 0.026, 2.3),
    ]
    ARMPIT, CHEST_HIGH, SHOULDER = 6, 7, 8
    SHOULDER_RISE = 0.018
    # Where a jacket hangs straight down from.
    CHEST_Z = 1.31
    # Wears the swimsuit: the skin under it gets its own regions.
    SWIMSUIT = True

    # The bust: forward over each breast, less between them, rounder below than above.
    BUST = {4: 0.004, 5: 0.022, 6: 0.04, 7: 0.017}

    def chest(self, k, s, c):
        if k not in self.BUST or c <= 0:
            return 0.0
        return self.BUST[k] * math.exp(-(((abs(s) - 0.38) / 0.34) ** 2)) * c**0.5

    # (distance along the arm from the shoulder joint, top/outer, bottom/inner, front, back), m.
    UPPER = [
        (0.012, 0.074, 0.048, 0.066, 0.064),
        (0.06, 0.066, 0.047, 0.062, 0.06),
        (0.12, 0.052, 0.046, 0.056, 0.054),
        (0.18, 0.045, 0.043, 0.053, 0.05),
        (0.23, 0.037, 0.036, 0.043, 0.042),
    ]
    FORE = [
        (0.0, 0.036, 0.035, 0.04, 0.046),
        (0.04, 0.048, 0.04, 0.052, 0.045),
        (0.095, 0.044, 0.036, 0.047, 0.039),
        (0.16, 0.031, 0.028, 0.036, 0.03),
        (0.223, 0.02, 0.02, 0.03, 0.025),
    ]
    HAND = [
        (0.0, 0.021, 0.021, 0.031, 0.027),
        (0.028, 0.021, 0.025, 0.045, 0.041),
        (0.06, 0.02, 0.022, 0.047, 0.043),
        (0.083, 0.018, 0.018, 0.045, 0.041),
        (0.094, 0.014, 0.014, 0.04, 0.036),
    ]
    # Fingers: across the hand (front to back, m), length (m), radius (m).
    FINGERS = [(0.0275, 0.064, 0.0086), (0.0095, 0.073, 0.009), (-0.0088, 0.069, 0.0086), (-0.0258, 0.056, 0.0079)]
    HAND_SIZE = 0.92
    # How strongly muscle is painted on (skin.anatomy), against the male's.
    MUSCLE = 0.45
    # The arms' girth against the male's (for loose sleeves).
    ARM_GIRTH = 0.86

    # Muscle on the arm rings, by ring: (angle from the top toward the front, width, push in m).
    ARM_BUMPS = {
        2: ((math.pi / 2, 0.55, 0.003),),
        5: ((-math.pi / 2, 0.35, 0.003),),
        6: ((math.pi / 4, 0.6, 0.003),),
    }

    # (distance below the hip joint along the thigh, outer, inner, front, back).
    THIGH = [
        (0.13, 0.098, 0.08, 0.088, 0.092),
        (0.21, 0.088, 0.072, 0.082, 0.08),
        (0.29, 0.074, 0.062, 0.073, 0.066),
        (0.36, 0.058, 0.054, 0.062, 0.054),
    ]
    SHIN = [
        (0.0, 0.046, 0.046, 0.056, 0.046),
        (0.05, 0.045, 0.045, 0.048, 0.052),
        (0.12, 0.053, 0.057, 0.043, 0.074),
        (0.19, 0.049, 0.054, 0.04, 0.069),
        (0.27, 0.037, 0.04, 0.035, 0.045),
        (0.34, 0.029, 0.03, 0.03, 0.031),
        (0.4, 0.03, 0.031, 0.032, 0.029),
    ]
    # The foot's rings from the ankle to the toes, on the male-sized design (see Figure.foot_point).
    FOOT = [
        ((0.104, 0.018, 0.058), (0, -0.35, -0.94), (0.034, 0.034, 0.05, 0.045)),
        ((0.104, -0.02, 0.045), (0, -0.85, -0.5), (0.036, 0.034, 0.04, 0.04)),
        ((0.106, -0.07, 0.038), (0, -1, -0.12), (0.042, 0.037, 0.032, 0.03)),
        ((0.108, -0.125, 0.03), (0, -1, -0.05), (0.046, 0.04, 0.026, 0.022)),
        ((0.108, -0.165, 0.024), (0, -1, 0.0), (0.042, 0.036, 0.02, 0.016)),
    ]
    FOOT_SIZE = 0.92
    CROTCH = (0, 0.008, 0.84)
    # The neck's top ring: centre, half width, front, back, muscle (the four bumps of the neck's cords).
    NECK = ((0, 0.03, 1.53), 0.056, 0.046, 0.054, 0.003)

    # The hairline (see hair.hairline_z): a soft curve at the temples down in front of the ear, no sideburn.
    HAIRLINE = [(0, 1.735), (30, 1.73), (50, 1.715), (62, 1.695), (70, 1.674), (78, 1.668), (88, 1.684), (100, 1.69),
                (116, 1.635), (150, 1.6), (180, 1.594)]

    HEAD_PIVOT = np.array([0.0, 0.03, 1.548])
    HEAD_SCALE = 0.97
    HEAD_WIDEN = 1.07
    LOWER_Z, LOWER_K = 1.625, 0.95


FEMALE = Female()
