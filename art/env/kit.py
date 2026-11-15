"""Low-poly scenery as triangle soups with a colour per vertex, and the shapes they are built from.

Everything is in the game's axes (metres, y up). A `Mesh` is positions, colours, a sway weight per vertex (how far
the wind moves it) and triangles, with a material class (`solid`, `foliage`, `cloth`, `glass`, `paving`...) and
whether it shades smooth or faceted. Shapes come out facing outward; `xf` moves them (4x4 matrices from `T`, `RX`,
`RY`, `RZ`, `S`).
"""

import math

import numpy as np
from mathutils import Vector
from mathutils.geometry import tessellate_polygon

TAU = math.tau


def srgb(colour):
    """A colour (0xRRGGBB or "#rrggbb") as linear RGB."""
    if isinstance(colour, str):
        colour = int(colour.lstrip("#"), 16)
    if isinstance(colour, (tuple, list, np.ndarray)):
        return np.asarray(colour, dtype=np.float32)
    c = np.array([(colour >> 16) & 255, (colour >> 8) & 255, colour & 255], dtype=np.float32) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4).astype(np.float32)


def shade(colour, k):
    """A colour made darker (k < 1) or lighter (k > 1)."""
    return np.clip(srgb(colour) * k, 0, 1)


def blend(a, b, k):
    return srgb(a) * (1 - k) + srgb(b) * k


# Matrices.


def T(x=0.0, y=0.0, z=0.0):
    m = np.eye(4)
    m[:3, 3] = (x, y, z)
    return m


def S(x=1.0, y=None, z=None):
    y = x if y is None else y
    z = x if z is None else z
    return np.diag([x, y, z, 1.0])


def RX(a):
    c, s = math.cos(a), math.sin(a)
    m = np.eye(4)
    m[1, 1], m[1, 2], m[2, 1], m[2, 2] = c, -s, s, c
    return m


def RY(a):
    c, s = math.cos(a), math.sin(a)
    m = np.eye(4)
    m[0, 0], m[0, 2], m[2, 0], m[2, 2] = c, s, -s, c
    return m


def RZ(a):
    c, s = math.cos(a), math.sin(a)
    m = np.eye(4)
    m[0, 0], m[0, 1], m[1, 0], m[1, 1] = c, -s, s, c
    return m


def frame(origin, x_axis, y_axis):
    """A matrix taking local x and y to the given directions at `origin` (z is their cross product)."""
    x = np.asarray(x_axis, dtype=float)
    x = x / np.linalg.norm(x)
    y = np.asarray(y_axis, dtype=float)
    y = y - x * np.dot(x, y)
    y = y / np.linalg.norm(y)
    z = np.cross(x, y)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = x, y, z, origin
    return m


class Mesh:
    """A triangle soup: P positions, C colours (linear), W sway weights, F triangles."""

    def __init__(self, P, F, colour=0xFFFFFF, cls="solid", smooth=False, W=None):
        self.P = np.asarray(P, dtype=np.float64).reshape(-1, 3)
        self.F = np.asarray(F, dtype=np.int64).reshape(-1, 3)
        c = np.asarray(colour) if isinstance(colour, np.ndarray) and colour.ndim == 2 else None
        self.C = c.astype(np.float32) if c is not None else np.tile(srgb(colour), (len(self.P), 1))
        self.W = np.zeros(len(self.P), dtype=np.float32) if W is None else np.asarray(W, dtype=np.float32)
        self.cls = cls
        self.smooth = smooth

    def copy(self):
        return Mesh(self.P.copy(), self.F.copy(), self.C.copy(), self.cls, self.smooth, self.W.copy())

    def xf(self, m):
        """Moved by a matrix (a mirror turns the faces back out)."""
        out = self.copy()
        out.P = self.P @ m[:3, :3].T + m[:3, 3]
        if np.linalg.det(m[:3, :3]) < 0:
            out.F = out.F[:, ::-1]
        return out

    def at(self, x=0.0, y=0.0, z=0.0):
        return self.xf(T(x, y, z))

    def as_(self, cls, smooth=None):
        out = self.copy()
        out.cls = cls
        if smooth is not None:
            out.smooth = smooth
        return out

    def paint(self, colour):
        """Repainted: one colour, or a function of the positions giving a colour per vertex."""
        out = self.copy()
        out.C = np.asarray(colour(out.P), dtype=np.float32) if callable(colour) else np.tile(srgb(colour), (len(out.P), 1))
        return out

    def sway(self, weight):
        """With sway weights: a number, or a function of the positions."""
        out = self.copy()
        w = weight(out.P) if callable(weight) else np.full(len(out.P), weight)
        out.W = np.clip(np.asarray(w, dtype=np.float32), 0, 1)
        return out

    def flipped(self):
        out = self.copy()
        out.F = out.F[:, ::-1]
        return out

    def outward(self):
        """Its faces turned to face out, for a closed shape wound the wrong way."""
        q = self.P[self.F] - self.P.mean(axis=0)
        volume = np.einsum("ij,ij->i", q[:, 0], np.cross(q[:, 1], q[:, 2])).sum()
        return self.flipped() if volume < 0 else self

    def clean(self):
        """Without its degenerate triangles."""
        p = self.P[self.F]
        area = np.linalg.norm(np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0]), axis=1)
        out = self.copy()
        out.F = self.F[area > 1e-10]
        return out


