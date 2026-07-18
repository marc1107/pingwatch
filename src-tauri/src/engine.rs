use crate::ping::{ping_once, PingOutcome};
use crate::session::{Sample, Target};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::task::JoinHandle;

pub const BATCH_FLUSH_MS: u64 = 250;

/// Running monitoring state: one ping loop per target plus a flusher task
/// that emits accumulated samples to the frontend as `ping-batch` events.
#[derive(Default)]
pub struct Engine {
    tasks: Vec<JoinHandle<()>>,
}

#[derive(Default)]
struct Batch(Mutex<Vec<Sample>>);

fn now_utc_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Engine {
    pub fn is_running(&self) -> bool {
        !self.tasks.is_empty()
    }

    pub fn stop(&mut self) {
        for task in self.tasks.drain(..) {
            task.abort();
        }
    }

    /// Resolve all targets, then spawn one ping loop per target and a
    /// flusher that emits batched samples every `BATCH_FLUSH_MS`.
    pub fn start(
        &mut self,
        app: AppHandle,
        targets: Vec<Target>,
        resolved: HashMap<String, IpAddr>,
        interval_ms: u64,
        timeout_ms: u64,
    ) {
        self.stop();
        let batch = std::sync::Arc::new(Batch::default());

        for target in targets {
            let Some(addr) = resolved.get(&target.id).copied() else {
                continue;
            };
            let batch = batch.clone();
            let timeout = Duration::from_millis(timeout_ms);
            self.tasks.push(tokio::spawn(async move {
                let mut ticker =
                    tokio::time::interval(Duration::from_millis(interval_ms.max(100)));
                ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                let mut seq: u64 = 0;
                loop {
                    ticker.tick().await;
                    let target_id = target.id.clone();
                    let batch = batch.clone();
                    let sent_at = now_utc_ms();
                    let current_seq = seq;
                    seq += 1;
                    // Fire and record independently so a slow/timed-out ping
                    // never delays the next tick.
                    tokio::spawn(async move {
                        let rtt_ms = match ping_once(addr, timeout).await {
                            PingOutcome::Rtt(rtt) => Some(rtt),
                            PingOutcome::Timeout | PingOutcome::Error(_) => None,
                        };
                        batch.0.lock().unwrap().push(Sample {
                            target_id,
                            seq: current_seq,
                            t_utc_ms: sent_at,
                            rtt_ms,
                        });
                    });
                }
            }));
        }

        self.tasks.push(tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_millis(BATCH_FLUSH_MS));
            loop {
                ticker.tick().await;
                let samples: Vec<Sample> = std::mem::take(&mut *batch.0.lock().unwrap());
                if !samples.is_empty() {
                    let _ = app.emit("ping-batch", &samples);
                }
            }
        }));
    }
}
