// The Control Center's shared toast and redraw entry points. main.ts wires
// the real renderers in, so modules can ask each other to redraw without
// importing each other in circles.
import type { Button } from "../../shared/types.ts"
import { byId, createToast } from "../common/dom.ts"

export const toast = createToast(byId("toast"))

export const view = {
  renderAll: (): void => {},
  renderGrid: (): void => {},
  renderProfiles: (): void => {},
  renderInspector: (): void => {},
  renderSteps: (_button: Button): void => {},
  refreshTile: (_button: Button): void => {},
  select: (_slot: number): void => {}
}

/** Stroke paths for the interface's own small icons. */
export const UI_ICONS = {
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  play: '<polygon points="7 4 19 12 7 20 7 4"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  revert: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><circle cx="12" cy="12" r="10"/>'
} as const
