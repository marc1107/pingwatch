# PingWatch

A cross-platform desktop app (macOS + Windows) that continuously measures network latency
to multiple targets, visualizes it live, and lets you compare recordings from different
machines — so you can find out **where** latency problems actually come from: the local
network, the router, or the internet provider.


## Why

A single ping to one host tells you little. PingWatch pings your **router (default
gateway)** and **internet hosts** (Cloudflare `1.1.1.1`, Google `8.8.8.8`) at the same
time:

- If the **router trace spikes too**, the problem is inside your local network
  (Wi-Fi interference, router load, cabling).
- If the **router is clean but internet targets spike**, the problem is upstream —
  your provider or routing.
- Run PingWatch on **two machines on the same router** (e.g. one wireless, one wired),
  export both sessions, and compare them side by side. If only the wireless machine
  spikes, it's the wireless link.

## Features

- **Live dashboard** — combined latency chart for all targets, per-target stat cards
  (current, avg, min/max, p95, jitter, packet loss, spike count) with health ratings
  tuned for online gaming, and a spike log of every event above the threshold.
- **Multiple targets** — router gateway is auto-detected; add any host or IP.
- **Configurable** — ping rate (4/s down to every 5 s, default 2/s), view window
  (1 min – 1 h, default 10 min), spike threshold (default 100 ms).
- **Session export/import** — recordings are saved as JSON with UTC timestamps plus
  timezone and device metadata, so sessions from different machines align correctly.
- **Compare view** — overlay two sessions on real wall-clock time (or elapsed time when
  they don't overlap), see per-target deltas for avg/p95/jitter/loss, and get a plain
  verdict on which link is worse and where the degradation appears.
- **No admin rights needed** — ICMP pings work unprivileged on both macOS and Windows.

## Install

Download the latest release from the
[Releases page](../../releases):

- **macOS**: `PingWatch_x.y.z_universal.dmg`
- **Windows**: `PingWatch_x.y.z_x64-setup.exe`

The builds are not code-signed:

- **macOS** will warn that the app is from an unidentified developer. Right-click the
  app → **Open** → **Open** (or run `xattr -cr /Applications/PingWatch.app`).
- **Windows** SmartScreen may warn on first run. Click **More info** → **Run anyway**.

## Comparing two machines

1. Run PingWatch on machine A, set a label (e.g. "Laptop Wi-Fi"), press **Start**,
   let it run for ~10 minutes, then **Export session**.
2. Do the same on machine B (e.g. "Desktop LAN") — ideally at the same time, so the
   sessions overlap and align on real time.
3. On either machine, open the **Compare** tab and import both files.

Timestamps are stored in UTC and displayed in your local timezone, so recordings from
machines in different timezones still line up correctly.

## Development

Prerequisites: [Node.js](https://nodejs.org) ≥ 20, [Rust](https://rustup.rs) (stable),
and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```sh
npm install
npm run tauri dev      # run the desktop app with hot reload
npm run dev            # UI only, in the browser with a simulated backend
npx vitest run         # frontend unit tests
cargo test             # backend tests (run inside src-tauri/)
npm run tauri build    # produce a local installer
```

The UI runs fully in a plain browser (`npm run dev`) using a synthetic sample generator,
which makes frontend work possible without the native shell.

## Releasing

Push a tag like `v0.2.0` — the release workflow builds the macOS universal `.dmg` and the
Windows NSIS installer and attaches both to a GitHub Release.

```sh
git tag v0.2.0 && git push origin v0.2.0
```

## License

MIT
