"""A scene of scenery, and its file: a compact .glb the client reads (render/env/model.ts).

A scene holds props defined once and placed many times (`define`, `place`; a prop can place others within it), geometry of its own (`add`), each at a
level of detail (always, from close by, or from afar: `extras.lod` on its node), groups the
client moves (`anim`) and named places (`anchor`). In the file every mesh is one material class (`extras.c`), smooth
or faceted (`extras.s`), with positions quantized to 16 bits over its box (KHR_mesh_quantization; the node's matrix
puts them back; a prop placed many times is one node with EXT_mesh_gpu_instancing), a colour per vertex (linear RGB, alpha the sway weight) and no normals: the client makes them,
faceted or smooth across shared vertices.
"""

import json
import math
import struct

import numpy as np

import kit


def _group(parts, cell=0.0):
    """Parts joined by class and shading (and, with `cell`, by the square of ground that size their middle is
    over, so what is drawn can be culled a square at a time)."""
    out = {}
    for p in parts:
        if p is None or not len(p.F):
            continue
        where = None
        if cell:
            mid = (p.P.min(axis=0) + p.P.max(axis=0)) / 2
            where = (math.floor(mid[0] / cell), math.floor(mid[2] / cell))
        out.setdefault((p.cls, p.smooth, where), []).append(p)
    return [kit.join(v) for v in out.values()]


# When a part of a scene is drawn: always, only from close by (small props, interiors), or only from afar (a
# plain stand-in for something intricate).
BASE, NEAR, FAR = 0, 1, 2


class Scene:
    def __init__(self, cell=0.0):
        """`cell`: the scene's own geometry is stored in squares of ground this size (0: all in one)."""
        self.cell = cell
        # The level what is added and placed belongs to, unless it says otherwise.
        self.level = BASE
        self.defs = {}
        self.placed = []
        self.own = []
        self.anims = []
        self.anchors = []

    def define(self, name, parts):
        """A prop, to `place`: meshes, and (name, matrix) pairs placing other props within it."""
        meshes = [p for p in parts if isinstance(p, kit.Mesh)]
        self.defs[name] = (_group(meshes), [p for p in parts if isinstance(p, tuple)])

    def place(self, name, m, level=None):
        m = np.asarray(m, dtype=float)
        level = self.level if level is None else level
        meshes, within = self.defs[name]
        if meshes:
            self.placed.append((name, m, level))
        for sub, local in within:
            self.place(sub, m @ local, level)

    def add(self, parts, m=None, level=None):
        """Geometry of the scene's own (drawn once); (name, matrix) pairs among it place props."""
        parts = parts if isinstance(parts, list) else [parts]
        level = self.level if level is None else level
        for p in parts:
            if p is None:
                continue
            if isinstance(p, tuple):
                self.place(p[0], p[1] if m is None else m @ p[1], level)
            else:
                self.own.append((p if m is None else p.xf(m), level))

    def anim(self, name, parts, m=None):
        """A group the client moves, with its pivot at `m`."""
        self.anims.append((name, _group(parts), np.eye(4) if m is None else np.asarray(m, dtype=float)))

    def anchor(self, name, m, **extras):
        """A named place (a matrix) with whatever the client needs to know about it."""
        self.anchors.append((name, np.asarray(m, dtype=float), extras))

    def triangles(self):
        """Triangles drawn at each level (the scene's own and its placed props), and in what moves."""
        out = {"base": 0, "near": 0, "far": 0}
        names = ("base", "near", "far")
        for p, level in self.own:
            out[names[level]] += len(p.F)
        for n, _, level in self.placed:
            out[names[level]] += sum(len(p.F) for p in self.defs[n][0])
        out["anim"] = sum(sum(len(p.F) for p in parts) for _, parts, _ in self.anims)
        out["stored"] = sum(len(p.F) for p, _ in self.own) + sum(sum(len(p.F) for p in d[0]) for d in self.defs.values()) + out["anim"]
        return out

    def write(self, path):
        w = _Writer()
        nodes = []
        for level in (BASE, NEAR, FAR):
            extras = {"extras": {"lod": level}} if level else {}
            for mesh in _group([p for p, at in self.own if at == level], self.cell):
                index, dequant = w.mesh(mesh)
                nodes.append(w.node({"mesh": index, "matrix": _flat(dequant), **extras}))
            by_prop = {}
            for name, m, at in self.placed:
                if at == level:
                    by_prop.setdefault(name, []).append(m)
            for name, matrices in by_prop.items():
                for mesh in self.defs[name][0]:
                    index, dequant = w.mesh(mesh)
                    if len(matrices) == 1:
                        nodes.append(w.node({"mesh": index, "matrix": _flat(matrices[0] @ dequant), **extras}))
                    else:
                        nodes.append(w.instances(index, [m @ dequant for m in matrices], extras))
        for name, parts, m in self.anims:
            children = [w.mesh_node(p, np.eye(4)) for p in parts]
            nodes.append(w.node({"name": name, "matrix": _flat(m), "children": children, "extras": {"anim": name}}))
        for name, m, extras in self.anchors:
            nodes.append(w.node({"name": name, "matrix": _flat(m), "extras": {"anchor": name, **extras}}))
        return w.save(path, nodes)


