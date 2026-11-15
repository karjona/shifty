"""A scene of scenery, and its file: a compact .glb the client reads (render/env/model.ts).

A scene holds props defined once and placed many times (`define`, `place`), geometry of its own (`add`), groups the
client moves (`anim`) and named places (`anchor`). In the file every mesh is one material class (`extras.c`), smooth
or faceted (`extras.s`), with positions quantized to 16 bits over its box (KHR_mesh_quantization; the node's matrix
puts them back), a colour per vertex (linear RGB, alpha the sway weight) and no normals: the client makes them,
faceted or smooth across shared vertices.
"""

import json
import struct

import numpy as np

import kit


def _group(parts):
    """Parts joined by class and shading."""
    out = {}
    for p in parts:
        if p is None or not len(p.F):
            continue
        out.setdefault((p.cls, p.smooth), []).append(p)
    return [kit.join(v) for v in out.values()]


class Scene:
    def __init__(self):
        self.defs = {}
        self.placed = []
        self.own = []
        self.anims = []
        self.anchors = []

    def define(self, name, parts):
        """A prop, to `place`."""
        self.defs[name] = _group(parts)

    def place(self, name, m):
        self.placed.append((name, np.asarray(m, dtype=float)))

    def add(self, parts, m=None):
        """Geometry of the scene's own (drawn once)."""
        parts = parts if isinstance(parts, list) else [parts]
        self.own += [p if m is None else p.xf(m) for p in parts if p is not None]

    def anim(self, name, parts, m=None):
        """A group the client moves, with its pivot at `m`."""
        self.anims.append((name, _group(parts), np.eye(4) if m is None else np.asarray(m, dtype=float)))

    def anchor(self, name, m, **extras):
        """A named place (a matrix) with whatever the client needs to know about it."""
        self.anchors.append((name, np.asarray(m, dtype=float), extras))

    def triangles(self):
        own = sum(len(p.F) for p in self.own)
        placed = sum(sum(len(p.F) for p in self.defs[n]) for n, _ in self.placed)
        unique = sum(sum(len(p.F) for p in d) for d in self.defs.values())
        anim = sum(sum(len(p.F) for p in parts) for _, parts, _ in self.anims)
        return {"own": own, "placed": placed, "defs": unique, "anim": anim, "drawn": own + placed + anim}

    def write(self, path):
        w = _Writer()
        nodes = []
        for mesh in _group(self.own):
            nodes.append(w.mesh_node(mesh, np.eye(4)))
        cache = {}
        for name, m in self.placed:
            if name not in cache:
                cache[name] = [w.mesh(p) for p in self.defs[name]]
            for index, dequant in cache[name]:
                nodes.append(w.node({"mesh": index, "matrix": _flat(m @ dequant)}))
        for name, parts, m in self.anims:
            children = [w.mesh_node(p, np.eye(4)) for p in parts]
            nodes.append(w.node({"name": name, "matrix": _flat(m), "children": children, "extras": {"anim": name}}))
        for name, m, extras in self.anchors:
            nodes.append(w.node({"name": name, "matrix": _flat(m), "extras": {"anchor": name, **extras}}))
        return w.save(path, nodes)


def _flat(m):
    return [float(f"{v:.6g}") for v in np.asarray(m).T.reshape(-1)]


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
        self.views = []
        self.accessors = []
        self.meshes = []
        self.nodes = []

    def _view(self, data, target, stride=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        view = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(data), "target": target}
        if stride:
            view["byteStride"] = stride
        self.bin += data
        self.views.append(view)
        return len(self.views) - 1

    def mesh(self, mesh):
        q, c, s, F, dequant = _weld(mesh)
        n = len(q)
        vertex = np.zeros(n, dtype=[("p", "<i2", 3), ("pad", "<u2"), ("c", "u1", 3), ("s", "u1")])
        vertex["p"], vertex["c"], vertex["s"] = q, c, s
        view = self._view(vertex.tobytes(), 34962, 12)
        self.accessors.append({"bufferView": view, "byteOffset": 0, "componentType": 5122, "normalized": True, "count": n, "type": "VEC3", "min": q.min(axis=0).tolist(), "max": q.max(axis=0).tolist()})
        self.accessors.append({"bufferView": view, "byteOffset": 8, "componentType": 5121, "normalized": True, "count": n, "type": "VEC4"})
        small = n <= 65535
        index = F.astype("<u2" if small else "<u4").reshape(-1)
        iview = self._view(index.tobytes(), 34963)
        self.accessors.append({"bufferView": iview, "componentType": 5123 if small else 5125, "count": len(index), "type": "SCALAR"})
        a = len(self.accessors)
        self.meshes.append({"primitives": [{"attributes": {"POSITION": a - 3, "COLOR_0": a - 2}, "indices": a - 1}], "extras": {"c": mesh.cls, "s": 1 if mesh.smooth else 0}})
        return len(self.meshes) - 1, dequant

    def mesh_node(self, mesh, m):
        index, dequant = self.mesh(mesh)
        return self.node({"mesh": index, "matrix": _flat(m @ dequant)})

    def node(self, node):
        self.nodes.append(node)
        return len(self.nodes) - 1

    def save(self, path, roots):
        while len(self.bin) % 4:
            self.bin.append(0)
        doc = {
            "asset": {"version": "2.0", "generator": "shifty art/env"},
            "extensionsUsed": ["KHR_mesh_quantization"],
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
