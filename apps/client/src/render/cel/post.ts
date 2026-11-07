// The cel look's frame: the scene drawn once with its normals, depth and
// ink weights, then inked in screen space: a line on the near side of
// every silhouette (where depth jumps), along creases (where the normal
// turns) and where two objects meet (different ids). Lines take the colour
// under them, darkened, and thin out and fade with distance, as an
// illustrator would draw them. FXAA smooths the result.
import * as THREE from "three/webgpu";
import {
  Fn,
  abs,
  clamp,
  dot,
  float,
  max,
  mix,
  mrt,
  normalView,
  output,
  packNormalToRGB,
  pass,
  perspectiveDepthToViewZ,
  renderOutput,
  screenSize,
  screenUV,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { fxaa } from "three/addons/tsl/display/FXAANode.js";
import { devParams } from "../../dev-params.ts";

/** Dev: `?inkdebug=line|normal|ink|depth` shows one of the ink pass's inputs instead of the frame. */
const DEBUG = import.meta.env.DEV ? devParams.get("inkdebug") : null;

export class CelPost {
  readonly pipeline: THREE.RenderPipeline;
  /** Line width in pixels of the drawing buffer. */
  readonly width = uniform(1.5);
  /** Lines fade out from `near` to `far` metres. */
  readonly near = uniform(60);
  readonly far = uniform(900);
  /** Colour of the ink, as a multiple of the colour under it. */
  readonly ink = uniform(new THREE.Color(0.2, 0.16, 0.24));
  readonly saturation = uniform(1.08);
  private camNear = uniform(0.3);
  private camFar = uniform(4000);
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGPURenderer;
  private scene: THREE.Scene;
  private scenePass: THREE.PassNode;
  /** Laid out like a reflector's target (see `compile`). */
  private mirrorTarget = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType });

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    this.renderer = renderer;
    this.scene = scene;
    this.pipeline = new THREE.RenderPipeline(renderer);
    this.pipeline.outputColorTransform = false;
    const scenePass = pass(scene, camera, { samples: 0 });
    this.scenePass = scenePass;
    scenePass.setMRT(
      mrt({
        output,
        normal: vec4(packNormalToRGB(normalView), 1),
        // silhouette weight, crease weight, id, ink darkness
        ink: vec4(1, 1, 0, 1),
      }),
    );
    const colorTex = scenePass.getTextureNode("output");
    const normalTex = scenePass.getTextureNode("normal");
    const inkTex = scenePass.getTextureNode("ink");
    const depthTex = scenePass.getTextureNode("depth");
    const { width, near, far, ink, saturation } = this;
    const cameraNear = this.camNear;
    const cameraFar = this.camFar;

    const inked = Fn(() => {
      const uv = screenUV;
      const texel = vec2(1).div(screenSize);
      const depthAt = (p: THREE.Node<"vec2">) =>
        perspectiveDepthToViewZ(depthTex.sample(p).x, cameraNear, cameraFar).negate();
      const z0 = depthAt(uv);
      const q0 = float(1).div(z0);
      const k0 = inkTex.sample(uv);
      const n0 = normalTex.sample(uv).xyz.mul(2).sub(1);
      // Thinner lines far away.
      const fade = smoothstep(far, near, z0);
      const r = width.mul(mix(float(0.6), float(1), fade));
      const dirs: [number, number][] = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [Math.SQRT1_2, Math.SQRT1_2],
        [-Math.SQRT1_2, -Math.SQRT1_2],
        [Math.SQRT1_2, -Math.SQRT1_2],
        [-Math.SQRT1_2, Math.SQRT1_2],
      ];
      const qs: THREE.Node<"float">[] = [];
      let crease: THREE.Node<"float"> = float(0);
      let idEdge: THREE.Node<"float"> = float(0);
      for (const [dx, dy] of dirs) {
        const p = uv.add(vec2(dx, dy).mul(texel).mul(r));
        const z = depthAt(p);
        const q = float(1).div(z);
        qs.push(q);
        const k = inkTex.sample(p);
        const n = normalTex.sample(p).xyz.mul(2).sub(1);
        // A crease only counts against a neighbour at about the same depth.
        const same = smoothstep(0.08, 0.03, abs(q.sub(q0)).div(q0));
        const turn = float(1).sub(dot(n0, n));
        crease = max(crease, smoothstep(0.18, 0.4, turn).mul(same).mul(k.w.greaterThan(0.001).select(1, 0)));
        // Different objects: a line on the nearer (or equal) side.
        const differ = smoothstep(0.002, 0.004, abs(k.z.sub(k0.z)));
        idEdge = max(
          idEdge,
          differ.mul(q0.greaterThanEqual(q.mul(0.999)).select(1, 0)).mul(k.w.greaterThan(0.001).select(1, 0)),
        );
      }
      // Silhouettes: the inverse depth bulges (its second difference) on the near side of a jump; flat on any plane.
      let sil: THREE.Node<"float"> = float(0);
      for (let i = 0; i < dirs.length; i += 2) {
        const lap = q0
          .mul(2)
          .sub(qs[i]!)
          .sub(qs[i + 1]!)
          .div(q0);
        sil = max(sil, lap);
      }
      const silEdge = smoothstep(0.04, 0.12, sil).mul(k0.x);
      const creaseEdge = crease.mul(k0.y);
      const line = clamp(max(max(silEdge, creaseEdge), idEdge.mul(max(k0.x, k0.y))), 0, 1)
        .mul(mix(float(0.35), float(1), fade))
        .mul(z0.lessThan(cameraFar.mul(0.999)).select(1, 0));
      const base = colorTex.sample(uv);
      const lineColour = base.rgb.mul(mix(vec3(1), ink, k0.w));
      const c = mix(base.rgb, lineColour, line);
      const luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
      const graded = vec4(mix(vec3(luma), c, saturation), 1);
      if (DEBUG === "line") return vec4(vec3(line), 1);
      if (DEBUG === "normal") return vec4(n0.mul(0.5).add(0.5), 1);
      if (DEBUG === "ink") return vec4(k0.xyz, 1);
      if (DEBUG === "depth") return vec4(vec3(z0.div(500)), 1);
      return graded;
    })();
    this.pipeline.outputNode = fxaa(renderOutput(inked));
  }

  /**
   * Compiles the shaders that drawing `root` (the scene, or something about
   * to join it) will need, without blocking the page: every mesh, in view or
   * not, as the inked pass draws it and, with `mirror`, as a reflection
   * draws it. The renderer points at this pass's targets until it resolves,
   * so nothing else may draw meanwhile.
   */
  async compile(root: THREE.Object3D = this.scene, mirror = false): Promise<void> {
    const r = this.renderer;
    const culled: THREE.Object3D[] = [];
    root.traverse((o) => {
      if (!o.frustumCulled) return;
      o.frustumCulled = false;
      culled.push(o);
    });
    const target = r.getRenderTarget();
    const outputs = r.getMRT();
    try {
      r.setRenderTarget(this.scenePass.renderTarget);
      r.setMRT(this.scenePass.getMRT());
      await r.compileAsync(root, this.camera, this.scene);
      if (mirror) {
        r.setRenderTarget(this.mirrorTarget);
        r.setMRT(null);
        await r.compileAsync(root, this.camera, this.scene);
      }
    } finally {
      r.setRenderTarget(target);
      r.setMRT(outputs);
      for (const o of culled) o.frustumCulled = true;
    }
  }

  render(): void {
    this.camNear.value = this.camera.near;
    this.camFar.value = this.camera.far;
    this.pipeline.render();
  }
}
