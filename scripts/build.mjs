// Bundles the browser code (src/client) into public/js.
//   node scripts/build.mjs          one build
//   node scripts/build.mjs --watch  rebuild on change
import * as esbuild from "esbuild"

const options = {
  entryPoints: {
    deck: "src/client/deck/main.ts",
    designer: "src/client/designer/main.ts",
    pair: "src/client/pair/main.ts"
  },
  outdir: "public/js",
  bundle: true,
  format: "iife",
  // The deck runs on whatever tablet was in the drawer. Safari 11 (iOS 11) is
  // the floor: esbuild cannot work around Safari 10's let/const bugs.
  target: ["es2015", "safari11"],
  minify: true,
  sourcemap: "linked",
  legalComments: "none",
  logLevel: "info"
}

if (process.argv.includes("--watch")) {
  const context = await esbuild.context(options)
  await context.watch()
} else {
  await esbuild.build(options)
}