def join(meshes):
    """Meshes of one class and shading as one."""
    meshes = [m for m in meshes if len(m.F)]
    if not meshes:
        return None
    offsets = np.cumsum([0] + [len(m.P) for m in meshes[:-1]])
    return Mesh(
        np.concatenate([m.P for m in meshes]),
        np.concatenate([m.F + o for m, o in zip(meshes, offsets)]),
        np.concatenate([m.C for m in meshes]),
        meshes[0].cls,
        meshes[0].smooth,
        np.concatenate([m.W for m in meshes]),
    )


def xf(parts, m):
    """A list of meshes, moved."""
    return [p.xf(m) for p in parts]


# Shapes.


def box(w, h, d, colour=0xFFFFFF, cls="solid", base=True):
    """A box `w` by `h` by `d`, centred on x and z, standing on y = 0 (`base`) or centred."""
    x, z = w / 2, d / 2
    y0, y1 = (0, h) if base else (-h / 2, h / 2)
    P = [(-x, y0, -z), (x, y0, -z), (x, y0, z), (-x, y0, z), (-x, y1, -z), (x, y1, -z), (x, y1, z), (-x, y1, z)]
    F = [(0, 1, 2), (0, 2, 3), (4, 6, 5), (4, 7, 6), (0, 4, 5), (0, 5, 1), (1, 5, 6), (1, 6, 2), (2, 6, 7), (2, 7, 3), (3, 7, 4), (3, 4, 0)]
    return Mesh(P, F, colour, cls).outward()


def taper(w0, d0, w1, d1, h, colour=0xFFFFFF, cls="solid"):
    """A box whose top (`w1` by `d1`) differs from its foot (`w0` by `d0`), standing on y = 0."""
    b = box(1, 1, 1, colour, cls)
    k = b.P[:, 1]
    b.P[:, 0] *= w0 + (w1 - w0) * k
    b.P[:, 2] *= d0 + (d1 - d0) * k
    b.P[:, 1] *= h
    return b


def quad(a, b, c, d, colour=0xFFFFFF, cls="solid"):
    """A four-cornered face, a to d going round counter-clockwise seen from its front."""
    return Mesh([a, b, c, d], [(0, 1, 2), (0, 2, 3)], colour, cls)


def tri(a, b, c, colour=0xFFFFFF, cls="solid"):
    return Mesh([a, b, c], [(0, 1, 2)], colour, cls)


def grid(nu, nv, point, colour=0xFFFFFF, cls="solid", smooth=True):
    """A surface of `nu` by `nv` quads through `point(u, v)` (u, v in 0-1); its front is where u x v points."""
    P = [point(i / nu, j / nv) for j in range(nv + 1) for i in range(nu + 1)]
    F = []
    for j in range(nv):
        for i in range(nu):
            a = j * (nu + 1) + i
            b, c, d = a + 1, a + nu + 2, a + nu + 1
            F += [(a, b, c), (a, c, d)]
    return Mesh(P, F, colour, cls, smooth).clean()


def lathe(profile, sides=10, colour=0xFFFFFF, cls="solid", smooth=True, arc=TAU, colours=None):
    """A profile of (radius, height) points, bottom to top, turned about the y axis. A point given twice makes a
    hard edge; `colours` paints each point's ring."""
    closed = abs(arc - TAU) < 1e-9
    n = sides if closed else sides + 1
    P, C, F = [], [], []
    base = srgb(colour)
    for k, (r, y) in enumerate(profile):
        c = srgb(colours[k]) if colours is not None else base
        for i in range(n):
            a = arc * i / sides
            P.append((r * math.cos(a), y, r * math.sin(a)))
            C.append(c)
    for k in range(len(profile) - 1):
        if profile[k] == profile[k + 1]:
            continue
        for i in range(sides):
            a = k * n + i
            b = k * n + (i + 1) % n
            c = (k + 1) * n + (i + 1) % n
            d = (k + 1) * n + i
            F += [(a, d, b), (b, d, c)]
    return Mesh(P, F, np.array(C), cls, smooth).clean()