def _flat(m):
    return [float(f"{v:.6g}") for v in np.asarray(m).T.reshape(-1)]


def _trs(m):
    """A matrix as a translation, a rotation (a quaternion: x, y, z, w) and a scale (one axis negative if it
    mirrors)."""
    a = np.asarray(m, dtype=float)[:3, :3]
    scale = np.linalg.norm(a, axis=0)
    if np.linalg.det(a) < 0:
        scale[0] = -scale[0]
    r = a / scale
    w = math.sqrt(max(0.0, 1 + r[0, 0] + r[1, 1] + r[2, 2])) / 2
    if w > 1e-6:
        q = [(r[2, 1] - r[1, 2]) / (4 * w), (r[0, 2] - r[2, 0]) / (4 * w), (r[1, 0] - r[0, 1]) / (4 * w), w]
    else:
        # A half turn: the axis is the largest diagonal's.
        i = int(np.argmax(np.diag(r)))
        j, k = (i + 1) % 3, (i + 2) % 3
        x = math.sqrt(max(0.0, 1 + r[i, i] - r[j, j] - r[k, k])) / 2
        q = [0.0, 0.0, 0.0, (r[k, j] - r[j, k]) / (4 * x)]
        q[i], q[j], q[k] = x, (r[j, i] + r[i, j]) / (4 * x), (r[k, i] + r[i, k]) / (4 * x)
    return np.asarray(m)[:3, 3].tolist(), q, scale.tolist()


def _weld(mesh):
    """Vertices shared where they can be: everywhere they coincide on a faceted mesh; a smooth one keeps its own."""
    P = mesh.P
    lo, hi = P.min(axis=0), P.max(axis=0)
    centre = (lo + hi) / 2
    half = np.maximum((hi - lo) / 2, 1e-6)
    q = np.round((P - centre) / half * 32767).astype(np.int16)
    c = np.round(np.clip(mesh.C, 0, 1) * 255).astype(np.uint8)
    s = np.round(np.clip(mesh.W, 0, 1) * 255).astype(np.uint8)
    F = mesh.F
    if not mesh.smooth:
        key = np.concatenate([q.astype(np.int32), c.astype(np.int32), s[:, None].astype(np.int32)], axis=1)
        _, first, inverse = np.unique(key, axis=0, return_index=True, return_inverse=True)
        q, c, s = q[first], c[first], s[first]
        F = inverse.reshape(-1)[F]
    used = np.unique(F)
    remap = np.zeros(len(q), dtype=np.int64)
    remap[used] = np.arange(len(used))
    dequant = kit.T(*centre) @ kit.S(*half)
    return q[used], c[used], s[used], remap[F], dequant


