// driver.js, which runs the Control Center's tour (designer/tour.ts), in a
// bundle of its own: public/js/tour.js and tour.css, loaded before
// designer.js. Its published code uses destructuring, which esbuild cannot
// lower to Safari 11; only this bundle is allowed it (scripts/build.mjs), so
// Punchboard's own code keeps the ES2015 rule. The Control Center runs on the
// computer, whose browsers all have it.
import { driver } from "driver.js"
import "driver.js/dist/driver.css"

;(window as unknown as { punchboardDriver: typeof driver }).punchboardDriver = driver
