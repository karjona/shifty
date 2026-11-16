// Modules the build makes (see vite.config.ts).
declare module "virtual:art" {
  /** The art in public/ by path (`riders/male/body.glb`): its size in bytes, and a hash of its content (builds). */
  const files: Readonly<Record<string, readonly [number, string]>>;
  export default files;
}
