"""Signed distance shapes in numpy: the clay riders are sculpted from.

Every shape evaluates on an (N, 3) array of points and returns N distances
(negative inside). Shapes know their bounds, so a union only evaluates each
child near where it can matter. Distances are approximate away from the
surface (ellipsoids, lofts, smooth blends), exact enough near it to mesh.
"""

import numpy as np

BIG = np.float32(1e3)


def _f(a):
    return np.asarray(a, dtype=np.float64)


def _len(v):
    return np.sqrt(np.einsum("...i,...i->...", v, v))


def normalize(v):
    v = _f(v)
    return v / np.linalg.norm(v)


def frame(axis, up=(0, 0, 1)):
    """A rotation (columns x, y, z) whose z is `axis` and whose y leans toward `up`."""
    z = normalize(axis)
    up = _f(up)
    if abs(np.dot(z, normalize(up))) > 0.99:
        up = np.array([1.0, 0, 0]) if abs(z[0]) < 0.9 else np.array([0, 1.0, 0])
    x = np.cross(up, z)
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    return np.stack([x, y, z], axis=1)


def rot(x=0.0, y=0.0, z=0.0):
    """Rotation matrix from XYZ Euler angles (radians), applied X then Y then Z."""
    cx, sx, cy, sy, cz, sz = np.cos(x), np.sin(x), np.cos(y), np.sin(y), np.cos(z), np.sin(z)
    rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return rz @ ry @ rx


def smin(a, b, k):
    if k <= 0:
        return np.minimum(a, b)
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return b + (a - b) * h - k * h * (1.0 - h)


def smax(a, b, k):
    return -smin(-a, -b, k)


class Shape:
    bone = None

    def bounds(self):
        raise NotImplementedError

    def eval(self, p):
        raise NotImplementedError

    def __call__(self, p):
        return self.eval(_f(p))


class Prim(Shape):
    """A primitive with an optional bone (for skin weights) and a tag (for painting)."""

    def __init__(self, bone=None, tag=None):
        self.bone = bone
        self.tag = tag


class Sphere(Prim):
    def __init__(self, c, r, **kw):
        super().__init__(**kw)
        self.c, self.r = _f(c), float(r)

    def bounds(self):
        return self.c - self.r, self.c + self.r

    def eval(self, p):
        return _len(p - self.c) - self.r


class Ellipsoid(Prim):
    """Radii along the columns of `R` (a rotation; identity by default)."""

    def __init__(self, c, radii, R=None, **kw):
        super().__init__(**kw)
        self.c, self.r = _f(c), _f(radii)
        self.R = np.eye(3) if R is None else _f(R)

    def bounds(self):
        ext = np.abs(self.R) @ self.r
        return self.c - ext, self.c + ext

    def eval(self, p):
        q = (p - self.c) @ self.R
        k0 = _len(q / self.r)
        k1 = _len(q / (self.r * self.r))
        return np.where(k1 > 1e-9, k0 * (k0 - 1.0) / np.maximum(k1, 1e-9), -self.r.min())


class Capsule(Prim):
    def __init__(self, a, b, r, **kw):
        super().__init__(**kw)
        self.a, self.b, self.r = _f(a), _f(b), float(r)

    def bounds(self):
        return np.minimum(self.a, self.b) - self.r, np.maximum(self.a, self.b) + self.r

    def eval(self, p):
        pa, ba = p - self.a, self.b - self.a
        h = np.clip(pa @ ba / (ba @ ba), 0.0, 1.0)
        return _len(pa - h[:, None] * ba) - self.r


