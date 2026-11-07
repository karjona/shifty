// Dev: `?bench=1` puts a frame-cost bench at `window.__shiftyBench`: it
// holds the frame on screen and draws it again and again, back to back, to
// time what drawing it costs (CPU to encode it, and until the GPU is done)
// with parts of it turned off.
import * as THREE from "three/webgpu";
import { renderOutput } from "three/tsl";
import type { World } from "../render/world.ts";

const isObject = (v: unknown): v is object => typeof v === "object" && v !== null;

export function installBench(world: World, pause: (on: boolean) => void): void {
  const renderer = world.renderer;
  const device: unknown = Reflect.get(renderer.backend, "device");
  const queue: unknown = isObject(device) ? Reflect.get(device, "queue") : null;
  const done = async () => {
    if (queue instanceof GPUQueue) await queue.onSubmittedWorkDone();
  };
  const nodes: unknown = Reflect.get(renderer, "_nodes");
  const nodeFrame: unknown = isObject(nodes) ? Reflect.get(nodes, "nodeFrame") : null;
  /** Draws again as a new frame (passes that draw once a frame draw again). */
  const draw = () => {
    if (isObject(nodeFrame)) {
      const update: unknown = Reflect.get(nodeFrame, "update");
      if (typeof update === "function") Reflect.apply(update, nodeFrame, []);
      Reflect.set(renderer.info, "frame", Reflect.get(nodeFrame, "frameId"));
    }
    world.draw();
  };
  const bench = async (n: number) => {
    pause(true);
    try {
      draw();
      await done();
      const t0 = performance.now();
      for (let i = 0; i < n; i++) draw();
      const t1 = performance.now();
      await done();
      const t2 = performance.now();
      return { cpu: +((t1 - t0) / n).toFixed(2), total: +((t2 - t0) / n).toFixed(2) };
    } finally {
      pause(false);
    }
  };

  const pipeline = world.cel.pipeline;
  const full = pipeline.outputNode;
  const scenePass: unknown = Reflect.get(world.cel, "scenePass");
  const colour = scenePass instanceof THREE.PassNode ? scenePass.getTextureNode("output") : null;
  /** The ink pass's output, before FXAA. */
  const rtt: unknown = Reflect.get(full, "textureNode");
  const inked: unknown = isObject(rtt) ? Reflect.get(rtt, "node") : null;
  const scale = world.renderScale;
  const hidden: THREE.Object3D[] = [];
  /** Turns parts of the frame off (comma-separated), or everything back on (""). */
  const ablate = (what: string) => {
    for (const o of hidden) o.visible = true;
    hidden.length = 0;
    pipeline.outputNode = full;
    world.sunLight.castShadow = true;
    world.setRenderScale(scale);
    const hide = (pred: (o: THREE.Object3D) => boolean) =>
      world.scene.traverse((o) => {
        if (o.visible && pred(o)) {
          o.visible = false;
          hidden.push(o);
        }
      });
    for (const w of what.split(",").filter(Boolean)) {
      if (w === "nofxaa" && inked instanceof THREE.Node) pipeline.outputNode = inked;
      if (w === "noink" && colour) pipeline.outputNode = renderOutput(colour);
      if (w === "noshadow") world.sunLight.castShadow = false;
      if (w === "noinstanced") hide((o) => o instanceof THREE.InstancedMesh);
      if (w === "noskinned") hide((o) => o instanceof THREE.SkinnedMesh);
      if (w === "nohulls") hide((o) => o.userData.outline === true);
      if (w === "nosprites") hide((o) => o instanceof THREE.Sprite);
      if (w === "noribbon") hide((o) => o instanceof THREE.Mesh && o.geometry.hasAttribute("dye"));
      if (w === "nobig") {
        hide(
          (o) =>
            o instanceof THREE.Mesh &&
            !(o instanceof THREE.InstancedMesh) &&
            (o.geometry.attributes.position?.count ?? 0) > 20000,
        );
      }
      if (w.startsWith("scale")) world.setRenderScale(Number(w.slice(5)));
      if (w.startsWith("hide:")) hide((o) => o.name === w.slice(5));
    }
    pipeline.needsUpdate = true;
  };
  /** Draw calls in one frame, by what they draw into. */
  const passes = (detail = false) => {
    const counts: Record<string, number> = {};
    const backend = renderer.backend;
    const original: unknown = Reflect.get(backend, "draw");
    if (typeof original !== "function") return counts;
    Reflect.set(backend, "draw", function (this: object, ...args: unknown[]) {
      const target = renderer.getRenderTarget();
      const pass = target ? `${target.width}x${target.height}${renderer.getMRT() ? " mrt" : ""}` : "canvas";
      counts[pass] = (counts[pass] ?? 0) + 1;
      if (detail) {
        const ro: unknown = args[0];
        const object: unknown = isObject(ro) ? Reflect.get(ro, "object") : null;
        if (object instanceof THREE.Object3D) {
          let kind = object.type;
          if (object instanceof THREE.Mesh && !(object instanceof THREE.SkinnedMesh)) {
            const n = object.geometry.attributes.position?.count ?? 0;
            kind += n > 5000 ? " big" : n > 500 ? " mid" : " small";
            if (object instanceof THREE.InstancedMesh) kind += ` x${object.count}`;
          }
          if (object.userData.outline) kind += " hull";
          const key = `${pass} | ${kind}`;
          counts[key] = (counts[key] ?? 0) + 1;
        }
      }
      return Reflect.apply(original, this, args) as unknown;
    });
    try {
      draw();
    } finally {
      Reflect.set(backend, "draw", original);
    }
    return counts;
  };
  /** What is drawn: objects by kind, and the last frame's draw calls and triangles. */
  const scene = () => {
    const out: Record<string, number> = {};
    world.scene.traverseVisible((o) => {
      out[o.type] = (out[o.type] ?? 0) + 1;
    });
    out.calls = renderer.info.render.drawCalls;
    out.triangles = renderer.info.render.triangles;
    return out;
  };
  /** Meshes under each child of the scene (and of the environment): how many, how many materials, triangles. */
  const census = () => {
    const rows: Record<string, { meshes: number; materials: number; tris: number; shadow: number }> = {};
    const tally = (root: THREE.Object3D, key: string) => {
      const mats = new Set<unknown>();
      const row = { meshes: 0, materials: 0, tris: 0, shadow: 0 };
      root.traverseVisible((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        row.meshes++;
        if (o.castShadow) row.shadow++;
        mats.add(o.material);
        const g = o.geometry;
        const n = g.index ? g.index.count : (g.attributes.position?.count ?? 0);
        row.tris += (n / 3) * (o instanceof THREE.InstancedMesh ? o.count : 1);
      });
      row.materials = mats.size;
      rows[key] = row;
    };
    world.scene.children.forEach((c, i) => {
      if (c === world.environment?.group) c.children.forEach((e, j) => tally(e, `env.${j} ${e.type} ${e.name}`));
      else tally(c, `${i} ${c.type} ${c.name}`);
    });
    return rows;
  };
  Object.assign(window, {
    __shiftyBench: {
      bench,
      ablate,
      passes,
      /** The fraction of the screen's pixels drawn now. */
      scale: () => world.renderScale,
      scene,
      census,
      /** Moves the sun to `(x, y, z)` from the point it shines on (held frames). */
      sun: (x: number, y: number, z: number) => {
        const sun = world.sunLight;
        sun.position.copy(sun.target.position).add(new THREE.Vector3(x, y, z));
      },
      /** Holds the frame on screen (drawn again, all at once), or lets it go. */
      hold: (on: boolean) => {
        pause(on);
        if (on) draw();
      },
    },
  });
}
