use crate::engine::Engine;
use crate::gateway::default_gateway_ip;
use crate::session::{Session, Target, SCHEMA_VERSION};
use serde::Serialize;
use std::collections::HashMap;
use std::net::IpAddr;
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

pub struct EngineState(pub Mutex<Engine>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDefaults {
    pub gateway_ip: Option<String>,
    pub hostname: String,
    pub os: String,
}

#[tauri::command]
pub fn get_defaults() -> AppDefaults {
    AppDefaults {
        gateway_ip: default_gateway_ip().map(|ip| ip.to_string()),
        hostname: hostname(),
        os: std::env::consts::OS.to_string(),
    }
}

fn hostname() -> String {
    #[cfg(unix)]
    {
        std::process::Command::new("hostname")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "unknown".into())
    }
    #[cfg(windows)]
    {
        std::env::var("COMPUTERNAME").unwrap_or_else(|_| "unknown".into())
    }
}

/// Resolve a target address (IP literal or hostname) to an IPv4 address.
async fn resolve(address: &str) -> Result<IpAddr, String> {
    if let Ok(ip) = address.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(_) => Ok(ip),
            IpAddr::V6(_) => Err(format!("{address}: IPv6 targets are not supported")),
        };
    }
    let addrs = tokio::net::lookup_host((address, 0))
        .await
        .map_err(|e| format!("{address}: cannot resolve ({e})"))?;
    addrs
        .map(|sa| sa.ip())
        .find(|ip| ip.is_ipv4())
        .ok_or_else(|| format!("{address}: no IPv4 address found"))
}

#[tauri::command]
pub async fn start_monitoring(
    app: AppHandle,
    state: State<'_, EngineState>,
    targets: Vec<Target>,
    interval_ms: u64,
    timeout_ms: u64,
) -> Result<(), String> {
    if targets.is_empty() {
        return Err("no targets to monitor".into());
    }
    let mut resolved: HashMap<String, IpAddr> = HashMap::new();
    for target in &targets {
        resolved.insert(target.id.clone(), resolve(&target.address).await?);
    }
    let mut engine = state.0.lock().await;
    engine.start(app, targets, resolved, interval_ms, timeout_ms);
    Ok(())
}

#[tauri::command]
pub async fn stop_monitoring(state: State<'_, EngineState>) -> Result<(), String> {
    state.0.lock().await.stop();
    Ok(())
}

#[tauri::command]
pub async fn validate_target(address: String) -> Result<String, String> {
    resolve(&address).await.map(|ip| ip.to_string())
}

#[tauri::command]
pub async fn export_session(path: String, session: Session) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&session).map_err(|e| e.to_string())?;
    tokio::fs::write(&path, json)
        .await
        .map_err(|e| format!("cannot write {path}: {e}"))
}

#[tauri::command]
pub async fn import_session(path: String) -> Result<Session, String> {
    let raw = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("cannot read {path}: {e}"))?;
    let session: Session =
        serde_json::from_str(&raw).map_err(|e| format!("not a PingWatch session file: {e}"))?;
    if session.schema_version > SCHEMA_VERSION {
        return Err(format!(
            "session file uses schema v{} but this app supports up to v{SCHEMA_VERSION}; please update PingWatch",
            session.schema_version
        ));
    }
    Ok(session)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn resolves_ip_literal() {
        assert_eq!(resolve("1.1.1.1").await.unwrap().to_string(), "1.1.1.1");
    }

    #[tokio::test]
    async fn rejects_ipv6_literal() {
        assert!(resolve("::1").await.is_err());
    }

    #[tokio::test]
    async fn rejects_garbage_hostname() {
        assert!(resolve("definitely-not-a-real-host.invalid").await.is_err());
    }
}
