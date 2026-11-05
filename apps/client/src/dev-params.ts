// The dev server's URL switches (`?render=0`, `?scale=0.5`, `?celshot=hero`...),
// for tests and look checks. This is the only place the client reads the
// URL's query (the router reads its own routes), and lint stops other
// modules reading it.
//
// A build reads no switches: every read sits behind `import.meta.env.DEV`,
// so the build drops it, and this module with it. If a read is left
// unguarded, the marker below lands in the bundle and the build fails
// (vite.config.ts).
export const devParams: URLSearchParams = import.meta.env.DEV
  ? // oxlint-disable-next-line eslint/no-restricted-properties
    new URLSearchParams(location.search)
  : /* @__PURE__ */ new URLSearchParams("dev-params-read-in-a-build");
