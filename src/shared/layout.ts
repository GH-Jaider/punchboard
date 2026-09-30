// How a deck's grid fills a box. The tablet uses this to size its tiles from
// the real screen, and the Control Center uses the same maths on a tablet-
// shaped frame, so the preview shows the deck the way the tablet will.

/** Preferred smallest row height. */
export const TILE_MIN = 56
/** Hard floor: below this a touch target is unusable. */
export const TOUCH_MIN = 44
/** Tallest a tile may get relative to its width. */
export const MAX_ASPECT = 2

export interface GridBox {
  width: number
  height: number
  columns: number
  rows: number
}

export interface GridLayout {
  gap: number
  colWidth: number
  rowHeight: number
  /** The rows do not fit even at the touch floor, so the grid must scroll. */
  scrolls: boolean
  /** How to place the rows when they do not fill the height. */
  alignContent: "start" | "center" | "stretch"
  iconSize: number
  fontSize: number
  /** Under this row height the label and the icon crowd each other out. */
  showLabel: boolean
}

/** Rows grow to fill the space until a tile would get taller than MAX_ASPECT,
    then stop and the grid centres itself, so a wide deck on a portrait phone
    does not turn every label into "Brows / er". */
export function layoutGrid(box: GridBox): GridLayout {
  const columns = Math.max(1, box.columns)
  const rows = Math.max(1, box.rows)
  const gap = box.width / columns < 92 ? 6 : 10
  const colWidth = (box.width - gap * (columns - 1)) / columns
  const roomPerRow = (box.height - gap * (rows - 1)) / rows

  let rowHeight = Math.min(roomPerRow, colWidth * MAX_ASPECT)
  if (rowHeight < TILE_MIN) {
    // Tight fit: shrink towards the touch floor before giving up and
    // scrolling, because a deck you have to scroll is a broken deck.
    rowHeight = Math.max(TOUCH_MIN, Math.min(TILE_MIN, roomPerRow))
  }
  rowHeight = Math.floor(rowHeight)
  const scrolls = rows * rowHeight + gap * (rows - 1) > box.height + 1

  return {
    gap,
    colWidth,
    rowHeight,
    scrolls,
    alignContent: scrolls ? "start" : rowHeight < roomPerRow - 1 ? "center" : "stretch",
    iconSize: Math.max(22, Math.min(76, Math.round(Math.min(colWidth, rowHeight) * 0.42))),
    // Label size follows the width, because that is what a label runs along.
    fontSize: Math.max(10, Math.min(19, Math.round(colWidth * 0.15))),
    showLabel: rowHeight >= 62
  }
}
