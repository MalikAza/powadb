pub mod config;
pub mod tunnel;

pub use config::WgConfig;
pub use tunnel::{open_tunnel, TunnelHandle};
