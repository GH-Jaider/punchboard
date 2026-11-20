//! The Punchboard companion.
//!
//! One module per area; `README.md` beside Cargo.toml has the map, the
//! process contract and the rules the crate keeps.

pub mod config;
pub mod http;
pub mod i18n;
pub mod latest_wins;
pub mod model;
pub mod net;
pub mod paths;
pub mod port;
pub mod store;
pub mod translate;

pub mod apps;
pub mod audio;
pub mod auth;
pub mod google_icons;
pub mod keys;
pub mod library;
pub mod obs;
pub mod pointer;
pub mod sign;
pub mod sounds;
pub mod touch_trace;

pub mod actions;
pub mod events;
pub mod server;
pub mod test_system;
