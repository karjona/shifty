"""The country club, on the lot the town leaves it at the east end of the quay: a paved terrace over the promenade, a
grand stair down to it, the signal mast, palms and a jetty with moored boats in front, and the clubhouse behind.
Small props, interiors and people are only drawn from close by (the mode select); from afar a plain parapet stands
in for the balusters.

Its origin is the middle of the terrace floor; the sea is toward -z, the clubhouse toward +z.
"""

import math

import numpy as np

import furniture as F
import house as H
import kit
import people
import props as P
from kit import RX, RY, RZ, S, T, TAU, box, slab
from scene import FAR, NEAR, Scene

# The terrace: its floor is y = 0.
WEST, EAST, FRONT, BACK = -15.0, 15.0, -10.0, 5.0
# The quay's promenade below.
STAGE = -3.0
# The stair down to it.
STAIR_WEST, STAIR_EAST = 0.55, 6.55
STEPS = 18
RUN = 0.3
# The scene's own geometry is stored in squares of ground this size: the client draws the club in two parts, what
# stands on the sea side of z = 0 and the rest (see render/club.ts), so the squares must not straddle that line.
CELL = 12.0
# The signal mast on the promenade, past the stair's foot: its height, and where it stands.
MAST = 9.6
MAST_X = 4.4
MAST_Z = -17.2
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
    """In front of the terrace, on the promenade: the signal mast, palms, and a jetty with boats at their moorings."""
    sc.add(kit.xf(P.mast(MAST, scale=1.3), T(MAST_X, STAGE, MAST_Z) @ RY(WIND_YAW)))
    # Bunting from the masthead up to the clubhouse.
    colours = P.SEASONS + [P.WHITE]
    sc.add(P.bunting((MAST_X, STAGE + MAST, MAST_Z), (-7.0, 8.9, BACK + 0.5), 1.4, 36, colours))
    sc.add(P.bunting((MAST_X, STAGE + MAST, MAST_Z), (12.0, 8.9, BACK + 0.5), 1.4, 36, colours))
    sc.define("palm.a", P.palm(sc, 7.2, 0.7, 3))
    sc.define("palm.b", P.palm(sc, 6.4, -0.5, 8))
    sc.place("palm.a", T(-3.6, STAGE, -14.6) @ RY(0.4))
    sc.place("palm.b", T(9.6, STAGE, -11.6) @ RY(2.1))
    sc.place("palm.b", T(-12.5, STAGE, -12.8) @ RY(4.0))
    # The forecourt: lamp posts, benches and bollards along the quay's rim, west of the stair's foot.
    sc.define("lamp-post", P.lamp_post())
    sc.define("bench", P.bench())
    sc.define("bollard", P.bollard())
    # (The quay's east end is round: its middle and radius, from the terrace's.)
    cx, cz, rim = -33.0, 26.0, 60.0
    for k, deg in enumerate((-73, -67, -61, -55)):
        a = math.radians(deg)
        out = np.array([math.cos(a), math.sin(a)])
        facing = math.atan2(out[0], out[1])
        post = np.array([cx, cz]) + out * (rim - 0.7)
        sc.place("bollard", T(post[0], STAGE, post[1]))
        if k % 2 == 0:
            lamp = np.array([cx, cz]) + out * (rim - 3.2)
            sc.place("lamp-post", T(lamp[0], STAGE, lamp[1]) @ RY(facing + math.pi / 2))
        else:
            seat = np.array([cx, cz]) + out * (rim - 3.4)
            sc.place("bench", T(seat[0], STAGE, seat[1]) @ RY(facing))
    for x, z in ((17.4, 3.5), (18.6, 9.5)):
        sc.place("lamp-post", T(x, STAGE if z < 4 else 0.0, z))
    # A jetty off the quay's edge, steps down to it, and boats rocking at their moorings. The sim has them too
    # (sim::course, the bay's jetty and its sailboats): riders bump into what they see.
    sc.add(box(1.8, 0.16, 12.0, P.WOOD_PALE).at(-1.5, -4.0, -29.8))
    for k in range(3):
        sc.add(box(1.8, 0.2, 0.4, P.STONE).at(-1.5, -3.4 - 0.2 * k, -23.2 - 0.4 * k))
    for z in np.arange(-35.5, -23.5, 2.4):
        for x in (-2.35, -0.65):
            sc.add(kit.rod((x, -8.0, z), (x, -3.6, z), 0.11, 6, P.WOOD_DARK))
    moored = (
        (P.sailboat(6.0, 7.6), T(0.6, -5.2, -27.5) @ RY(math.pi / 2)),
        (P.sailboat(5.2, 6.6, 0xF2E8D0, 0x2F7D5B, flag=0x2B3FD0), T(-3.6, -5.2, -32.0) @ RY(-math.pi / 2)),
    )
    for boat, m in moored:
        sc.anim("boat", boat, m)


