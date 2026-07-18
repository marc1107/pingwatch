use std::net::IpAddr;
use std::time::Duration;

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[derive(Debug, Clone, PartialEq)]
pub enum PingOutcome {
    /// Round-trip time in milliseconds.
    Rtt(f64),
    Timeout,
    Error(String),
}

/// Send a single ICMP echo request and wait for the reply.
/// Works without elevated privileges on macOS (ICMP datagram socket) and
/// Windows (IcmpSendEcho).
pub async fn ping_once(addr: IpAddr, timeout: Duration) -> PingOutcome {
    let result = tokio::task::spawn_blocking(move || {
        #[cfg(unix)]
        {
            unix::ping_blocking(addr, timeout)
        }
        #[cfg(windows)]
        {
            windows::ping_blocking(addr, timeout)
        }
    })
    .await;

    match result {
        Ok(outcome) => outcome,
        Err(e) => PingOutcome::Error(format!("ping task failed: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pings_loopback_without_privileges() {
        let outcome = ping_once("127.0.0.1".parse().unwrap(), Duration::from_millis(1000)).await;
        match outcome {
            PingOutcome::Rtt(rtt) => assert!(rtt >= 0.0 && rtt < 1000.0, "rtt was {rtt}"),
            other => panic!("expected Rtt, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn unroutable_address_does_not_yield_rtt() {
        // 192.0.2.0/24 (TEST-NET-1) is reserved and never answers; depending
        // on the local routing table this is either a timeout or an
        // immediate "no route" error - both count as an unreachable target.
        let outcome = ping_once("192.0.2.1".parse().unwrap(), Duration::from_millis(300)).await;
        assert!(
            !matches!(outcome, PingOutcome::Rtt(_)),
            "expected Timeout or Error, got {outcome:?}"
        );
    }
}
