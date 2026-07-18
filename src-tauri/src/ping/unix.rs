//! Unprivileged ICMP ping via a datagram ICMP socket (SOCK_DGRAM,
//! IPPROTO_ICMP), supported on macOS without root.

use super::PingOutcome;
use socket2::{Domain, Protocol, Socket, Type};
use std::io::ErrorKind;
use std::mem::MaybeUninit;
use std::net::{IpAddr, SocketAddr};
use std::process;
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::{Duration, Instant};

/// Datagram ICMP sockets receive every echo reply addressed to the process,
/// so each in-flight ping needs a unique (id, seq) pair to match its own
/// reply and never a concurrent target's.
static NEXT_SEQ: AtomicU16 = AtomicU16::new(0);

const ECHO_REQUEST: u8 = 8;
const ECHO_REPLY: u8 = 0;
const PAYLOAD_LEN: usize = 32;

fn checksum(data: &[u8]) -> u16 {
    let mut sum = 0u32;
    for pair in data.chunks(2) {
        let word = u16::from_be_bytes([pair[0], *pair.get(1).unwrap_or(&0)]) as u32;
        sum = sum.wrapping_add(word);
    }
    while sum >> 16 != 0 {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    !(sum as u16)
}

fn build_echo_request(id: u16, seq: u16) -> [u8; 8 + PAYLOAD_LEN] {
    let mut packet = [0u8; 8 + PAYLOAD_LEN];
    packet[0] = ECHO_REQUEST;
    packet[4..6].copy_from_slice(&id.to_be_bytes());
    packet[6..8].copy_from_slice(&seq.to_be_bytes());
    for (i, byte) in packet[8..].iter_mut().enumerate() {
        *byte = i as u8;
    }
    let sum = checksum(&packet);
    packet[2..4].copy_from_slice(&sum.to_be_bytes());
    packet
}

/// Returns the ICMP portion of a received datagram. macOS delivers the full
/// IP packet (header included) on datagram ICMP sockets; strip it if present.
fn icmp_slice(buf: &[u8]) -> &[u8] {
    if buf.len() >= 20 && buf[0] >> 4 == 4 {
        let ihl = ((buf[0] & 0x0f) as usize) * 4;
        if buf.len() > ihl {
            return &buf[ihl..];
        }
    }
    buf
}

pub fn ping_blocking(addr: IpAddr, timeout: Duration) -> PingOutcome {
    let IpAddr::V4(v4) = addr else {
        return PingOutcome::Error("only IPv4 targets are supported".into());
    };

    let socket = match Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::ICMPV4)) {
        Ok(s) => s,
        Err(e) => return PingOutcome::Error(format!("icmp socket: {e}")),
    };

    let id = (process::id() & 0xffff) as u16;
    let seq = NEXT_SEQ.fetch_add(1, Ordering::Relaxed);
    let packet = build_echo_request(id, seq);
    let dest: SocketAddr = (IpAddr::V4(v4), 0).into();

    let start = Instant::now();
    if let Err(e) = socket.send_to(&packet, &dest.into()) {
        return PingOutcome::Error(format!("send: {e}"));
    }

    let deadline = start + timeout;
    let mut buf = [MaybeUninit::<u8>::uninit(); 2048];
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return PingOutcome::Timeout;
        }
        if let Err(e) = socket.set_read_timeout(Some(remaining)) {
            return PingOutcome::Error(format!("set timeout: {e}"));
        }
        match socket.recv_from(&mut buf) {
            Ok((len, src)) => {
                let from_target = src
                    .as_socket()
                    .is_none_or(|s| s.ip() == IpAddr::V4(v4) || v4.is_loopback());
                let elapsed = start.elapsed();
                // SAFETY: recv_from initialized the first `len` bytes.
                let data: &[u8] =
                    unsafe { std::slice::from_raw_parts(buf.as_ptr() as *const u8, len) };
                let icmp = icmp_slice(data);
                if from_target
                    && icmp.len() >= 8
                    && icmp[0] == ECHO_REPLY
                    && icmp[4..6] == id.to_be_bytes()
                    && icmp[6..8] == seq.to_be_bytes()
                {
                    return PingOutcome::Rtt(elapsed.as_secs_f64() * 1000.0);
                }
                // Not our reply (e.g. another process's traffic) - keep waiting.
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::TimedOut => {
                return PingOutcome::Timeout;
            }
            Err(e) => return PingOutcome::Error(format!("recv: {e}")),
        }
    }
}