def clubhouse(sc):
    """The clubhouse along the back of the terrace, facing the sea."""
    H.define(sc)
    m = T(0, 0, BACK) @ RY(math.pi)
    parts, placed, signs, inner, inner_placed = H.clubhouse()
    sc.add(parts, m)
    sc.add(inner, m, NEAR)
    for name, local in placed:
        sc.place(name, m @ local)
    for name, local in inner_placed:
        sc.place(name, m @ local, NEAR)
    for text, local, w, h, style, ink, paper in signs:
        sc.anchor("sign", m @ local, text=text, w=w, h=h, style=style, ink=ink, paper=paper)
    # In the pro shop's window: boards standing on show, life vests on a rail, a poster.
    boards = [
        {"colours": (0x1F5FA8, 0xF7F1E5, 0xE8A72C), "length": 1.5},
        {"colours": (0xE8A72C, 0x23252B, 0xF7F1E5), "length": 1.62, "shape": "swallow"},
        {"colours": (0xD9482E, 0xF7F1E5, 0x23252B), "length": 1.56},
    ]
    for i, b in enumerate(boards):
        stand = T(-12.05 + 0.55 * i, 0.76, -1.0) @ RX(-0.1) @ T(0, b["length"] / 2, 0) @ RZ(math.pi / 2) @ RX(math.pi / 2)
        sc.add(F.snowboard(b["colours"], b["length"], b.get("shape", "twin")), m @ stand, NEAR)
    sc.add(kit.rod((-10.5, 1.95, -0.85), (-9.3, 1.95, -0.85), 0.015, 4, P.IRON), m, NEAR)
    for x, colours in ((-10.2, (0xD9482E, 0x23252B, 0xF7F1E5)), (-9.65, (0xE8A72C, 0x1F5FA8, 0xF7F1E5))):
        sc.add(F.vest(*colours), m @ T(x, 1.93, -0.85), NEAR)
    sc.add(F.poster(), m @ T(-9.9, 2.36, -1.085), NEAR)
    sc.anchor("sign", m @ T(-9.9, 2.13, -1.07), text="THE TILT", w=0.62, h=0.13, style="display", ink=P.STUCCO, paper=None)
    # The brands on the awnings' fronts.
    sc.anchor("sign", m @ T(-10.8, 2.43, 1.56), text="Garbí", w=1.1, h=0.22, style="brand", ink=P.STUCCO, paper=P.BRANDS["Garbí"][0])
    sc.anchor("sign", m @ T(10.25, 2.43, 1.76), text="Xaloc", w=1.1, h=0.22, style="brand", ink=P.STUCCO, paper=P.BRANDS["Xaloc"][0])
    # Outside the shop: a rack of boards, and a trailer (the client parks a jetski on it: the `ride` anchor).
    rack = [
        {"colours": (0x2F7D5B, 0xF7F1E5, 0xE8A72C), "length": 1.54},
        {"colours": (0xF7F1E5, 0x1E9BB0, 0xD9482E), "length": 1.5},
        {"colours": (0x23252B, 0xD9482E, 0xF7F1E5), "length": 1.6, "shape": "swallow"},
        {"colours": (0x1E9BB0, 0xF7F1E5, 0x1F5FA8), "length": 1.48},
    ]
    sc.add(F.board_rack(rack), T(9.1, 0, 2.5) @ RY(math.pi - 0.3), NEAR)
    ski = T(12.9, 0, 0.6) @ RY(math.pi / 2)
    sc.add(F.trailer(), ski, NEAR)
    sc.anchor("ride", ski @ T(-0.25, 0.47, 0))
    # Trees in pots along the loggia.
    sc.define("pot", P.pot())
    sc.define("pot.big", P.pot(0.55, 0.78))
    sc.define("olive", F.olive_tree(sc, 2.5, 4))
    sc.define("lemon", F.lemon_tree(sc, 1.9, 2))
    sc.define("fan-palm", F.fan_palm(1.15, 5))
    for x, tree, turn in ((-1.5, "olive", 0.3), (1.5, "olive", 2.4), (-4.5, "lemon", 0.0), (4.5, "lemon", 1.7)):
        sc.place("pot.big" if tree == "olive" else "pot", T(x, 0, 4.25))
        sc.place(tree, T(x, 0.72 if tree == "olive" else 0.57, 4.25) @ RY(turn))


