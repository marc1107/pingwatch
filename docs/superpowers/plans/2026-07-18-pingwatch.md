# PingWatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cross-platform (macOS + Windows) Tauri desktop app that live-monitors ping latency to multiple targets, records sessions, and compares exported sessions across machines.

**Architecture:** Rust backend owns the ping engine (one tokio loop per target, platform-specific ICMP senders) and streams batched samples to the React frontend over Tauri events. The frontend holds all live/session state in a zustand store, renders uPlot time-series charts, and computes stats/alignment in pure, unit-tested TypeScript modules. Export/import is JSON with UTC-ms timestamps plus device/timezone metadata.

**Tech Stack:** Tauri 2, Rust (tokio, serde, socket2, winping, netdev), React 19 + TypeScript + Vite, Tailwind CSS 4, zustand, uPlot, zod, vitest.

## Global Constraints

- All code, docs, commits in English.
- No personal context anywhere in the repo (generic diagnostic wording only).
- Defaults: 500 ms ping interval, 10-minute view window, targets = gateway + 1.1.1.1 + 8.8.8.8, 1000 ms timeout = loss, spike threshold 100 ms.
- No admin/root required to ping on either OS.
- App name/identifier: PingWatch / `com.pingwatch.app`.
- Conventional commits; work on `feat/initial-app`; PR to `main`.

---

### Task 1: Project scaffold

**Files:** `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/styles.css`, `.gitignore`, `src-tauri/{Cargo.toml, tauri.conf.json, build.rs, src/main.rs, src/lib.rs, capabilities/default.json, icons/*}`

