# PingWatch — Design Spec

**Date:** 2026-07-18
**Status:** Approved (autonomous goal mode — decisions made per stated requirements)

## Purpose

PingWatch is a cross-platform desktop app (macOS + Windows) that continuously measures
network latency to multiple targets, visualizes it live, records sessions, and lets users
export/import sessions to compare results between different machines and connection types
(e.g. Wi-Fi laptop vs. LAN desktop on the same router). By pinging the router gateway and
internet hosts simultaneously, it helps localize latency problems: local network vs. router
vs. ISP.

## Requirements

1. Native desktop app for macOS and Windows with a polished, modern UI.
2. Live latency charts and dashboards (per-target and combined).
3. Configurable observation window, default 10 minutes.
4. Configurable ping rate, default 500 ms (2 pings/second) — suitable for spotting
   game-relevant spikes.
5. Multiple simultaneous targets; defaults: auto-detected default gateway, 1.1.1.1, 8.8.8.8.
6. Session recording with export to a portable JSON format (UTC timestamps + timezone and
   device metadata) and import for side-by-side comparison aligned on absolute time.
7. GitHub Actions pipeline that builds both platforms and attaches installers to a GitHub
   Release on tag push.
8. Comprehensive `.gitignore`; README describes what the app does (no personal context).
9. English everywhere.

## Stack Decision

**Chosen: Tauri 2 + Rust backend, React 19 + TypeScript + Vite frontend, Tailwind CSS 4,
uPlot for charts, zustand for state.**

Considered alternatives:

- **Electron + Node:** no new toolchain locally, but ~100 MB binaries and ICMP requires
  spawning the system `ping` binary, whose output is locale-dependent on Windows (fragile
  parsing). Rejected.
- **Native Swift + WinUI apps:** best platform fidelity but two full codebases; far too
  much scope. Rejected.
- **Tauri:** ~10 MB installers, one codebase, Rust backend does real ICMP without parsing
  CLI output, official `tauri-action` GitHub Action creates releases with installers for
  both OSes. Chosen.

### Ping engine (platform specifics)

- **Windows:** `IcmpSendEcho` via the `winping` crate — works without administrator rights.
- **macOS:** unprivileged ICMP datagram socket (SOCK_DGRAM, IPPROTO_ICMP) — supported on
  macOS without root. If a crate probe shows this unreliable, fallback is spawning
  `/sbin/ping -c 1` (macOS ping output is stable and English-only).
- One async task per target on a shared tokio runtime; each tick sends one echo request
  with a timeout (default 1000 ms, counts as packet loss). Results are streamed to the
  frontend via Tauri events, batched (~4/s flush) to keep IPC cheap.

## Architecture

```
src-tauri/            Rust backend
  src/ping/           Pinger trait + windows.rs / unix.rs implementations
  src/engine.rs       per-target ping loops, session state, event emission
  src/gateway.rs      default-gateway detection (netstat/route table)
  src/session.rs      data model + JSON (de)serialization for export/import
  src/commands.rs     Tauri commands (start/stop, targets, settings, export, import)
src/                  React frontend
  state/              zustand store (live samples, sessions, settings, comparison)
  components/         dashboard, charts, stat cards, target manager, compare view
  lib/stats.ts        min/avg/max/p95/p99, jitter, loss, spike detection (pure, tested)
  lib/align.ts        time-alignment + bucketing for session comparison (pure, tested)
```

### Data model

```
Sample  { targetId, seq, tUtcMs, rttMs: number | null }   // null = timeout/loss
Target  { id, label, address, kind: gateway|internet|custom, color }
Session { id, startedUtcMs, endedUtcMs, intervalMs, timezone (IANA), device:
          { hostname, os, connectionLabel }, targets[], samples[] }
```

Export file: `pingwatch-session-*.json` — schema version field, all timestamps UTC ms.
Timezone + device metadata allow correct localized display and cross-machine alignment.

### Frontend views

1. **Live dashboard:** one combined chart (all targets) + per-target stat cards
   (current, avg, min/max, p95, jitter, loss %, spike count) with health tint
   (good/warn/bad). Controls: start/stop, interval select (250 ms–5 s), window select
   (1/5/10/30/60 min), target add/remove/toggle. Spike log panel (timestamped events
   over threshold, default 100 ms, configurable).
2. **Compare view:** import one or two session files (plus optionally the current
   recorded session), overlay time-aligned charts, delta stats table per target
   (avg/p95/jitter/loss deltas), verdict summary highlighting which link is worse and
   where (gateway vs. internet) the degradation appears.

### Diagnosis aid

A "reading the results" hint in the compare/dashboard UI: gateway spikes ⇒ local
network/router; clean gateway + spiky internet targets ⇒ upstream/ISP; spikes only on the
Wi-Fi machine but not the LAN machine ⇒ Wi-Fi. (Generic wording; no personal context.)

## Error handling

- Unresolvable/invalid target address: inline validation error, target not added.
- Ping timeouts recorded as loss, never crash the loop; socket errors surface as a
  per-target error badge with retry.
- Import: schema-version check + zod validation, friendly error toast on malformed files.

## Testing

- Rust unit tests: stats helpers, session serialization round-trip, gateway parser.
- Vitest: `stats.ts`, `align.ts` (pure logic, TDD).
- UI verification in the browser (Vite dev server with a mocked Tauri IPC layer) via
  Chrome MCP, plus a real `tauri dev` smoke run on macOS.

## CI/CD

- `release.yml`: on tag `v*` — matrix `macos-latest` (universal binary) +
  `windows-latest`; `tauri-action` builds `.dmg` and NSIS `.exe` installer and publishes
  a GitHub Release with the artifacts. Unsigned builds; README documents the macOS
  Gatekeeper right-click-open workaround and Windows SmartScreen note.
- `ci.yml`: on push/PR — typecheck, vitest, `cargo test`, `cargo clippy`.