def west(sc):
    """The café under the pergola, by the bar."""
    x0, x1, z0, z1 = -14.0, -6.0, -4.2, 3.0
    sc.add(H.pergola(x0, x1, z0, z1))
    top = 3.3
    # Bougainvillea climbing the corner columns and massed along the beams.
    for x, z in ((x0, z0), (x1, z0)):
        sc.add(kit.tube([(x + 0.2, 0.2, z - 0.22), (x + 0.24, 1.5, z - 0.24), (x + 0.1, 2.9, z - 0.1)], [0.05, 0.04, 0.03], 5, 0x7A5A3C))
    south = [(x, top + 0.1, z0 + 0.1) for x in np.arange(x0 - 0.3, x1 + 0.6, 0.85)]
    east = [(x1 + 0.1, top + 0.1, z) for z in np.arange(z0 + 0.8, z1 - 1.5, 0.9)]
    patches = [(-12.6, top + 0.2, -1.5), (-9.2, top + 0.15, -2.6), (-11.0, top + 0.15, 0.6), (-7.6, top + 0.15, -0.4)]
    for level, detail in ((NEAR, 2), (FAR, 1)):
        sc.add(H.bougainvillea(sc, south, 0.5, 1, hang=1.0, detail=detail), None, level)
        sc.add(H.bougainvillea(sc, east, 0.45, 2, hang=0.8, detail=detail), None, level)
        sc.add(H.bougainvillea(sc, patches, 0.6, 3, detail=detail), None, level)
    sc.place("pot.big", T(-14.2, 0, -8.9))
    sc.place("olive", T(-14.2, 0.72, -8.9) @ RY(1.0))
    sc.level = NEAR
    # Tables and chairs.
    sc.define("table", F.cafe_table() + kit.xf(F.table_setting(1), T(0, 0.75, 0)))
    sc.define("chair.navy", F.bistro_chair(P.NAVY))
    sc.define("chair.red", F.bistro_chair(0xC8402E))
    for i, (x, z, seats) in enumerate(((-12.2, -2.4, 3), (-8.4, -2.0, 2), (-12.0, 1.0, 2), (-8.3, 1.3, 3))):
        sc.place("table", T(x, 0, z) @ RY(i * 1.3))
        for k in range(seats):
            a = i * 0.9 + k * TAU / seats + 0.4
            sc.place("chair.navy" if (i + k) % 2 else "chair.red", T(x + math.sin(a) * 0.72, 0, z + math.cos(a) * 0.72) @ RY(a + math.pi))
    # Lamps strung under the rafters, a fan turning.
    sc.define("lamp", P.lamp())
    for z in (-2.6, -0.4, 1.8):
        sc.add(P.string_lights((x0, 2.86, z), (x1, 2.86, z), 0.32, 12))
    still, blades = F.ceiling_fan()
    sc.add(still, T(-10.0, 2.9, -0.6))
    sc.anim("fan", blades, T(-10.0, 2.9, -0.6))
    # Stools at the bar.
    sc.define("stool", F.bar_stool())
    for x in (-11.8, -10.8, -9.8, -8.8):
        sc.place("stool", T(x, 0, 4.25))
    sc.anim("cat", F.cat(), T(-15.0, P.RAIL_TOP, -6.4) @ RY(-0.5))
    sc.level = 0


