//! The deck model: what a deck, a button and a step are, how anything read
//! from a file or a request becomes one, and the tables the rest of the
//! companion asks about them.
//!
//! A faithful copy of the TypeScript in `src/shared` (which the client keeps
//! using), one file per file there:
//!
//! | TypeScript | here |
//! |---|---|
//! | `types.ts` | `types` |
//! | `model.ts` | `normalize`, and `ids` for `nextId` and the clock |
//! | `actions.ts` | `actions` |
//! | `colors.ts`, `themes.ts`, `links.ts`, `layout.ts`, `keys.ts` | the same names |
//! | `icons.ts`, `icon-data.ts`, `default-glyphs.ts` | `icons`, `icon_data`, `default_glyphs` |
//! | `starter-decks.ts`, `starter-glyphs.ts` | `starter_decks`, `starter_glyphs` |
//!
//! `js` holds the JavaScript conversions the reading depends on. Nothing here
//! touches the system: words come through a `Translate`, new ids and the
//! time through an `Ids`. tests/fixtures/make-model.ts runs the TypeScript
//! over many inputs, and the tests here must give the same answers.

pub mod actions;
pub mod colors;
pub mod default_glyphs;
pub mod icon_data;
pub mod icons;
pub mod ids;
pub mod js;
pub mod keys;
pub mod layout;
pub mod links;
pub mod normalize;
pub mod starter_decks;
pub mod starter_glyphs;
pub mod themes;
pub mod types;

#[cfg(test)]
mod testing;

pub use ids::Ids;
pub use normalize::*;
pub use types::*;
