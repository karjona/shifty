"""Painting the rides from their baked maps: each model's livery (where its main, second and accent colours go),
the brands' wordmarks, panel lines, traction mats, rubber, metal and glass, and how glossy each is.

As for the riders' garments (art/rider/paint.py), the detail map holds a tint factor where the mask is set (0.5 is
the colour itself; much darker paint draws as a mark, a line) and a plain colour elsewhere; the mask says how much
of each colour (RGB: main, second, accent) and, in its alpha, how glossy the surface is. So one painted texture
serves every colourway of a model.
"""

import math
import os

import bpy
import numpy as np

import board
import jetski
from paint import fbm, smoothstep
from shapes import lerp, to_game
from skin import blur

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FONTS = os.path.join(ROOT, "node_modules", "@fontsource-variable", "archivo", "files")
# Archivo (the game's typeface, SIL OFL): its italic for the sporty marks, upright for the rest.
ITALIC = "archivo-latin-wdth-italic.woff2"
UPRIGHT = "archivo-latin-wdth-normal.woff2"

MAIN, SECOND, ACCENT = 0, 1, 2

# Plain paint (untinted greys) and how glossy it is.
RUBBER = (0.16, 0.05)
MAT = (0.24, 0.0)
METAL = (0.6, 0.75)
DARK_METAL = (0.3, 0.6)
SMOKE = (0.1, 1.0)
WHITE = (0.82, 1.0)
INK = (0.08, 1.0)


def font(name):
    path = os.path.join(FONTS, name)
    if not os.path.exists(path):
        # (pnpm keeps packages in its store; the workspace links them.)
        store = os.path.join(ROOT, "node_modules", ".pnpm")
        for d in sorted(os.listdir(store)) if os.path.isdir(store) else []:
            if d.startswith("@fontsource-variable+archivo@"):
                path = os.path.join(store, d, "node_modules", "@fontsource-variable", "archivo", "files", name)
    return bpy.data.fonts.load(path, check_existing=True)