def disc(radius, sides=10, colour=0xFFFFFF, cls="solid", up=True):
    """A flat disc at y = 0, facing up (or down)."""
    P = [(0, 0, 0)] + [(radius * math.cos(TAU * i / sides), 0, radius * math.sin(TAU * i / sides)) for i in range(sides)]
    F = [(0, 1 + (i + 1) % sides, 1 + i) for i in range(sides)]
    m = Mesh(P, F, colour, cls)
    return m if up else m.flipped()


def ball(radius, sides=8, rings=5, colour=0xFFFFFF, cls="solid", smooth=True, squash=1.0):
    """A sphere (rings of latitude), centred."""
    profile = [(radius * math.sin(math.pi * k / rings), -radius * squash * math.cos(math.pi * k / rings)) for k in range(rings + 1)]
    return lathe(profile, sides, colour, cls, smooth)


def blob(radius, seed=0, colour=0xFFFFFF, cls="foliage", lumps=0.28, squash=0.8, detail=1):
    """A lumpy ball: a clump of leaves or flowers."""
    ico = icosphere(detail)
    rng = np.random.default_rng(seed)
    dirs = rng.normal(size=(5, 3))
    dirs /= np.linalg.norm(dirs, axis=1)[:, None]
    P = ico.P.copy()
    bump = np.zeros(len(P))
    for d in dirs:
        bump += np.clip(P @ d, 0, 1) ** 2
    P *= (radius * (1 - lumps * 0.5 + lumps * bump))[:, None]
    P[:, 1] *= squash
    return Mesh(P, ico.F, colour, cls, True)


_ICO = {}


def icosphere(detail=1):
    """A unit icosphere (shared vertices)."""
    if detail in _ICO:
        return _ICO[detail]
    t = (1 + 5**0.5) / 2
    P = [(-1, t, 0), (1, t, 0), (-1, -t, 0), (1, -t, 0), (0, -1, t), (0, 1, t), (0, -1, -t), (0, 1, -t), (t, 0, -1), (t, 0, 1), (-t, 0, -1), (-t, 0, 1)]
    F = [(0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11), (1, 5, 9), (5, 11, 4), (11, 10, 2), (10, 7, 6), (7, 1, 8), (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9), (4, 9, 5), (2, 4, 11), (6, 2, 10), (8, 6, 7), (9, 8, 1)]
    P = [np.array(p) / np.linalg.norm(p) for p in P]
    for _ in range(detail):
        mid = {}
        out = []

        def half(a, b):
            key = (min(a, b), max(a, b))
            if key not in mid:
                m = P[a] + P[b]
                P.append(m / np.linalg.norm(m))
                mid[key] = len(P) - 1
            return mid[key]

        for a, b, c in F:
            ab, bc, ca = half(a, b), half(b, c), half(c, a)
            out += [(a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)]
        F = out
    _ICO[detail] = Mesh(P, F, 0xFFFFFF, "solid", True).outward()
    return _ICO[detail]


def _frames(path):
    """Tangents, and normals and binormals carried along a path without twisting."""
    path = np.asarray(path, dtype=float)
    tangents = np.gradient(path, axis=0)
    tangents /= np.linalg.norm(tangents, axis=1)[:, None]
    t0 = tangents[0]
    ref = np.array([0.0, 1.0, 0.0]) if abs(t0[1]) < 0.9 else np.array([1.0, 0.0, 0.0])
    n = np.cross(t0, np.cross(ref, t0))
    n /= np.linalg.norm(n)
    normals = [n]
    for i in range(1, len(path)):
        n = normals[-1] - tangents[i] * np.dot(normals[-1], tangents[i])
        n /= np.linalg.norm(n)
        normals.append(n)
    normals = np.array(normals)
    return tangents, normals, np.cross(tangents, normals)