def parasol(sc, name, brand, x, z, turn=0.0):
    """A parasol of a brand, with its name on two of the valance's flaps."""
    main, second = P.BRANDS[brand]
    if name not in sc.defs:
        sc.define(name, F.parasol(main, second))
    sc.place(name, T(x, 0, z) @ RY(turn))
    for flap in (0, 4):
        a = TAU * (flap + 0.5) / 8 - turn
        r = 1.55 * math.cos(TAU / 16) * 1.012
        at = T(x + math.cos(a) * r, 2.55 - 0.42 - 0.085, z + math.sin(a) * r) @ RY(math.pi / 2 - a)
        sc.anchor("sign", at, text=brand, w=0.8, h=0.13, style="brand", ink=main, paper=None)


def east(sc):
    """Sun loungers and parasols by the pro shop."""
    sc.define("lounger.a", F.lounger(stripe=0x1E9BB0, towel=0xE8A72C))
    sc.define("lounger.b", F.lounger(stripe=0x1E9BB0))
    sc.place("lounger.a", T(10.3, 0, -6.6) @ RY(math.pi + 0.12))
    sc.place("lounger.b", T(12.5, 0, -6.8) @ RY(math.pi - 0.1))
    parasol(sc, "parasol.1", "Garbí", 11.4, -5.6, 0.2)
    parasol(sc, "parasol.2", "Llevant", 8.75, -2.3, 0.5)
    sc.place("pot", T(14.1, 0, -8.9))
    sc.place("fan-palm", T(14.1, 0.57, -8.9))
    sc.place("pot", T(14.1, 0, 4.0))
    sc.place("fan-palm", T(14.1, 0.57, 4.0) @ RY(2.0))
    sc.level = NEAR
    sc.place("table", T(8.6, 0, -2.2))
    sc.place("chair.navy", T(8.6, 0, -1.45) @ RY(math.pi))
    sc.place("chair.red", T(9.3, 0, -2.5) @ RY(-1.9))
    # A gull on the lantern at the head of the stair.
    sc.anim("gull", F.gull(), T(STAIR_WEST - 0.3, 1.23 + 0.825, FRONT + 0.02) @ RY(0.25))
    sc.level = 0


def folk(sc):
    """The club's members and staff: two at a table under the pergola (one lifts a glass now and then), one
    leaning on the balustrade, one sitting at the head of the stair looking out to sea, and a waiter going between
    the bar and the tables."""
    sc.level = NEAR
    seated = (
        (T(-8.3, 0, 1.3 + 0.72) @ RY(math.pi), 11, True),
        (T(-8.3 + 0.72, 0, 1.3) @ RY(-math.pi / 2), 4, False),
        # On the top step: the floor is the seat, the feet two steps down.
        (T(6.05, -0.46, FRONT + 0.22) @ RY(math.pi), 9, True),
    )
    for k, (m, seed, lively) in enumerate(seated):
        body, a, b = people.pair(people.look(seed), "sit")
        sc.add(body, m)
        if lively:
            sc.anim(f"sit{k}.a", a, m)
            sc.anim(f"sit{k}.b", b, m)
        else:
            sc.add(a, m)
    sc.add(people.figure(people.look(6), "lean"), T(-11.0, 0, FRONT + 0.42) @ RY(math.pi))
    # The waiter walks from the bar to a table and back (the anchor is where he turns round).
    a, b = people.pair(people.look(2), "waiter", whole=True)
    start = T(-10.2, 0, 3.4)
    sc.anim("waiter.a", a, start)
    sc.anim("waiter.b", b, start)
    sc.anchor("waiter", T(-9.3, 0, -0.9))
    sc.level = 0


def build():
    sc = Scene(cell=CELL)
    sc.anchor("wind", T(), dir=list(WIND))
    terrace(sc)
    landing(sc)
    clubhouse(sc)
    west(sc)
    east(sc)
    folk(sc)
    return sc
