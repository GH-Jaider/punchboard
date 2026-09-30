// The icons a new button starts with, so a deck works before anyone has
// browsed Google's catalog (and offline). Copied from Material Symbols
// Outlined; the picker offers the same catalog live.
import type { Glyph } from "./types.ts"

/** "sensors": a new press button. */
export const DEFAULT_PRESS_GLYPH: Glyph = {
  source: "google",
  name: "sensors",
  style: "outlined",
  fill: false,
  viewBox: "0 -960 960 960",
  paths: ["M197-197q-54-55-85.5-127.5T80-480q0-84 31.5-156.5T197-763l57 57q-44 44-69 102t-25 124q0 67 25 125t69 101l-57 57Zm113-113q-32-33-51-76.5T240-480q0-51 19-94.5t51-75.5l57 57q-22 22-34.5 51T320-480q0 33 12.5 62t34.5 51l-57 57Zm113.5-113.5Q400-447 400-480t23.5-56.5Q447-560 480-560t56.5 23.5Q560-513 560-480t-23.5 56.5Q513-400 480-400t-56.5-23.5ZM650-310l-57-57q22-22 34.5-51t12.5-62q0-33-12.5-62T593-593l57-57q32 32 51 75.5t19 94.5q0 50-19 93.5T650-310Zm113 113-57-57q44-44 69-102t25-124q0-67-25-125t-69-101l57-57q54 54 85.5 126.5T880-480q0 83-31.5 155.5T763-197Z"]
}

/** "tune": a new volume fader. */
export const DEFAULT_FADER_GLYPH: Glyph = {
  source: "google",
  name: "tune",
  style: "outlined",
  fill: false,
  viewBox: "0 -960 960 960",
  paths: ["M440-120v-240h80v80h320v80H520v80h-80Zm-320-80v-80h240v80H120Zm160-160v-80H120v-80h160v-80h80v240h-80Zm160-80v-80h400v80H440Zm160-160v-240h80v80h160v80H680v80h-80Zm-480-80v-80h400v80H120Z"]
}