class RoundCone(Prim):
    """A capsule whose radius goes from `ra` at `a` to `rb` at `b`."""

    def __init__(self, a, b, ra, rb, **kw):
        super().__init__(**kw)
        self.a, self.b, self.ra, self.rb = _f(a), _f(b), float(ra), float(rb)

    def bounds(self):
        r = max(self.ra, self.rb)
        return np.minimum(self.a, self.b) - r, np.maximum(self.a, self.b) + r

    def eval(self, p):
        # Inigo Quilez's exact round cone.
        a, b, r1, r2 = self.a, self.b, self.ra, self.rb
        ba = b - a
        l2 = ba @ ba
        rr = r1 - r2
        a2 = l2 - rr * rr
        il2 = 1.0 / l2
        pa = p - a
        y = pa @ ba
        z = y - l2
        xv = pa * l2 - y[:, None] * ba
        x2 = np.einsum("ij,ij->i", xv, xv)
        y2 = y * y * l2
        z2 = z * z * l2
        k = np.sign(rr) * rr * rr * x2
        out = (np.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1
        cap_b = np.sign(z) * a2 * z2 > k
        cap_a = np.sign(y) * a2 * y2 < k
        out = np.where(cap_b, np.sqrt(x2 + z2) * il2 - r2, out)
        out = np.where(cap_a & ~cap_b, np.sqrt(x2 + y2) * il2 - r1, out)
        return out


class Loft(Prim):
    """A limb along a -> b with elliptical sections.

    `keys` are (t, rx, ry) or (t, rx, ry, ox, oy): radii along the frame's x
    and y and an offset of the section's centre, at t (0 at a, 1 at b),
    interpolated smoothly. `side` points the frame's x. The ends are capped
    with half-ellipsoids `cap` long.
    """

    def __init__(self, a, b, keys, side=(1, 0, 0), cap=None, **kw):
        super().__init__(**kw)
        self.a, self.b = _f(a), _f(b)
        axis = self.b - self.a
        self.L = float(np.linalg.norm(axis))
        z = axis / self.L
        x = _f(side) - z * (_f(side) @ z)
        x /= np.linalg.norm(x)
        y = np.cross(z, x)
        self.R = np.stack([x, y, z], axis=1)
        keys = [tuple(k) + (0.0, 0.0)[len(k) - 3 :] if len(k) == 3 else tuple(k) for k in keys]
        self.keys = np.array(sorted(keys), dtype=np.float64)
        self.cap = cap

    def _at(self, t):
        k = self.keys
        tt = k[:, 0]
        i = np.clip(np.searchsorted(tt, t) - 1, 0, len(tt) - 2)
        u = np.clip((t - tt[i]) / np.maximum(tt[i + 1] - tt[i], 1e-9), 0, 1)
        u = u * u * (3 - 2 * u)
        return [k[i, j] + (k[i + 1, j] - k[i, j]) * u for j in (1, 2, 3, 4)]

    def bounds(self):
        r = np.max(np.abs(self.keys[:, 1:3]) + np.abs(self.keys[:, 3:5]).max(axis=1, keepdims=True))
        cap = self.cap if self.cap is not None else r
        lo = np.minimum(self.a, self.b) - max(r, cap)
        hi = np.maximum(self.a, self.b) + max(r, cap)
        return lo, hi

    def eval(self, p):
        q = (p - self.a) @ self.R
        t = q[:, 2] / self.L
        tc = np.clip(t, 0.0, 1.0)
        rx, ry, ox, oy = self._at(tc)
        cap0 = self.cap if self.cap is not None else 0.5 * (self.keys[0, 1] + self.keys[0, 2])
        cap1 = self.cap if self.cap is not None else 0.5 * (self.keys[-1, 1] + self.keys[-1, 2])
        rz = np.where(t < 0.5, cap0, cap1)
        dz = (t - tc) * self.L
        loc = np.stack([q[:, 0] - ox, q[:, 1] - oy, dz], axis=1)
        r = np.stack([rx, ry, rz], axis=1)
        k0 = _len(loc / r)
        k1 = _len(loc / (r * r))
        return np.where(k1 > 1e-9, k0 * (k0 - 1.0) / np.maximum(k1, 1e-9), -np.minimum(rx, ry))


class Profile(Prim):
    """A body along a -> b with superelliptic sections that are deeper in front or behind.

    `keys` are (t, half width, front, back, centre shift): at t (0 at a,
    1 at b) the section reaches `half width` along `side`, `front` toward
    `front` and `back` away from it, from a centre shifted toward the front
    by `centre shift`. `n` is the superellipse exponent (2 = an ellipse,
    larger = squarer), front and back. The ends are capped `cap` long.
    """

    def __init__(self, a, b, keys, side=(1, 0, 0), front=(0, -1, 0), n=(2.0, 2.0), cap=(0.03, 0.03), **kw):
        super().__init__(**kw)
        self.a, self.b = _f(a), _f(b)
        axis = self.b - self.a
        self.L = float(np.linalg.norm(axis))
        z = axis / self.L
        x = _f(side) - z * (_f(side) @ z)
        x /= np.linalg.norm(x)
        y = _f(front) - z * (_f(front) @ z) - x * (_f(front) @ x)
        y /= np.linalg.norm(y)
        self.R = np.stack([x, y, z], axis=1)
        keys = [tuple(k) + (0.0,) * (5 - len(k)) for k in keys]
        self.keys = np.array(sorted(keys), dtype=np.float64)
        self.n = n
        self.cap = cap

    def _at(self, t):
        k = self.keys
        tt = k[:, 0]
        i = np.clip(np.searchsorted(tt, t) - 1, 0, len(tt) - 2)
        u = np.clip((t - tt[i]) / np.maximum(tt[i + 1] - tt[i], 1e-9), 0, 1)
        # Catmull-Rom through the keys, so the outline has no corners.
        i0 = np.clip(i - 1, 0, len(tt) - 1)
        i3 = np.clip(i + 2, 0, len(tt) - 1)
        out = []
        for j in (1, 2, 3, 4):
            p0, p1, p2, p3 = k[i0, j], k[i, j], k[i + 1, j], k[i3, j]
            out.append(
                0.5
                * (
                    2 * p1
                    + (-p0 + p2) * u
                    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u
                    + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u
                )
            )
        return out

    def bounds(self):
        r = np.max(self.keys[:, 1:4]) + np.max(np.abs(self.keys[:, 4]))
        c = max(self.cap)
        return np.minimum(self.a, self.b) - max(r, c), np.maximum(self.a, self.b) + max(r, c)

    def eval(self, p):
        q = (p - self.a) @ self.R
        t = q[:, 2] / self.L
        tc = np.clip(t, 0.0, 1.0)
        w, fr, bk, cy = self._at(tc)
        y = q[:, 1] - cy
        infront = y > 0
        ry = np.where(infront, fr, bk)
        n = np.where(infront, self.n[0], self.n[1])
        u = np.abs(q[:, 0]) / w
        v = np.abs(y) / ry
        k = (u**n + v**n) ** (1.0 / n)
        dz = (t - tc) * self.L
        cap = np.where(t < 0.5, self.cap[0], self.cap[1])
        k3 = np.sqrt(k * k + (dz / cap) ** 2)
        scale = np.minimum(np.minimum(w, ry), np.where(dz != 0, cap, 1e9))
        return (k3 - 1.0) * scale


class RoundBox(Prim):
    def __init__(self, c, half, r=0.0, R=None, **kw):
        super().__init__(**kw)
        self.c, self.h, self.r = _f(c), _f(half), float(r)
        self.R = np.eye(3) if R is None else _f(R)

    def bounds(self):
        ext = np.abs(self.R) @ (self.h + self.r)
        return self.c - ext, self.c + ext

    def eval(self, p):
        q = np.abs((p - self.c) @ self.R) - self.h
        return _len(np.maximum(q, 0.0)) + np.minimum(q.max(axis=1), 0.0) - self.r


class Plane(Prim):
    """Half-space below the plane through `c` with normal `n` (inside = against n)."""

    def __init__(self, c, n, **kw):
        super().__init__(**kw)
        self.c, self.n = _f(c), normalize(n)

    def bounds(self):
        return np.full(3, -BIG), np.full(3, BIG)

    def eval(self, p):
        return (p - self.c) @ self.n


class Fn(Prim):
    """Any distance function with explicit bounds."""

    def __init__(self, fn, lo, hi, **kw):
        super().__init__(**kw)
        self.fn, self.lo, self.hi = fn, _f(lo), _f(hi)

    def bounds(self):
        return self.lo, self.hi

    def eval(self, p):
        return self.fn(p)


def _inside(p, lo, hi):
    return np.all((p >= lo) & (p <= hi), axis=1)


class Union(Shape):
    """Children blended with radius `k` (0 = hard)."""

    def __init__(self, *children, k=0.0):
        self.children = [c for c in children if c is not None]
        self.k = float(k)

    def bounds(self):
        bs = [c.bounds() for c in self.children]
        return np.min([b[0] for b in bs], axis=0), np.max([b[1] for b in bs], axis=0)

    def eval(self, p):
        d = np.full(len(p), BIG, dtype=np.float64)
        for c in self.children:
            lo, hi = c.bounds()
            m = _inside(p, lo - self.k - 1e-3, hi + self.k + 1e-3)
            if not m.any():
                continue
            d[m] = smin(d[m], c.eval(p[m]), self.k)
        return d

    def prims(self):
        for c in self.children:
            if isinstance(c, Union):
                yield from c.prims()
            else:
                yield c


class Subtract(Shape):
    def __init__(self, a, b, k=0.0):
        self.a, self.b, self.k = a, b, float(k)
        self.bone = getattr(a, "bone", None)

    def bounds(self):
        return self.a.bounds()

    def eval(self, p):
        d = self.a.eval(p)
        lo, hi = self.b.bounds()
        m = _inside(p, lo - self.k - 1e-3, hi + self.k + 1e-3)
        if m.any():
            d[m] = smax(d[m], -self.b.eval(p[m]), self.k)
        return d


class Intersect(Shape):
    def __init__(self, a, b, k=0.0):
        self.a, self.b, self.k = a, b, float(k)
        self.bone = getattr(a, "bone", None)

    def bounds(self):
        la, ha = self.a.bounds()
        lb, hb = self.b.bounds()
        return np.maximum(la, lb), np.minimum(ha, hb)

    def eval(self, p):
        return smax(self.a.eval(p), self.b.eval(p), self.k)


class Offset(Shape):
    """Grows (t > 0) or shrinks a shape; `t` may be a function of the points."""

    def __init__(self, a, t, reach=None):
        self.a, self.t = a, t
        self.reach = reach if reach is not None else (t if not callable(t) else 0.05)
        self.bone = getattr(a, "bone", None)

    def bounds(self):
        lo, hi = self.a.bounds()
        return lo - self.reach, hi + self.reach

    def eval(self, p):
        t = self.t(p) if callable(self.t) else self.t
        return self.a.eval(p) - t


class Shell(Shape):
    """A skin `t` thick around the surface of a shape (centred on it)."""

    def __init__(self, a, t):
        self.a, self.t = a, t
        self.bone = getattr(a, "bone", None)

    def bounds(self):
        lo, hi = self.a.bounds()
        return lo - self.t, hi + self.t

    def eval(self, p):
        return np.abs(self.a.eval(p)) - self.t


class Bump:
    """A smooth, compact push of the surface: `amp` metres out (negative = in) at `c`, fading to 0 at `radii`."""

    def __init__(self, c, radii, amp, R=None):
        self.c, self.r, self.amp = _f(c), _f(radii), float(amp)
        self.R = np.eye(3) if R is None else _f(R)

    def bounds(self):
        ext = np.abs(self.R) @ self.r
        return self.c - ext, self.c + ext

    def eval(self, p):
        q = (p - self.c) @ self.R / self.r
        s = np.clip(1.0 - np.einsum("ij,ij->i", q, q), 0.0, 1.0)
        return self.amp * s * s


class Displace(Shape):
    """A shape with bumps pushed into its surface (sculpting with inflate and deflate)."""

    def __init__(self, a, *bumps):
        self.a, self.bumps = a, bumps
        self.bone = getattr(a, "bone", None)

    def bounds(self):
        lo, hi = self.a.bounds()
        out = max([max(b.amp, 0) for b in self.bumps] + [0])
        return lo - out, hi + out

    def eval(self, p):
        d = self.a.eval(p)
        for b in self.bumps:
            lo, hi = b.bounds()
            m = _inside(p, lo, hi)
            if m.any():
                d[m] -= b.eval(p[m])
        return d


def gradient(shape, p, h=5e-4):
    p = _f(p)
    g = np.zeros_like(p)
    for i in range(3):
        e = np.zeros(3)
        e[i] = h
        g[:, i] = shape.eval(p + e) - shape.eval(p - e)
    n = np.linalg.norm(g, axis=1, keepdims=True)
    return g / np.maximum(n, 1e-12)


def project(shape, p, steps=3):
    """Moves points onto the shape's surface (Newton steps along the gradient)."""
    p = _f(p).copy()
    for _ in range(steps):
        d = shape.eval(p)
        p -= d[:, None] * gradient(shape, p)
    return p


def sample(shape, voxel, band=3, coarse=4, pad=None):
    """The distance field on a grid: (values, origin). Exact only near the surface.

    A coarse grid finds where the surface is; the fine grid is evaluated only
    in a band around it, clamped to `band` voxels either side.
    """
    lo, hi = shape.bounds()
    pad = pad if pad is not None else (band + coarse + 2) * voxel
    lo, hi = lo - pad, hi + pad
    cv = voxel * coarse
    cshape = np.ceil((hi - lo) / cv).astype(int) + 1
    ax = [lo[i] + cv * np.arange(cshape[i]) for i in range(3)]
    cp = np.stack(np.meshgrid(*ax, indexing="ij"), axis=-1).reshape(-1, 3)
    cd = shape.eval(cp).reshape(cshape)
    near = np.abs(cd) < cv * 1.75 + band * voxel
    # Dilate by one coarse cell so the band never ends against the surface.
    grow = near.copy()
    for axis in range(3):
        grow |= np.roll(near, 1, axis) | np.roll(near, -1, axis)
    fshape = cshape * coarse
    far = (np.sign(cd) * band * voxel).astype(np.float32)
    d = np.repeat(np.repeat(np.repeat(far, coarse, 0), coarse, 1), coarse, 2)
    mask = np.repeat(np.repeat(np.repeat(grow, coarse, 0), coarse, 1), coarse, 2)
    # Fine voxel centres line up with coarse ones at every `coarse`-th sample.
    idx = np.argwhere(mask)
    for start in range(0, len(idx), 2_000_000):
        part = idx[start : start + 2_000_000]
        pts = lo + part * voxel
        vals = shape.eval(pts)
        d[part[:, 0], part[:, 1], part[:, 2]] = np.clip(vals, -band * voxel, band * voxel)
    return d, lo
