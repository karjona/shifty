"""The armature and skin weights."""

import bpy
import numpy as np
from mathutils import Vector

import blend

# The client's bone order (apps/client/src/render/rider/skeleton.ts).
BONES = [
    "root", "hips", "spine", "chest", "neck", "head",
    "clavicle.L", "upperarm.L", "forearm.L", "hand.L", "fingers.L",
    "clavicle.R", "upperarm.R", "forearm.R", "hand.R", "fingers.R",
    "thigh.L", "shin.L", "foot.L", "toes.L",
    "thigh.R", "shin.R", "foot.R", "toes.R",
]  # fmt: skip

PARENT = {
    "root": None, "hips": "root", "spine": "hips", "chest": "spine", "neck": "chest", "head": "neck",
    "clavicle.L": "chest", "upperarm.L": "clavicle.L", "forearm.L": "upperarm.L", "hand.L": "forearm.L",
    "fingers.L": "hand.L",
    "clavicle.R": "chest", "upperarm.R": "clavicle.R", "forearm.R": "upperarm.R", "hand.R": "forearm.R",
    "fingers.R": "hand.R",
    "thigh.L": "hips", "shin.L": "thigh.L", "foot.L": "shin.L", "toes.L": "foot.L",
    "thigh.R": "hips", "shin.R": "thigh.R", "foot.R": "shin.R", "toes.R": "foot.R",
}  # fmt: skip


def gltf_name(bone):
    """glTF node names lose dots in three.js, so bones are written with underscores."""
    return bone.replace(".", "_")


def armature(joints, tails, name="rig"):
    data = bpy.data.armatures.new(name)
    obj = blend.link(bpy.data.objects.new(name, data))
    blend.select_only(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    for b in BONES:
        eb = data.edit_bones.new(gltf_name(b))
        eb.head = Vector(joints[b])
        eb.tail = Vector(tails[b])
        eb.roll = 0
        eb.use_deform = b != "root"
    for b in BONES:
        if PARENT[b]:
            data.edit_bones[gltf_name(b)].parent = data.edit_bones[gltf_name(PARENT[b])]
    bpy.ops.object.mode_set(mode="OBJECT")
    return obj


def auto_weights(mesh, arm):
    """Bone heat weights, at most four bones per vertex."""
    blend.deselect()
    mesh.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    limit(mesh)


def bind(mesh, arm):
    """Parents a mesh that already has its vertex groups to the armature."""
    mesh.parent = arm
    m = mesh.modifiers.new("rig", "ARMATURE")
    m.object = arm


def weights(mesh):
    """Vertex weights as an (n, bones) array, in BONES order."""
    n = len(mesh.data.vertices)
    w = np.zeros((n, len(BONES)))
    index = {g.index: BONES.index(g.name.replace("_", ".")) for g in mesh.vertex_groups
             if g.name.replace("_", ".") in BONES}
    for v in mesh.data.vertices:
        for g in v.groups:
            if g.group in index:
                w[v.index, index[g.group]] = g.weight
    return w


def set_weights(mesh, w):
    for g in list(mesh.vertex_groups):
        mesh.vertex_groups.remove(g)
    groups = [mesh.vertex_groups.new(name=gltf_name(b)) for b in BONES]
    for i, row in enumerate(w):
        for j in np.nonzero(row > 1e-4)[0]:
            groups[j].add([i], float(row[j]), "REPLACE")


def limit(mesh, n=4):
    w = weights(mesh)
    order = np.argsort(-w, axis=1)
    keep = np.zeros_like(w, dtype=bool)
    np.put_along_axis(keep, order[:, :n], True, axis=1)
    w = np.where(keep, w, 0)
    s = w.sum(axis=1, keepdims=True)
    w = np.where(s > 0, w / np.maximum(s, 1e-9), 0)
    set_weights(mesh, w)


def transfer(src, dst, k=4, rigid=None):
    """Weights for `dst` from the nearest surface of `src` (blended over k nearest vertices).

    `rigid` names a bone that takes the whole garment instead.
    """
    if rigid:
        w = np.zeros((len(dst.data.vertices), len(BONES)))
        w[:, BONES.index(rigid)] = 1
        set_weights(dst, w)
        return
    from mathutils.kdtree import KDTree

    sv = blend.verts(src)
    tree = KDTree(len(sv))
    for i, v in enumerate(sv):
        tree.insert(v, i)
    tree.balance()
    sw = weights(src)
    dv = blend.verts(dst)
    out = np.zeros((len(dv), len(BONES)))
    for i, v in enumerate(dv):
        near = tree.find_n(v, k)
        ds = np.array([d for _, _, d in near])
        ws = 1.0 / np.maximum(ds, 1e-4) ** 2
        for (_, j, _), wj in zip(near, ws):
            out[i] += sw[j] * wj
    out /= np.maximum(out.sum(axis=1, keepdims=True), 1e-9)
    set_weights(dst, out)
    limit(dst)


def sculpt_weights(mesh, chains, joints, tails, tau=0.01, reach=0.03, side=0.1):
    """Weights from the sculpt: each vertex follows the chain of body parts it is nearest
    (blended over `tau` where parts meet), and within a chain the bones it lies along
    (blended over `reach` around the joints)."""
    v = blend.verts(mesh)
    names = list(chains)
    D = np.stack([chains[c][0].eval(v) for c in names], axis=1)
    rel = D - D.min(axis=1, keepdims=True)
    cw = np.where(rel < 5 * tau, np.exp(-rel / tau), 0.0)
    cw /= cw.sum(axis=1, keepdims=True)
    W = np.zeros((len(v), len(BONES)))
    for ci, c in enumerate(names):
        bones = chains[c][1]
        S = []
        for b in bones:
            a, t = np.asarray(joints[b]), np.asarray(tails[b])
            L = np.linalg.norm(t - a)
            u = (t - a) / L
            s = (v - a) @ u
            r = np.linalg.norm((v - a) - s[:, None] * u, axis=1)
            first, last = b == bones[0], b == bones[-1]
            before = 0 if first else np.maximum(0, -s)
            after = 0 if last else np.maximum(0, s - L)
            S.append(np.exp(-(before + after) / reach) * np.exp(-r / side))
        S = np.stack(S, axis=1)
        S /= np.maximum(S.sum(axis=1, keepdims=True), 1e-12)
        for j, b in enumerate(bones):
            W[:, BONES.index(b)] += cw[:, ci] * S[:, j]
    set_weights(mesh, W)
    limit(mesh)
