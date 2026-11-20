//! How a deck's grid fills a box. The tablet uses this to size its tiles from
//! the real screen, and the Control Center uses the same maths on a tablet-
//! shaped frame, so the preview shows the deck the way the tablet will.
//! (src/shared/layout.ts)
use serde::{Deserialize, Serialize};

use super::js;

/// Preferred smallest row height.
pub const TILE_MIN: f64 = 56.0;
/// Hard floor: below this a touch target is unusable.
pub const TOUCH_MIN: f64 = 44.0;
/// Tallest a tile may get relative to its width. Past this a tile reads as a
/// bar, not a key, and a one-row deck turned into five tall slabs.
pub const MAX_ASPECT: f64 = 1.25;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct GridBox {
    pub width: f64,
    pub height: f64,
    pub columns: f64,
    pub rows: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AlignContent {
    Start,
    Center,
    Stretch,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridLayout {
    #[serde(serialize_with = "js::serialize_number")]
    pub gap: f64,
    #[serde(serialize_with = "js::serialize_number")]
    pub col_width: f64,
    #[serde(serialize_with = "js::serialize_number")]
    pub row_height: f64,
    /// The rows do not fit even at the touch floor, so the grid must scroll.
    pub scrolls: bool,
    /// How to place the rows when they do not fill the height.
    pub align_content: AlignContent,
    #[serde(serialize_with = "js::serialize_number")]
    pub icon_size: f64,
    #[serde(serialize_with = "js::serialize_number")]
    pub font_size: f64,
    /// Under this row height the label and the icon crowd each other out.
    pub show_label: bool,
}

/// Rows grow to fill the space until a tile would get taller than MAX_ASPECT,
/// then stop and the grid centres itself, so a wide deck on a portrait phone
/// does not turn every label into "Brows / er".
pub fn layout_grid(grid: GridBox) -> GridLayout {
    let columns = js::max(1.0, grid.columns);
    let preferred = if grid.width / columns < 92.0 {
        6.0
    } else {
        10.0
    };
    // A deck that would scroll by a few pixels fits with a tighter gap
    // instead: scrolling is the last resort, a narrower gap barely shows.
    let mut layout = layout_with_gap(grid, preferred);
    for gap in [6.0, 4.0] {
        if !layout.scrolls || gap >= preferred {
            continue;
        }
        layout = layout_with_gap(grid, gap);
    }
    layout
}

fn layout_with_gap(grid: GridBox, gap: f64) -> GridLayout {
    let columns = js::max(1.0, grid.columns);
    let rows = js::max(1.0, grid.rows);
    let col_width = (grid.width - gap * (columns - 1.0)) / columns;
    let room_per_row = (grid.height - gap * (rows - 1.0)) / rows;

    let mut row_height = js::min(room_per_row, col_width * MAX_ASPECT);
    if row_height < TILE_MIN {
        // Tight fit: shrink towards the touch floor before giving up and
        // scrolling, because a deck you have to scroll is a broken deck.
        row_height = js::max(TOUCH_MIN, js::min(TILE_MIN, room_per_row));
    }
    row_height = row_height.floor();
    let scrolls = rows * row_height + gap * (rows - 1.0) > grid.height + 1.0;

    GridLayout {
        gap,
        col_width,
        row_height,
        scrolls,
        align_content: if scrolls {
            AlignContent::Start
        } else if row_height < room_per_row - 1.0 {
            AlignContent::Center
        } else {
            AlignContent::Stretch
        },
        icon_size: js::max(
            22.0,
            js::min(76.0, js::round(js::min(col_width, row_height) * 0.42)),
        ),
        // Label size follows the width, because that is what a label runs along.
        font_size: js::max(10.0, js::min(19.0, js::round(col_width * 0.15))),
        show_label: row_height >= 62.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::testing::{cases, same};

    #[test]
    fn layout_grid_matches_the_typescript() {
        let all = cases("layout-layoutGrid.json");
        assert!(all.len() >= 500, "{} cases", all.len());
        for case in &all {
            let grid: GridBox = serde_json::from_value(case["input"].clone()).expect("a box");
            same(
                &format!("layoutGrid({})", case["input"]),
                &layout_grid(grid),
                &case["output"],
            );
        }
        let constants = &cases("layout-constants.json")[0]["output"];
        assert_eq!(constants["TILE_MIN"].as_f64(), Some(TILE_MIN));
        assert_eq!(constants["TOUCH_MIN"].as_f64(), Some(TOUCH_MIN));
        assert_eq!(constants["MAX_ASPECT"].as_f64(), Some(MAX_ASPECT));
    }
}