def text(body, face=ITALIC, px=110, bold=0.0, spacing=1.0, ss=3):
    """A wordmark as coverage (rows from the top), rasterized from the font's outlines, and its width/height."""
    cu = bpy.data.curves.new("mark", "FONT")
    cu.body = body
    cu.font = font(face)
    cu.offset = bold
    cu.space_character = spacing
    ob = bpy.data.objects.new("mark", cu)
    bpy.context.scene.collection.objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    me = ob.evaluated_get(dg).to_mesh()
    me.calc_loop_triangles()
    co = np.array([v.co[:2] for v in me.vertices])
    tris = np.array([t.vertices[:] for t in me.loop_triangles])
    ob.evaluated_get(dg).to_mesh_clear()
    bpy.data.objects.remove(ob)
    bpy.data.curves.remove(cu)
    lo, hi = co.min(axis=0), co.max(axis=0)
    pad = 0.08
    k = px * ss
    w = int(math.ceil((hi[0] - lo[0] + 2 * pad) * k))
    h = int(math.ceil((hi[1] - lo[1] + 2 * pad) * k))
    pts = np.stack([(co[:, 0] - lo[0] + pad) * k, (hi[1] + pad - co[:, 1]) * k], axis=1)
    img = np.zeros((h, w), dtype=bool)
    for a, b, c in pts[tris]:
        x0, y0 = np.floor(np.minimum(np.minimum(a, b), c)).astype(int)
        x1, y1 = np.ceil(np.maximum(np.maximum(a, b), c)).astype(int)
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)

        def edge(p, q):
            return (q[0] - p[0]) * (ys - p[1]) - (q[1] - p[1]) * (xs - p[0])

        e0, e1, e2 = edge(a, b), edge(b, c), edge(c, a)
        inside = ((e0 >= 0) & (e1 >= 0) & (e2 >= 0)) | ((e0 <= 0) & (e1 <= 0) & (e2 <= 0))
        img[y0:y1 + 1, x0:x1 + 1] |= inside
    cov = img.reshape(h // ss, ss, w // ss, ss).mean(axis=(1, 3)) if h % ss == 0 and w % ss == 0 else \
        img[: h - h % ss, : w - w % ss].reshape(h // ss, ss, w // ss, ss).mean(axis=(1, 3))
    return cov, cov.shape[1] / cov.shape[0]


def grow(cov, r):
    """Coverage grown by `r` texels (a disc), for a sticker's outline."""
    out = cov.copy()
    r = int(round(r))
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dx * dx + dy * dy <= r * r:
                out = np.maximum(out, np.roll(np.roll(cov, dy, axis=0), dx, axis=1))
    return out


def sample(img, u, v):
    """Bilinear lookup of `img` at u across, v up (0-1); 0 outside."""
    h, w = img.shape
    x = u * w - 0.5
    y = (1 - v) * h - 0.5
    ok = (u >= 0) & (u <= 1) & (v >= 0) & (v <= 1)
    x0 = np.clip(np.floor(x).astype(int), 0, w - 1)
    y0 = np.clip(np.floor(y).astype(int), 0, h - 1)
    x1, y1 = np.clip(x0 + 1, 0, w - 1), np.clip(y0 + 1, 0, h - 1)
    fx, fy = np.clip(x - x0, 0, 1), np.clip(y - y0, 0, 1)
    out = (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x1] * fx * (1 - fy) + img[y1, x0] * (1 - fx) * fy
           + img[y1, x1] * fx * fy)
    return np.where(ok, out, 0.0)


class Canvas:
    """The texture being painted: the baked maps in the game's frame, and the detail and mask so far."""

    def __init__(self, maps):
        self.inside = maps["inside"]
        self.P = to_game(maps["pos"])
        self.N = to_game(maps["nrm"])
        self.part = maps.get("part", np.zeros(self.inside.shape, dtype=np.int32))
        ao = np.clip(blur(maps["ao"], self.inside, 2), 0, 1)
        # The occlusion only: a hard surface takes its light from the game's sun, the paint only darkens what is
        # tucked away (under the seat, round the console, in the footwells).
        self.s = 0.45 + 0.55 * ao
        h, w = self.inside.shape
        self.detail = 0.5 * self.s
        self.mask = np.zeros((h, w, 4))
        self.mask[..., MAIN] = 1
        self.mask[..., 3] = 0.5

    def put(self, area, tint=None, plain=None, gloss=None):
        """Paints `area` (coverage, 0-1) in a colour of the colourway (`tint`) or a plain grey ((value, gloss))."""
        a = np.clip(area, 0, 1)
        if tint is not None:
            col = np.zeros(3)
            col[tint] = 1
            self.mask[..., :3] = self.mask[..., :3] * (1 - a[..., None]) + col * a[..., None]
            self.detail = self.detail * (1 - a) + 0.5 * self.s * a
        if plain is not None:
            value, g = plain
            self.mask[..., :3] *= 1 - a[..., None]
            self.detail = self.detail * (1 - a) + value * (0.6 + 0.4 * self.s).clip(0.4, 1.1) * a
            gloss = g if gloss is None else gloss
        if gloss is not None:
            self.mask[..., 3] = self.mask[..., 3] * (1 - a) + gloss * a

    def line(self, cov, depth=0.7):
        """A dark stroke (a panel line, a seam): the game draws it as a mark."""
        self.detail = self.detail * (1 - depth * np.clip(cov, 0, 1))

    def stroke(self, dist, width=0.003, depth=0.7):
        self.line(smoothstep(width, width * 0.4, np.abs(dist)), depth)

    def decal(self, cov, origin, u_axis, v_axis, width, facing, min_dot=0.35, aspect=None, where=None):
        """`cov` (a wordmark's coverage) laid on the surface: `width` metres along `u_axis` from `origin`, up
        `v_axis`, on texels whose normal faces `facing`. Returns the coverage per texel."""
        aspect = aspect or cov.shape[1] / cov.shape[0]
        height = width / aspect
        d = self.P - np.asarray(origin)
        u = d @ np.asarray(u_axis, dtype=np.float64) / width
        v = d @ np.asarray(v_axis, dtype=np.float64) / height + 0.5
        ok = (self.N @ np.asarray(facing, dtype=np.float64)) > min_dot
        if where is not None:
            ok &= where
        return np.where(ok & self.inside, sample(cov, u, v), 0.0)

    def mark(self, body, origin, u_axis, v_axis, width, facing, tint=ACCENT, outline=None, face=ITALIC,
             plain=None, where=None, min_dot=0.35):
        """A wordmark sticker: the letters in `tint` (or `plain`), with an outline in `outline` (a tint index or
        a plain grey) round them."""
        cov, aspect = text(body, face)
        if outline is not None:
            ring = grow(cov, cov.shape[0] * 0.07)
            c = self.decal(ring, origin, u_axis, v_axis, width, facing, min_dot, aspect, where)
            if isinstance(outline, tuple):
                self.put(c, plain=outline)
            else:
                self.put(c, tint=outline)
        c = self.decal(cov, origin, u_axis, v_axis, width, facing, min_dot, aspect, where)
        self.put(c, tint=tint if plain is None else None, plain=plain)
        return c

    def done(self):
        return np.clip(self.detail, 0, 1), np.clip(self.mask, 0, 1)


def both_sides(c, body, z0, y0, width, tint=ACCENT, outline=None, face=ITALIC, plain=None, where=None, lean=0.0):
    """A wordmark on each side of a ski, reading the right way from outside: at `z0` (its start toward the bow)
    and `y0` (its middle), leaning by `lean` (rad)."""
    for side in (1, -1):
        # Seen from outside the +x side, right is toward the stern.
        u = np.array([0.0, math.sin(lean), -side * math.cos(lean)])
        v = np.array([0.0, math.cos(lean), side * math.sin(lean)])
        start = z0 if side > 0 else z0 - width
        c.mark(body, (0.0, y0, start), u, v, width, (side, 0, 0), tint, outline, face, plain, where, min_dot=0.3)


# ---------------------------------------------------------------- jetskis

BRANDS = {"summer.ride.runabout": "GARBÍ", "summer.ride.racer": "XALOC", "summer.ride.cruiser": "PONENT",
          "winter.ride.freestyle": "TRAMUNTANA", "winter.ride.freeride": "LLEVANT", "winter.ride.carver": "XALOC"}


def paint_jetski(model, maps):
    s = jetski.SKIS[model]
    L = jetski.Lines(s)
    c = Canvas(maps)
    P, N, part = c.P, c.N, c.part
    x, y, z = P[..., 0], P[..., 1], P[..., 2]
    ax = np.abs(x)
    ny = N[..., 1]
    zs = np.clip(z, s.stern, s.bow)
    rail = np.interp(zs, *_line(L, L.rail))
    chine = np.interp(zs, *_line(L, lambda q: L.chine(q)[1]))
    beam = np.interp(zs, *_line(L, L.beam))
    centre = np.interp(zs, *_line(L, L.centre))
    is_ = {k: part == v for k, v in (("hull", jetski.HULL), ("deck", jetski.DECK), ("bumper", jetski.BUMPER),
                                      ("seat", jetski.SEAT), ("pole", jetski.POLE), ("bar", jetski.BAR),
                                      ("grips", jetski.GRIPS), ("nozzle", jetski.NOZZLE),
                                      ("sponson", jetski.SPONSON), ("visor", jetski.VISOR),
                                      ("mirror", jetski.MIRROR), ("handle", jetski.HANDLE), ("boot", jetski.BOOT))}
    t = (zs - s.stern) / (s.bow - s.stern)

    # The hull below the boot stripe in the second colour, the stripe itself in the accent.
    split = chine + 0.05 + 0.1 * t**2
    c.put(is_["hull"] * smoothstep(split + 0.003, split - 0.003, y), tint=SECOND)
    c.put(is_["hull"] * smoothstep(0.004, 0.002, np.abs(y - split - 0.018)) * (1 - smoothstep(0.012, 0.016, np.abs(y - split - 0.018))),
          tint=ACCENT)
    # The intake's grate and the ride plate under the stern, and the spray rail's step: plain.
    bottom = is_["hull"] & (ny < -0.6)
    grate = bottom & (ax < 0.12) & (z > s.stern + 0.25) & (z < s.stern + 0.95)
    c.put(grate, plain=DARK_METAL)
    c.line(grate * (np.sin(z * 2 * math.pi / 0.025) > 0.6), 0.5)
    c.put(bottom & (ax < 0.17) & (z < s.stern + 0.22), plain=METAL)

    if model == "summer.ride.runabout":
        # A wave sweeping back along each side from the bow, widening toward the stern, a pinstripe over it.
        yc = lerp(rail - 0.05, chine + 0.12, smoothstep(1.0, 0.1, t)) + 0.025 * np.sin(t * 7.0)
        hw = 0.006 + 0.05 * smoothstep(0.85, 0.15, t)
        side = (is_["hull"] | is_["deck"]) & (np.abs(N[..., 0]) > 0.25) & (y < rail + 0.12)
        wave = side * smoothstep(hw + 0.003, hw - 0.003, np.abs(y - yc)) * (t < 0.97)
        c.put(wave, tint=ACCENT)
        pin = side * smoothstep(0.004, 0.0015, np.abs(y - (yc + hw + 0.022))) * (t < 0.9) * (t > 0.05)
        c.put(pin, tint=SECOND)
        both_sides(c, BRANDS[model], s.bow - 0.75, L.rail(s.bow - 1.0) - 0.11, 0.5, plain=WHITE, outline=SECOND,
                   where=is_["hull"])
    elif model == "summer.ride.racer":
        # A blade: the stern half in the second colour behind a raked cut, an accent slash along the cut.
        cut = 0.05 - 0.9 * (y - 0.3)
        sideish = (is_["hull"] | is_["deck"]) & (np.abs(N[..., 0]) > 0.2)
        c.put(sideish * smoothstep(cut + 0.004, cut - 0.004, z) * (y > split + 0.03), tint=SECOND)
        c.put(sideish * smoothstep(0.03, 0.026, np.abs(z - cut - 0.06)) * (y > split + 0.03), tint=ACCENT)
        both_sides(c, BRANDS[model], s.bow - 0.35, L.rail(s.bow - 0.66) - 0.12, 0.62, tint=ACCENT, outline=INK,
                   where=is_["hull"], lean=0.08)
    else:
        # Long and clean: a chrome strip along the deck's side over the bumper, a pinstripe down the hull.
        strip = is_["deck"] & (np.abs(N[..., 0]) > 0.35) & (np.abs(y - rail - 0.04) < 0.008)
        c.put(strip, plain=WHITE)
        pin = is_["hull"] & (np.abs(N[..., 0]) > 0.25) & (np.abs(y - (rail - 0.07 - 0.03 * t)) < 0.006)
        c.put(pin * (t > 0.04) * (t < 0.93), tint=ACCENT)
        both_sides(c, BRANDS[model], s.stern + 0.95, L.rail(s.stern + 0.7) - 0.14, 0.55, tint=SECOND, face=UPRIGHT,
                   where=is_["hull"])

    # The deck: the console and pedestal's walls in the second colour, the footwells and the platform matted.
    deck = is_["deck"]
    floor = deck & (ny > 0.75) & (y < jetski.FLOOR + 0.03)
    walls = deck & (ax < s.well_in + 0.015) & (y > jetski.FLOOR + 0.005) & (y < centre - 0.004) & (z < s.well_front)
    c.put(walls, tint=SECOND)
    c.put(floor, plain=MAT)
    # The mats' grooves, and a border of the accent round them.
    groove = floor * (np.abs(((z + 0.6 * ax) / 0.035) % 1 - 0.5) < 0.12)
    c.line(groove, 0.55)
    edge_in = np.minimum(np.abs(ax - (s.well_in + 0.03)), np.abs(ax - (beam - s.gunwale_w - 0.035)))
    c.put(floor * smoothstep(0.012, 0.008, edge_in) * (z > s.stern + s.platform), tint=ACCENT, gloss=0.3)
    # The hood: the lid's panel line, and per model two accent stripes, one broad one between pinstripes, or the
    # lid in the second colour edged in the accent. Vents on its sides.
    hood = deck & (z > s.well_front + 0.12) & (ny > 0.35)
    lid = ((ax / (0.8 * np.maximum(beam - s.gunwale_w, 0.05))) ** 2 +
           ((z - (s.well_front + s.bow) / 2) / ((s.bow - s.well_front) / 2 - 0.08)) ** 4)
    on_lid = deck & (ny > 0.2)
    nose = z < s.bow - 0.12
    if model == "summer.ride.runabout":
        for off in (0.07, -0.07):
            c.put(hood * smoothstep(0.022, 0.018, np.abs(x - off)) * nose, tint=ACCENT)
    elif model == "summer.ride.racer":
        c.put(hood * smoothstep(0.055, 0.05, ax) * nose, tint=ACCENT)
        c.put(hood * smoothstep(0.006, 0.003, np.abs(ax - 0.07)) * nose, tint=SECOND)
    else:
        c.put(on_lid * smoothstep(0.985, 0.97, lid), tint=SECOND)
        c.put(on_lid * smoothstep(0.03, 0.015, np.abs(lid - 1.08)), tint=ACCENT)
    c.stroke(np.where(on_lid, lid - 1.0, 9.0) * 0.12, 0.0025)
    for k in range(3):
        vz = s.well_front + 0.08 + 0.05 * k
        vent = deck & (np.abs(N[..., 0]) > 0.5) & (np.abs(z - vz) < 0.012) & (np.abs(y - (rail + 0.08)) < 0.025)
        c.put(vent, plain=INK)
    # The gauges in front of the bars: a dark glass panel ringed in the accent.
    gz, gx = jetski.PIVOT[2] + 0.13, 0.0
    gd = np.maximum(np.abs(x - gx) / 0.11, np.abs(z - gz) / 0.05)
    gauge = deck & (ny > 0.3) & (gd < 1.0)
    c.put(deck & (ny > 0.3) & (gd < 1.15), tint=ACCENT)
    c.put(gauge, plain=SMOKE)
    c.put(gauge * smoothstep(0.02, 0.01, np.abs(np.hypot((x - 0.04) / 0.03, (z - gz) / 0.03) - 1) * 0.03),
          plain=WHITE)
    # A registration number on the bow, as the law asks.
    for side in (1, -1):
        u = np.array([0.0, 0.0, -side])
        start = s.bow - 0.25 if side > 0 else s.bow - 0.25 - 0.32
        c.mark("CN·2304", (0.0, L.rail(s.bow - 0.4) + 0.05, start), u, (0, 1, 0), 0.32, (side, 0, 0), plain=INK, face=UPRIGHT,
               where=deck & (z > s.well_front))

    # The seat: the colour's second, piped in the accent where its top turns down, the brand on its back.
    seat = is_["seat"]
    c.put(seat, tint=SECOND, gloss=0.15)
    c.put(seat * smoothstep(0.08, 0.04, np.abs(ny - 0.62)), tint=ACCENT, gloss=0.15)
    c.line(seat * smoothstep(0.004, 0.002, np.abs(ny - 0.5)), 0.45)
    c.mark(BRANDS[model], (0.12, s.seat_top - 0.07, s.seat_rear - 0.1), (-1, 0, 0), (0, 1, 0), 0.24, (0, 0, -1),
           tint=ACCENT, where=seat, min_dot=0.4)
    # Rubber, metal, glass.
    c.put(is_["bumper"] | is_["sponson"], plain=RUBBER)
    c.put(is_["boot"], plain=RUBBER)
    c.line(is_["boot"] * (np.sin(y * 2 * math.pi / 0.018) > 0.5), 0.5)
    c.put(is_["pole"], tint=SECOND, gloss=0.6)
    c.mark(BRANDS[model], (0.085, jetski.PIVOT[1] - 0.02, jetski.PIVOT[2] - 0.11), (-1, 0, 0), (0, 0.6, 0.8), 0.17,
           (0, 0.5, -0.8), tint=ACCENT, where=is_["pole"], min_dot=0.3)
    c.put(is_["bar"], plain=DARK_METAL)
    c.put(is_["grips"], plain=RUBBER)
    c.line(is_["grips"] * (np.sin(ax * 2 * math.pi / 0.012) > 0.4), 0.5)
    c.put(is_["nozzle"], plain=METAL)
    c.put(is_["handle"], plain=DARK_METAL)
    visor = is_["visor"]
    c.put(visor, plain=(SMOKE[0], 0.4))
    c.put(visor * smoothstep(0.03, 0.0, np.abs(y - jetski.PIVOT[1] + 0.12 + 0.4 * x)), plain=(0.45, 1.0))
    mirror = is_["mirror"]
    c.put(mirror, tint=SECOND, gloss=0.8)
    c.put(mirror * (N[..., 2] < -0.7) * (y > jetski.PIVOT[1] - 0.2), plain=(0.75, 1.0))
    # Wear: scuffs along the waterline and on the platform.
    wear = fbm(P * np.array([1.0, 3.0, 1.0]), 22.0, 3, seed=7)
    scuff = (wear > 0.74) * ((is_["hull"] & (np.abs(y - 0.3) < 0.05) & (z < s.stern + 0.6)) | (floor & (z < s.stern + 0.35)))
    c.line(scuff * smoothstep(0.74, 0.8, wear), 0.3)
    return c.done()


def _line(L, f, n=400):
    zs = np.linspace(L.s.stern, L.s.bow, n)
    return zs, np.array([f(z) for z in zs])


# ---------------------------------------------------------------- snowboards

def paint_board(model, maps):
    b = board.BOARDS[model]
    O = board.Outline(b)
    c = Canvas(maps)
    P, N, part = c.P, c.N, c.part
    x, y, z = P[..., 0], P[..., 1], P[..., 2]
    ax = np.abs(x)
    ny = N[..., 1]
    deck = part == board.TOP
    top = deck & (ny > 0.35)
    base = deck & (ny < -0.35)
    wall = deck & ~top & ~base
    zs = np.clip(z, -b.length / 2, b.length / 2)
    grid = np.linspace(-b.length / 2, b.length / 2, 600)
    w = np.interp(zs, grid, [O.half_width(q) for q in grid])
    u = z / (b.length / 2)

    if model == "winter.ride.freestyle":
        # Gusts: diagonal streaks of the second colour across both ends, an accent one through each.
        a = (z * 0.8 + x * 1.6) / 0.11
        streak = (np.abs(a % 1 - 0.5) < 0.22) * (np.abs(u) > 0.3)
        c.put(top * streak, tint=SECOND)
        c.put(top * (np.abs(a % 3 - 1.5) < 0.12) * (np.abs(u) > 0.3), tint=ACCENT)
        c.mark(BRANDS[model], (0.0, 0.0, -0.07), (0, 0, 1), (1, 0, 0), 0.24, (0, 1, 0), tint=ACCENT,
               outline=SECOND, where=top)
        c.put(base, tint=SECOND, gloss=0.4)
        c.mark(BRANDS[model], (0.0, 0.0, -0.62), (0, 0, 1), (-1, 0, 0), 1.24, (0, -1, 0), tint=MAIN, where=base)
    elif model == "winter.ride.freeride":
        # Sunrise over the ridge: the tail half in the second colour under a jagged ridgeline, accent rays at
        # the nose.
        ridge = 0.05 * np.sin(x * 40) + 0.03 * np.sin(x * 97 + 1) - 0.08
        c.put(top * smoothstep(ridge + 0.004, ridge - 0.004, z), tint=SECOND)
        nose = np.array([0.0, b.length / 2 - 0.05])
        ang = np.arctan2(x - nose[0], z - nose[1])
        rays = (np.abs((ang / 0.2) % 1 - 0.5) < 0.2) * (np.hypot(x, z - nose[1]) > 0.12) * (z > O.zn - 0.2)
        c.put(top * rays, tint=ACCENT)
        c.put(top * smoothstep(0.1, 0.095, np.hypot(x, z - nose[1])), tint=ACCENT)
        c.mark(BRANDS[model], (0.0, 0.0, -0.5), (0, 0, 1), (1, 0, 0), 0.3, (0, 1, 0), tint=MAIN, where=top)
        c.put(base, tint=MAIN, gloss=0.4)
        c.mark(BRANDS[model], (0.0, 0.0, -0.55), (0, 0, 1), (-1, 0, 0), 1.1, (0, -1, 0), tint=SECOND, where=base)
    else:
        # Race stripes: the second colour down the middle, the main along both edges, an accent pinstripe.
        c.put(top * (ax < 0.55 * w), tint=SECOND)
        c.put(top * smoothstep(0.006, 0.004, np.abs(ax - 0.55 * w - 0.012)), tint=ACCENT)
        c.put(top * smoothstep(0.005, 0.003, np.abs(x)) * (np.abs(u) < 0.85), tint=ACCENT)
        c.mark(BRANDS[model], (0.0, 0.0, 0.38), (0, 0, 1), (1, 0, 0), 0.22, (0, 1, 0), tint=MAIN, where=top)
        c.mark(BRANDS[model], (0.0, 0.0, -0.6), (0, 0, 1), (1, 0, 0), 0.22, (0, 1, 0), tint=MAIN, where=top)
        c.put(base, tint=SECOND, gloss=0.4)
        c.mark(BRANDS[model], (0.0, 0.0, -0.5), (0, 0, 1), (-1, 0, 0), 1.0, (0, -1, 0), tint=ACCENT, where=base)
    # The stomp pad by the back binding, the steel edges round the base, the sidewalls.
    pad = top & (np.abs(z + 0.13) < 0.04) & (ax < 0.065)
    c.put(pad, plain=(0.3, 0.0))
    c.line(pad * (np.abs(((z + x * 0.5) / 0.012) % 1 - 0.5) < 0.18), 0.5)
    c.put(base & (ax > w - 0.004), plain=METAL)
    c.put(wall, plain=(0.2, 0.6))
    # A thin accent topline where the topsheet meets the sidewall.
    c.put(top & (ax > w * 0.97 - 0.004), tint=ACCENT)

    # The bindings: black baseplates, highbacks in the second colour, straps in the accent, metal buckles.
    c.put(part == board.BASEPLATE, plain=RUBBER)
    hb = part == board.HIGHBACK
    c.put(hb, tint=SECOND, gloss=0.5)
    # The highback's inside is padded and dark.
    c.put(hb * (np.abs(z) < 1) * _inside_highback(P, N), plain=(0.14, 0.0))
    strap = part == board.STRAP
    c.put(strap, tint=ACCENT, gloss=0.1)
    c.line(strap * (np.sin(_along_strap(P) * 2 * math.pi / 0.012) > 0.6), 0.3)
    c.put(part == board.BUCKLE, plain=METAL)
    return c.done()


def _inside_highback(P, N):
    """Texels on a highback's inner face: their normal points toward the binding's middle."""
    out = np.zeros(P.shape[:2], dtype=bool)
    for side in (1, -1):
        centre = np.array([board.BINDING_X, 0.0, side * board.STANCE])
        d = centre - P
        d[..., 1] = 0
        near = np.abs(P[..., 2] - side * board.STANCE) < 0.2
        out |= near & ((N * d).sum(axis=-1) > 0)
    return out


def _along_strap(P):
    return P[..., 1] * 1.0 + np.abs(P[..., 0]) * 0.5


def paint(model, maps):
    if model in jetski.SKIS:
        return paint_jetski(model, maps)
    return paint_board(model, maps)


def preview(folder, model, obj, detail, mask, colours=(0xF2C230, 0x1C1D21, 0xD9382E)):
    """The texture tinted with a colourway, as the game's shader flattens it (no light): a quick check."""
    os.makedirs(folder, exist_ok=True)
    t = np.array([[(h >> 16) & 255, (h >> 8) & 255, h & 255] for h in colours]) / 255.0
    w = mask[..., :3]
    sw = w.sum(axis=2, keepdims=True)
    tint = (w[..., 0:1] * t[0] + w[..., 1:2] * t[1] + w[..., 2:3] * t[2]) / np.maximum(sw, 1e-4)
    g = detail if detail.ndim == 2 else detail[..., 0]
    mark = smoothstep(0.2, 0.12, g)[..., None]
    tinted = tint * (1 - 0.68 * mark)
    plain = np.clip(g * 1.25, 0, 1)[..., None]
    out = plain * (1 - np.clip(sw, 0, 1)) + tinted * np.clip(sw, 0, 1)
    import bake

    bake.save_png(os.path.join(folder, f"{model}.atlas.png"), out)
