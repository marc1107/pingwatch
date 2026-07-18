//! Unprivileged ICMP ping on Windows via IcmpSendEcho (winping crate).

use super::PingOutcome;
use std::net::IpAddr;
use std::time::Duration;
use winping::{Buffer, Error, Pinger};

pub fn ping_blocking(addr: IpAddr, timeout: Duration) -> PingOutcome {
    let IpAddr::V4(_) = addr else {
        return PingOutcome::Error("only IPv4 targets are supported".into());
    };

    let mut pinger = match Pinger::new() {
        Ok(p) => p,
        Err(e) => return PingOutcome::Error(format!("icmp handle: {e}")),
    };
    pinger.set_timeout(timeout.as_millis() as u32);

    let mut buffer = Buffer::new();
    match pinger.send(addr, &mut buffer) {
        Ok(rtt_ms) => PingOutcome::Rtt(rtt_ms as f64),
        Err(Error::Timeout) => PingOutcome::Timeout,
        Err(e) => PingOutcome::Error(format!("ping: {e}")),
    }
}