class _Writer:
    def __init__(self):
        self.bin = bytearray()
        # Every mesh's vertices share one view, their indices another (a third for meshes too big for 16 bits).
        self.vertices = bytearray()
        self.small = bytearray()
        self.large = bytearray()
        self.views = [None, None, None]
        # Meshes already written (a prop placed at two levels is stored once).
        self.stored = {}
        self.accessors = []
        self.meshes = []
        self.nodes = []

    def _view(self, data, target, stride=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        view = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(data)}
        if target:
            view["target"] = target
        if stride:
            view["byteStride"] = stride
        self.bin += data
        self.views.append(view)
        return len(self.views) - 1

    def mesh(self, mesh):
        if id(mesh) in self.stored:
            return self.stored[id(mesh)]
        q, c, s, F, dequant = _weld(mesh)
        n = len(q)
        vertex = np.zeros(n, dtype=[("p", "<i2", 3), ("pad", "<u2"), ("c", "u1", 3), ("s", "u1")])
        vertex["p"], vertex["c"], vertex["s"] = q, c, s
        first = len(self.vertices) // 12
        self.vertices += vertex.tobytes()
        self.accessors.append({"bufferView": 0, "byteOffset": first * 12, "componentType": 5122, "normalized": True, "count": n, "type": "VEC3", "min": q.min(axis=0).tolist(), "max": q.max(axis=0).tolist()})
        self.accessors.append({"bufferView": 0, "byteOffset": first * 12 + 8, "componentType": 5121, "normalized": True, "count": n, "type": "VEC4"})
        small = n <= 65535
        index = F.astype("<u2" if small else "<u4").reshape(-1)
        store = self.small if small else self.large
        while len(store) % 4:
            store.append(0)
        self.accessors.append({"bufferView": 1 if small else 2, "byteOffset": len(store), "componentType": 5123 if small else 5125, "count": len(index), "type": "SCALAR"})
        store += index.tobytes()
        a = len(self.accessors)
        self.meshes.append({"primitives": [{"attributes": {"POSITION": a - 3, "COLOR_0": a - 2}, "indices": a - 1}], "extras": {"c": mesh.cls, "s": 1 if mesh.smooth else 0}})
        self.stored[id(mesh)] = (len(self.meshes) - 1, dequant)
        return self.stored[id(mesh)]

    def mesh_node(self, mesh, m):
        index, dequant = self.mesh(mesh)
        return self.node({"mesh": index, "matrix": _flat(m @ dequant)})

    def instances(self, mesh, matrices, more=None):
        """A node drawing a mesh once per matrix (EXT_mesh_gpu_instancing: a translation, a rotation and a scale
        each)."""
        t, r, sc = zip(*(_trs(m) for m in matrices))
        accessors = []
        for data, kind in ((t, "VEC3"), (r, "VEC4"), (sc, "VEC3")):
            view = self._view(np.asarray(data, dtype="<f4").tobytes(), None)
            self.accessors.append({"bufferView": view, "componentType": 5126, "count": len(matrices), "type": kind})
            accessors.append(len(self.accessors) - 1)
        attributes = {"TRANSLATION": accessors[0], "ROTATION": accessors[1], "SCALE": accessors[2]}
        return self.node({"mesh": mesh, "extensions": {"EXT_mesh_gpu_instancing": {"attributes": attributes}}, **(more or {})})

    def node(self, node):
        self.nodes.append(node)
        return len(self.nodes) - 1

    def save(self, path, roots):
        for slot, (data, target, stride) in enumerate(((self.vertices, 34962, 12), (self.small, 34963, None), (self.large, 34963, None))):
            self._view(bytes(data) if data else bytes(4), target, stride)
            self.views[slot] = self.views.pop()
        while len(self.bin) % 4:
            self.bin.append(0)
        doc = {
            "asset": {"version": "2.0", "generator": "shifty art/scene"},
            "extensionsUsed": ["KHR_mesh_quantization", "EXT_mesh_gpu_instancing"],
            "extensionsRequired": ["KHR_mesh_quantization"],
            "scene": 0,
            "scenes": [{"nodes": roots}],
            "nodes": self.nodes,
            "meshes": self.meshes,
            "accessors": self.accessors,
            "bufferViews": self.views,
            "buffers": [{"byteLength": len(self.bin)}],
        }
        text = json.dumps(doc, separators=(",", ":")).encode()
        text += b" " * (-len(text) % 4)
        total = 12 + 8 + len(text) + 8 + len(self.bin)
        with open(path, "wb") as f:
            f.write(struct.pack("<4sII", b"glTF", 2, total))
            f.write(struct.pack("<I4s", len(text), b"JSON"))
            f.write(text)
            f.write(struct.pack("<I4s", len(self.bin), b"BIN\x00"))
            f.write(self.bin)
        return total
