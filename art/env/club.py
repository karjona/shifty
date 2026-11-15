"""The country club's terrace: a paved terrace over the sea at the east end of the town quay, a grand stair down to
the landing stage with its signal mast and moored boats, and the clubhouse behind.

Its origin is the middle of the terrace floor; the sea is toward -z, the clubhouse toward +z.
"""

import math

import numpy as np

import kit
import props as P
from kit import RX, RY, RZ, S, T, TAU, box, slab
from scene import Scene

# The terrace: its floor is y = 0.
WEST, EAST, FRONT, BACK = -15.0, 15.0, -10.0, 5.0
# The landing stage below, on the quay's level.
STAGE = -3.0
# The stair down to it.
STAIR_WEST, STAIR_EAST = 0.4, 6.4
STEPS = 18
RUN = 0.3
# The signal mast's height.
MAST = 7.3
# Where flags fly (x, z).
WIND = (0.94, -0.34)
WIND_YAW = math.atan2(-WIND[1], WIND[0])


def terrace(sc):
    outline = [(WEST, FRONT), (EAST, FRONT), (EAST, BACK + 9.5), (WEST, BACK + 9.5)]
    sc.add(kit.plate(outline, 0.0, 0xE9DCC2, "paving"))
    sc.add(slab(outline, -8.2, 0.0, P.STONE_DARK, bottom=False, lid=False))
    # A band of stone round the floor's edge, a finger proud of the paving.
    kerb = [(-0.34, 0.0), (-0.34, 0.025), (0.02, 0.025), (0.06, -0.02), (0.06, -0.14), (0.02, -0.18)]
    path = [(WEST, 0, BACK), (WEST, 0, FRONT), (EAST, 0, FRONT), (EAST, 0, BACK)]
    sc.add(kit.extrude(kerb[::-1], [np.array(p, dtype=float) for p in path], P.STONE_LIGHT))
    # A string course and a batter along the sea wall.
    sc.add(box(EAST - WEST + 0.3, 0.3, 0.2, P.STONE).at(0, -1.2, FRONT - 0.08))

    # The stair to the landing stage, between two piers.
    rise = -STAGE / STEPS
    width = STAIR_EAST - STAIR_WEST
    cx = (STAIR_WEST + STAIR_EAST) / 2
    for i in range(STEPS):
        top = -(i + 1) * rise
        sc.add(box(width, top - STAGE + 0.02, RUN, P.STONE).at(cx, STAGE - 0.02, FRONT - (i + 0.5) * RUN))
        sc.add(box(width + 0.02, 0.035, RUN + 0.03, P.STONE_LIGHT).at(cx, top - 0.035, FRONT - (i + 0.5) * RUN - 0.015))
    for x in (STAIR_WEST - 0.3, STAIR_EAST + 0.3):
        # Cheek walls stepping down beside the stair.
        for k in range(3):
            y = -(k + 1) * 1.0
            sc.add(box(0.5, y - STAGE + 1.0, STEPS * RUN / 3, P.STONE).at(x, STAGE, FRONT - (k + 0.5) * STEPS * RUN / 3))
            sc.add(box(0.58, 0.07, STEPS * RUN / 3 + 0.06, P.STONE_LIGHT).at(x, y + 1.0, FRONT - (k + 0.5) * STEPS * RUN / 3))
    sc.define("baluster", P.baluster())
    sc.define("pier.ball", P.pier("ball"))
    sc.define("pier.lantern", P.pier("lantern"))
    sc.place("pier.lantern", T(STAIR_WEST - 0.3, 0, FRONT + 0.02))
    sc.place("pier.lantern", T(STAIR_EAST + 0.3, 0, FRONT + 0.02))
    P.balustrade(sc, (WEST + 0.3, FRONT + 0.02), (STAIR_WEST - 0.56, FRONT + 0.02))
    P.balustrade(sc, (STAIR_EAST + 0.56, FRONT + 0.02), (EAST - 0.3, FRONT + 0.02))
    for x in (WEST, EAST):
        sc.place("pier.ball", T(x, 0, FRONT + 0.02))
        P.balustrade(sc, (x, FRONT + 0.3), (x, BACK - 0.3))
        sc.place("pier.ball", T(x, 0, BACK))


def landing(sc):
    """The landing stage at the stair's foot: a stone quay with the signal mast, palms and a jetty with boats."""
    outline = [(-9.0, -19.0), (13.0, -19.0), (13.0, FRONT), (-9.0, FRONT)]
    sc.add(slab(outline, -8.2, STAGE, P.STONE_DARK, top=P.STONE, bottom=False))
    sc.add(kit.xf(P.mast(MAST), T(4.3, STAGE, -12.6) @ RY(WIND_YAW)))
    # Bunting from the masthead up to the clubhouse.
    colours = P.SEASONS + [P.WHITE]
    sc.add(P.bunting((4.3, STAGE + MAST, -12.6), (-6.0, 8.6, BACK + 0.5), 1.2, 30, colours))
    sc.add(P.bunting((4.3, STAGE + MAST, -12.6), (12.0, 8.6, BACK + 0.5), 1.2, 30, colours))
    sc.define("palm.a", P.palm(7.2, 0.7, 3))
    sc.define("palm.b", P.palm(6.4, -0.5, 8))
    sc.place("palm.a", T(-4.6, STAGE, -13.6) @ RY(0.4))
    sc.place("palm.b", T(10.6, STAGE, -13.2) @ RY(2.1))
    # The jetty.
    sc.add(box(1.8, 0.16, 13.0, P.WOOD_PALE).at(2.4, -4.5, -25.5))
    for z in np.arange(-31.5, -19.0, 2.4):
        for x in (1.55, 3.25):
            sc.add(kit.rod((x, -8.0, z), (x, -4.1, z), 0.11, 6, P.WOOD_DARK))
    sc.anim("boat", P.sailboat(6.0, 7.6), T(0.4, -5.2, -22.5) @ RY(math.pi / 2))
    sc.anim("boat", P.sailboat(5.2, 6.6, 0xF2E8D0, 0x2F7D5B, flag=0x2B3FD0), T(4.6, -5.2, -27.5) @ RY(-math.pi / 2))
    for i, (x, z) in enumerate(((-150.0, -330.0), (60.0, -420.0), (210.0, -290.0))):
        sc.anim("sail", P.far_sail(9.0 + i), T(x, -5.2, z))


def build():
    sc = Scene()
    sc.anchor("wind", T(), dir=list(WIND))
    terrace(sc)
    landing(sc)
    return sc
