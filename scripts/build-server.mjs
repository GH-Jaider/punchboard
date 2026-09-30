// Bundles the companion into one file for the desktop app: dist/server/server.mjs.
// Node runs it with no source tree and no node_modules beside it.
import * as esbuild from "esbuild"

await esbuild.build({
  entryPoints: ["src/server/main.ts"],
  outfile: "dist/server/server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // ws tries these optional native speed-ups and does without them.
  external: ["bufferutil", "utf-8-validate"],
  // Bundled CommonJS packages still call require().
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  legalComments: "external",
  logLevel: "info"
})