def tube(path, radius, sides=6, colour=0xFFFFFF, cls="solid", smooth=True, caps=True, colours=None):
    """A tube along a path; `radius` is a number or one per point; `colours` one per point."""
    path = np.asarray(path, dtype=float)
    n = len(path)
    radii = np.full(n, radius, dtype=float) if np.isscalar(radius) else np.asarray(radius, dtype=float)
    _, normals, binormals = _frames(path)
    base = srgb(colour)
    P, C, F = [], [], []
    for k in range(n):
        c = srgb(colours[k]) if colours is not None else base
        for i in range(sides):
            a = TAU * i / sides
            P.append(path[k] + radii[k] * (math.cos(a) * normals[k] + math.sin(a) * binormals[k]))
            C.append(c)
    for k in range(n - 1):
        for i in range(sides):
            a = k * sides + i
            b = k * sides + (i + 1) % sides
            c = (k + 1) * sides + (i + 1) % sides
            d = (k + 1) * sides + i
            F += [(a, b, d), (b, c, d)]
    if caps:
        for k, flip in ((0, False), (n - 1, True)):
            P.append(path[k])
            C.append(srgb(colours[k]) if colours is not None else base)
            centre = len(P) - 1
            for i in range(sides):
                a = k * sides + i
                b = k * sides + (i + 1) % sides
                F.append((centre, a, b) if flip else (centre, b, a))
    return Mesh(P, F, np.array(C), cls, smooth).clean().outward()


def rod(a, b, radius, sides=6, colour=0xFFFFFF, cls="solid", smooth=True):
    """A straight tube from `a` to `b`."""
    return tube([a, b], radius, sides, colour, cls, smooth)


def ribbon(path, widths, across, colour=0xFFFFFF, cls="cloth", fold=0.0, smooth=True):
    """A strip along a path, `widths` wide (a number or one per point), lying along `across` (a direction, or one
    per point); `fold` lifts the edges into a V (m at full width)."""
    path = np.asarray(path, dtype=float)
    n = len(path)
    w = np.full(n, widths, dtype=float) if np.isscalar(widths) else np.asarray(widths, dtype=float)
    ax = np.tile(np.asarray(across, dtype=float), (n, 1)) if np.ndim(across) == 1 else np.asarray(across, dtype=float)
    tangents = np.gradient(path, axis=0)
    tangents /= np.linalg.norm(tangents, axis=1)[:, None]
    ax = ax - tangents * np.einsum("ij,ij->i", ax, tangents)[:, None]
    ax /= np.linalg.norm(ax, axis=1)[:, None]
    up = np.cross(ax, tangents)
    P, F = [], []
    for k in range(n):
        lift = up[k] * fold * (w[k] / max(w.max(), 1e-9))
        P += [path[k] - ax[k] * w[k] / 2 + lift, path[k], path[k] + ax[k] * w[k] / 2 + lift]
    for k in range(n - 1):
        a = k * 3
        F += [(a, a + 1, a + 4), (a, a + 4, a + 3), (a + 1, a + 2, a + 5), (a + 1, a + 5, a + 4)]
    return Mesh(P, F, colour, cls, smooth).clean()


def _area(poly):
    p = np.asarray(poly, dtype=float)
    return 0.5 * np.sum(p[:, 0] * np.roll(p[:, 1], -1) - np.roll(p[:, 0], -1) * p[:, 1])


def slab(outline, y0, y1, colour=0xFFFFFF, cls="solid", holes=(), top=None, bottom=True, sides=True, side_colour=None, lid=True):
    """A flat shape in xz (`outline`, a list of (x, z); `holes` likewise) from `y0` up to `y1`. `top` paints the
    top face its own colour; `side_colour` the sides."""
    rings = [list(outline)] + [list(h) for h in holes]
    pts = [p for r in rings for p in r]
    tris = tessellate_polygon([[Vector((x, z, 0)) for x, z in r] for r in rings])
    n = len(pts)
    P = [(x, y1, z) for x, z in pts] + [(x, y0, z) for x, z in pts]
    Ft = []
    for a, b, c in tris:
        pa, pb, pc = (np.array(pts[i]) for i in (a, b, c))
        # Counter-clockwise in (x, z) faces down: turn it to face up.
        ccw = np.cross(pb - pa, pc - pa) > 0
        Ft.append((a, c, b) if ccw else (a, b, c))
    parts = [Mesh(P[:n], Ft, colour if top is None else top, cls)] if lid else []
    if bottom:
        parts.append(Mesh(P[n:], [(a, c, b) for a, b, c in Ft], colour, cls))
    if sides:
        Ps, Fs = [], []
        for r in rings:
            # The solid lies left of an outline going counter-clockwise in (x, z) seen from below (+y up).
            m = len(r)
            for i in range(m):
                (x0, z0), (x1, z1) = r[i], r[(i + 1) % m]
                k = len(Ps)
                Ps += [(x0, y0, z0), (x1, y0, z1), (x1, y1, z1), (x0, y1, z0)]
                Fs += [(k, k + 1, k + 2), (k, k + 2, k + 3)]
        side = Mesh(Ps, Fs, colour if side_colour is None else side_colour, cls)
        parts.append(_side_out(side, rings))
    return join(parts).clean()


