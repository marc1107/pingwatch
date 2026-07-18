use std::net::IpAddr;

/// The LAN default gateway (usually the router), if detectable.
pub fn default_gateway_ip() -> Option<IpAddr> {
    netdev::get_default_gateway()
        .ok()
        .and_then(|gw| gw.ipv4.first().map(|ip| IpAddr::V4(*ip)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_is_private_when_present() {
        // On machines without a network this returns None; when present it
        // must be a private LAN address.
        if let Some(IpAddr::V4(ip)) = default_gateway_ip() {
            assert!(ip.is_private() || ip.is_link_local(), "gateway was {ip}");
        }
    }
}
