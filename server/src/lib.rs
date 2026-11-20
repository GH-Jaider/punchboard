//! The Punchboard companion.
//!
//! One module per area; `PORTING.md` beside Cargo.toml says which TypeScript
//! file each one replaces and the rules the port follows.

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