def _side_out(side, rings):
    """Side walls turned to face away from the solid: out of the outline, into the holes."""
    F = side.F.copy()
    offset = 0
    for index, r in enumerate(rings):
        m = len(r)
        # A wall's face points left of its edge in (x, z): into a ring of positive area.
        if (_area(r) > 0) == (index == 0):
            F[offset * 2 : (offset + m) * 2] = F[offset * 2 : (offset + m) * 2][:, ::-1]
        offset += m
    out = side.copy()
    out.F = F
    return out


def plate(outline, y, colour=0xFFFFFF, cls="solid", holes=()):
    """A flat shape in xz at height `y`, facing up."""
    return slab(outline, y, y, colour, cls, holes, bottom=False, sides=False)


def wall(outline, thickness, colour=0xFFFFFF, cls="solid", holes=(), reveal=None, back=True):
    """An upright wall: `outline` and `holes` are (x, y) in its face; it stands on its face plane z = 0 and goes
    back to z = -thickness, its front facing +z. `reveal` paints the thickness of the openings."""
    flat = slab([(x, -y) for x, y in outline], -thickness, 0, colour, cls, [[(x, -y) for x, y in h] for h in holes], bottom=back, side_colour=reveal)
    return flat.xf(RX(math.pi / 2))


def arch(x0, x1, y0, spring, steps=8):
    """An opening from x0 to x1 and y0 up to `spring`, with a half-round head above: its outline, in (x, y)."""
    r = (x1 - x0) / 2
    cx = (x0 + x1) / 2
    head = [(cx + r * math.cos(math.pi * i / steps), spring + r * math.sin(math.pi * i / steps)) for i in range(steps + 1)]
    return [(x0, y0), (x1, y0)] + head


def rect(x0, x1, y0, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def extrude(profile, path, colour=0xFFFFFF, cls="solid", closed=False, smooth=False, up=(0, 1, 0)):
    """A profile of (across, up) points swept along a path in the ground plane (mouldings, rails, kerbs). `across`
    is to the right of the path's direction. `closed` joins the path's end to its start."""
    path = np.asarray(path, dtype=float)
    n = len(path)
    up = np.asarray(up, dtype=float)
    P, F = [], []
    m = len(profile)
    rights = []
    for k in range(n):
        prev = path[(k - 1) % n] if (closed or k > 0) else path[k]
        nxt = path[(k + 1) % n] if (closed or k < n - 1) else path[k]
        d0 = path[k] - prev
        d1 = nxt - path[k]
        d0 = d0 / np.linalg.norm(d0) if np.linalg.norm(d0) > 1e-9 else None
        d1 = d1 / np.linalg.norm(d1) if np.linalg.norm(d1) > 1e-9 else None
        if d0 is None:
            d0 = d1
        if d1 is None:
            d1 = d0
        r0 = np.cross(d0, up)
        r1 = np.cross(d1, up)
        r = r0 + r1
        r /= np.linalg.norm(r)
        # A mitre: the corner's offset is longer than the straight's.
        r = r / max(np.dot(r, r0 / np.linalg.norm(r0)), 0.3)
        rights.append(r)
    for k in range(n):
        for a, h in profile:
            P.append(path[k] + rights[k] * a + up * h)
    spans = n if closed else n - 1
    for k in range(spans):
        k1 = (k + 1) % n
        for j in range(m - 1):
            a, b = k * m + j, k * m + j + 1
            c, d = k1 * m + j + 1, k1 * m + j
            F += [(a, b, c), (a, c, d)]
    mesh = Mesh(P, F, colour, cls, smooth).clean()
    # The profile's winding decides which way it faces: check against the first span.
    if len(mesh.F):
        p = mesh.P[mesh.F[0]]
        normal = np.cross(p[1] - p[0], p[2] - p[0])
        (a0, h0), (a1, h1) = profile[0], profile[1]
        want = rights[0] * (h1 - h0) - up * (a1 - a0)
        if np.dot(normal, want) < 0:
            mesh = mesh.flipped()
    return mesh


def catenary(a, b, sag, steps=12):
    """Points of a line hanging from `a` to `b`, `sag` lower in the middle."""
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    out = []
    for i in range(steps + 1):
        t = i / steps
        p = a + (b - a) * t
        p[1] -= sag * 4 * t * (1 - t)
        out.append(p)
    return np.array(out)


def arc_points(cx, cz, r, a0, a1, steps):
    return [(cx + r * math.cos(a0 + (a1 - a0) * i / steps), cz + r * math.sin(a0 + (a1 - a0) * i / steps)) for i in range(steps + 1)]