- [x] Hand-roll Vite + React + TS + Tailwind 4 (`@tailwindcss/vite`) frontend; `npm run dev` serves a placeholder page.
- [x] Hand-roll `src-tauri` (tauri = "2", tauri-plugin-dialog = "2", tokio, serde, serde_json; `devUrl` http://localhost:1420, `frontendDist` ../dist). Generate icons from a simple source PNG via `tauri icon` (or `icns`/`ico` via script).
- [x] `.gitignore`: node_modules, dist, src-tauri/target, src-tauri/gen, .DS_Store, *.log, coverage, .vite.
- [x] Verify: `npm run build` (tsc + vite) passes; `cargo check` in src-tauri passes.
- [x] Commit `chore: scaffold tauri + react + tailwind app`.

### Task 2: Rust data model

**Files:** `src-tauri/src/session.rs`
**Produces:** `Sample { target_id: String, seq: u64, t_utc_ms: i64, rtt_ms: Option<f64> }`, `Target { id, label, address, kind: TargetKind::{Gateway,Internet,Custom} }`, `Session { schema_version: u32 = 1, id, started_utc_ms, ended_utc_ms: Option<i64>, interval_ms, timeout_ms, timezone, device: DeviceInfo { hostname, os, connection_label }, targets: Vec<Target>, samples: Vec<Sample> }` — all serde camelCase.

- [x] TDD: serde round-trip test (incl. `rttMs: null` for loss) → implement → `cargo test` green → commit `feat(core): session data model with JSON serialization`.

### Task 3: Platform ping module

**Files:** `src-tauri/src/ping/mod.rs`, `ping/unix.rs`, `ping/windows.rs`
**Produces:** `async fn ping_once(addr: IpAddr, timeout: Duration) -> PingOutcome` where `PingOutcome = Rtt(f64) | Timeout | Error(String)`.

- [x] unix.rs: unprivileged ICMP via `socket2` (SOCK_DGRAM, IPPROTO_ICMPV4): build echo request (id = process-unique, seq), RFC 1071 checksum, send, recv with deadline, tolerate leading IP header in reply, match id/seq. Runs in `spawn_blocking`; RTT from `Instant`.
- [x] Empirical test (ignored-by-default integration test + one live test vs 127.0.0.1) proves no-root operation on macOS. If DGRAM ICMP fails empirically, fallback implementation: spawn `/sbin/ping -c 1`, parse `time=([\d.]+) ms`.
- [x] windows.rs: `winping` crate `Pinger::send_to` in `spawn_blocking` (IcmpSendEcho — no admin). cfg-gated; verify via `rustup target add x86_64-pc-windows-msvc && cargo check --target x86_64-pc-windows-msvc`.
- [x] Commit `feat(ping): unprivileged ICMP ping for macOS and Windows`.

### Task 4: Engine + Tauri commands

**Files:** `src-tauri/src/engine.rs`, `src-tauri/src/gateway.rs`, `src-tauri/src/commands.rs`, wire in `lib.rs`
**Produces (commands, camelCase args):** `get_defaults() -> AppDefaults { gatewayIp: Option<String>, hostname, os }`, `start_monitoring(targets: Vec<Target>, intervalMs: u64, timeoutMs: u64)`, `stop_monitoring()`, `export_session(path: String, session: Session) -> Result<()>` (backend writes pretty JSON), `import_session(path: String) -> Result<Session>` (validates schemaVersion). Event `ping-batch` payload `Vec<Sample>` flushed every 250 ms.

- [x] gateway.rs: `netdev::get_default_gateway()` → Option<IpAddr>.
- [x] engine.rs: `Engine { tasks: Vec<JoinHandle>, tx }`; per-target loop: `interval.tick()` → `ping_once` → push to shared batch; a flusher task emits `ping-batch`. DNS resolution once at start (`tokio::net::lookup_host`), invalid address → command error. Stop = abort tasks.
- [x] Session assembly happens frontend-side (store accumulates samples); export command receives full Session JSON. Import validates version + returns parsed Session.
- [x] `cargo test` + `cargo clippy -- -D warnings` green. Commit `feat(engine): monitoring engine, gateway detection, tauri commands`.

### Task 5: Frontend pure logic (TDD)

**Files:** `src/lib/types.ts` (mirror of Rust model, zod schema `SessionSchema`), `src/lib/stats.ts`, `src/lib/align.ts`, tests in `src/lib/*.test.ts`

**Produces:**
- `computeStats(samples: Sample[], spikeThresholdMs: number): TargetStats { count, lossCount, lossPct, min, avg, max, p95, p99, jitterMs, spikeCount, current }` — jitter = mean absolute successive difference (RFC 3550 style); percentiles by nearest-rank; null-safe on empty.
- `healthOf(stats): 'good' | 'warn' | 'bad'` — bad if lossPct > 2 or p95 > 100 or jitter > 30; warn if lossPct > 0.5 or p95 > 60 or jitter > 15; else good.
- `detectSpikes(samples, thresholdMs): SpikeEvent[]` (contiguous runs of rtt>threshold or loss → one event with start/end/peak).
- `bucketize(samples, bucketMs): AlignedPoint[]` and `alignSessions(a: Session, b: Session, bucketMs = 1000)` → overlapping UTC range, per-bucket avg per session, plus `overlapMs` (0 ⇒ UI falls back to relative-time comparison from each session start).
- [x] vitest red → green per module; commit `feat(ui): stats, spike detection and session alignment logic`.

### Task 6: IPC layer + store

**Files:** `src/lib/ipc.ts`, `src/lib/mockIpc.ts`, `src/state/store.ts`

- [x] `ipc.ts`: thin wrapper over `@tauri-apps/api` invoke/listen + plugin-dialog save/open. When `!('__TAURI_INTERNALS__' in window)` use `mockIpc.ts`: fake gateway 192.168.1.1, synthetic samples (base RTT per target + gaussian noise + occasional spikes/loss, one target markedly worse) on the configured interval — enables full browser dev/testing.
- [x] `store.ts` (zustand): settings (intervalMs 500, timeoutMs 1000, windowMin 10, spikeThresholdMs 100, connectionLabel), targets (defaults incl. detected gateway), `running`, ring-buffered samples per target (cap = window-max 60 min), session start/stop bookkeeping, imported sessions for compare, actions wiring ipc.
- [x] Commit `feat(ui): tauri ipc bridge with browser mock and app store`.

### Task 7: Dashboard UI

**Files:** `src/App.tsx`, `src/components/{Dashboard.tsx, LiveChart.tsx (uPlot wrapper), StatCard.tsx, TargetManager.tsx, ControlBar.tsx, SpikeLog.tsx, Verdict.tsx}`, `src/styles.css`

- [x] Use frontend-design + dataviz skill guidance. Dark-first, near-black blue-tinted palette, one accent per target (colorblind-safe), Inter/system font, uPlot styled to match (no default look). Layout: header w/ app name + record & run controls; combined live chart (window-clipped, loss ticks on x-axis band, spike threshold guide-line); grid of per-target stat cards with health tint; collapsible spike log; interval/window/threshold selects; target add/remove/toggle; "how to read this" hint popover (generic diagnostic guidance).
- [x] Browser-verify with mock IPC via Chrome MCP (console clean, screenshot). Commit `feat(ui): live monitoring dashboard`.

### Task 8: Sessions, export/import, compare view

**Files:** `src/components/{CompareView.tsx, SessionBadge.tsx}`, store + ipc extensions, tab switch in `App.tsx`

- [x] Record start/stop → Session object; Export button → save dialog → `export_session`. Import (up to 2 files) → zod-validate → compare tab: overlaid aligned chart (bucketized), per-target delta table (avg/p95/jitter/loss with better/worse coloring), localized timestamp display (`Intl.DateTimeFormat` w/ session timezone shown), verdict panel (which link degrades where: gateway vs internet). Relative-time fallback when no UTC overlap.
- [x] Browser-verify with two synthetic mock sessions. Commit `feat(ui): session recording, export/import and comparison view`.

### Task 9: README, CI, release pipeline

**Files:** `README.md`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`

- [x] README: what it does, screenshots placeholder→real, features, defaults, download/install (incl. unsigned-build notes: macOS right-click-open / `xattr -cr`, Windows SmartScreen), how to interpret results (generic), dev setup, release process. No personal context.
- [x] ci.yml: push/PR → npm ci, tsc, vitest run, cargo fmt --check? (skip fmt, do) cargo clippy -D warnings, cargo test (ubuntu needs webkit deps? use macos-latest runner to keep it simple).
- [x] release.yml: on tag `v*` → `tauri-apps/tauri-action@v0` matrix: macos-latest (`--target universal-apple-darwin`), windows-latest; `GITHUB_TOKEN` release with .dmg + NSIS .exe.
- [x] Commit `ci: add build checks and tagged release pipeline` + `docs: add README`.

### Task 10: Verification & ship

- [x] Full local gate: `npm run build`, `vitest run`, `cargo test`, `cargo clippy -- -D warnings`, `cargo check --target x86_64-pc-windows-msvc`, `cargo tauri build` (macOS artifact opens), browser UI pass, dependency audit (`npm audit`, `cargo audit` if quick).
- [x] Create private GitHub repo `pingwatch` (gh), push main + branch, open PR (template per git-workflow), merge, tag `v0.1.0`, push tag, watch release workflow to green, verify artifacts attached.
