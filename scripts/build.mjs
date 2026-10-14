// Bundles the browser code (src/client) into public/js.
//   node scripts/build.mjs          one build
//   node scripts/build.mjs --watch  rebuild on change
import fs from "node:fs"
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

// driver.js, for the Control Center's tour, on its own: its published code
// uses destructuring, which esbuild cannot lower to Safari 11. Only this
// bundle may keep it, so Punchboard's own code still fails the build if it
// slips any in. The Control Center runs on the computer, never an old tablet.
// Its MIT licence heads the bundle, which the desktop app ships with the rest
// of public/ (notices.mjs lists only what is bundled into the server).
const driverLicence = fs.readFileSync("node_modules/driver.js/license", "utf8").trim().replace(/\*\//g, "* /")
const vendor = {
  ...options,
  entryPoints: { tour: "src/client/vendor/driver.ts" },
  supported: { destructuring: true },
  banner: {
    js: `/*! driver.js (https://driverjs.com), bundled for the Control Center's tour.\n\n${driverLicence}\n*/`,
    css: "/*! driver.js (https://driverjs.com), MIT License, Copyright (c) Kamran Ahmed; full text in tour.js */"
  }
}

if (process.argv.includes("--watch")) {
  for (const set of [options, vendor]) await (await esbuild.context(set)).watch()
} else {
  await Promise.all([esbuild.build(options), esbuild.build(vendor)])
}
