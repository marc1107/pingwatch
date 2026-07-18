use crate::engine::Engine;
use crate::gateway::default_gateway_ip;
use crate::session::{Session, Target, SCHEMA_VERSION};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::net::IpAddr;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparisonMeta {
    pub id: String,
    pub name: String,
    pub saved_utc_ms: i64,
}

#[derive(Serialize, Deserialize)]
struct StoredComparison {
    meta: ComparisonMeta,
    sessions: Vec<Session>,
}

fn now_utc_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// A short, filesystem-safe id derived from the comparison name and the
/// current time. Collisions are astronomically unlikely and harmless (the
/// second save would simply overwrite the first), so no retry logic exists.
fn generate_comparison_id(name: &str) -> String {
    let mut hasher = DefaultHasher::new();
    name.hash(&mut hasher);
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn valid_comparison_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn comparisons_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {e}"))?;
    Ok(base.join("comparisons"))
}

/// Builds the on-disk path for a comparison id, rejecting anything that
/// isn't `[a-z0-9-]` so a malicious id can never escape the comparisons
/// directory (no `.`, `/`, or `\`).
fn comparison_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    if !valid_comparison_id(id) {
        return Err(format!("invalid comparison id: {id}"));
    }
    Ok(comparisons_dir(app)?.join(format!("{id}.json")))
}

#[tauri::command]
pub async fn save_comparison(
    app: AppHandle,
    name: String,
    sessions: Vec<Session>,
) -> Result<ComparisonMeta, String> {
    let dir = comparisons_dir(&app)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("cannot create comparisons dir: {e}"))?;
    let id = generate_comparison_id(&name);
    let meta = ComparisonMeta {
        id: id.clone(),
        name,
        saved_utc_ms: now_utc_ms(),
    };
    let stored = StoredComparison {
        meta: meta.clone(),
        sessions,
    };
    let json = serde_json::to_string_pretty(&stored).map_err(|e| e.to_string())?;
    let path = comparison_path(&app, &id)?;
    tokio::fs::write(&path, json)
        .await
        .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    Ok(meta)
}

#[tauri::command]
pub async fn list_comparisons(app: AppHandle) -> Result<Vec<ComparisonMeta>, String> {
    let dir = comparisons_dir(&app)?;
    let mut read_dir = match tokio::fs::read_dir(&dir).await {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("cannot read comparisons dir: {e}")),
    };
    let mut metas = Vec::new();
    while let Some(entry) = read_dir
        .next_entry()
        .await
        .map_err(|e| format!("cannot read comparisons dir: {e}"))?
    {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = tokio::fs::read_to_string(&path).await else {
            continue;
        };
        let Ok(stored) = serde_json::from_str::<StoredComparison>(&raw) else {
            continue;
        };
        metas.push(stored.meta);
    }
    metas.sort_by_key(|m| std::cmp::Reverse(m.saved_utc_ms));
    Ok(metas)
}

#[tauri::command]
pub async fn load_comparison(app: AppHandle, id: String) -> Result<Vec<Session>, String> {
    let path = comparison_path(&app, &id)?;
    let raw = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("cannot read comparison {id}: {e}"))?;
    let stored: StoredComparison =
        serde_json::from_str(&raw).map_err(|e| format!("corrupt comparison file: {e}"))?;
    Ok(stored.sessions)
}

#[tauri::command]
pub async fn delete_comparison(app: AppHandle, id: String) -> Result<(), String> {
    let path = comparison_path(&app, &id)?;
    match tokio::fs::remove_file(&path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("cannot delete comparison {id}: {e}")),
    }
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

    #[test]
    fn comparison_meta_json_round_trip_uses_camel_case() {
        let meta = ComparisonMeta {
            id: "abc123".into(),
            name: "Home vs Office".into(),
            saved_utc_ms: 1_752_800_000_000,
        };
        let json = serde_json::to_string(&meta).unwrap();
        assert!(json.contains("\"savedUtcMs\":1752800000000"));
        assert!(json.contains("\"id\":\"abc123\""));
        let back: ComparisonMeta = serde_json::from_str(&json).unwrap();
        assert_eq!(meta, back);
    }

    #[test]
    fn comparison_id_validation_rejects_path_traversal() {
        assert!(valid_comparison_id("abc123"));
        assert!(valid_comparison_id("abc-123"));
        assert!(!valid_comparison_id(""));
        assert!(!valid_comparison_id("../../etc/passwd"));
        assert!(!valid_comparison_id("abc/def"));
        assert!(!valid_comparison_id("ABC123"));
        assert!(!valid_comparison_id("abc.json"));
    }

    #[test]
    fn generated_ids_are_valid_and_distinct() {
        let a = generate_comparison_id("test");
        let b = generate_comparison_id("test");
        assert!(valid_comparison_id(&a));
        assert_ne!(a, b, "ids generated at different times should differ");
    }
}
