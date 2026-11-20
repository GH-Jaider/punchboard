//! The link to OBS Studio.
//!
//! - [`client`]: the obs-websocket v5 protocol (in place of obs-websocket-js).
//! - [`link`]: the one connection, kept up, with its meters.
//! - [`state`]: what OBS is doing, as the decks show it.
//! - [`config`]: OBS's own settings on this computer.

pub mod client;
pub mod config;
mod jsmath;
pub mod link;
pub mod state;

#[cfg(test)]
pub(crate) mod fake;

pub use client::{ObsClient, ObsError};
pub use config::{read_local_obs, LocalObs, ObsDetected};
pub use link::{
    meter_position, obs_call, read_meters, Levels, LinkStatus, ObsFailure, ObsIssue, ObsLink,
    ObsLinkOptions, ObsSettings, CONNECT_TIMEOUT_MS, REQUEST_TIMEOUT_MS,
};
pub use state::{
    fader_position, read_obs_names, NameLists, ObsNames, ObsState, ObsStateOptions, Toggles,
};
