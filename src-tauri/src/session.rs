use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;

/// One ping result. `rtt_ms == None` means the request timed out (packet loss).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub target_id: String,
    pub seq: u64,
    pub t_utc_ms: i64,
    pub rtt_ms: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TargetKind {
    Gateway,
    Internet,
    Custom,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub id: String,
    pub label: String,
    pub address: String,
    pub kind: TargetKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub hostname: String,
    pub os: String,
    pub connection_label: String,
}

/// A recorded monitoring session; the exported JSON is this struct verbatim.
/// All timestamps are UTC milliseconds; `timezone` is the recording machine's
/// IANA zone so importers can display localized wall-clock times.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub schema_version: u32,
    pub id: String,
    pub started_utc_ms: i64,
    pub ended_utc_ms: Option<i64>,
    pub interval_ms: u64,
    pub timeout_ms: u64,
    pub timezone: String,
    pub device: DeviceInfo,
    pub targets: Vec<Target>,
    pub samples: Vec<Sample>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_session() -> Session {
        Session {
            schema_version: SCHEMA_VERSION,
            id: "s-1".into(),
            started_utc_ms: 1_752_800_000_000,
            ended_utc_ms: Some(1_752_800_600_000),
            interval_ms: 500,
            timeout_ms: 1000,
            timezone: "Europe/Berlin".into(),
            device: DeviceInfo {
                hostname: "test-host".into(),
                os: "macos".into(),
                connection_label: "Wi-Fi".into(),
            },
            targets: vec![Target {
                id: "t-gw".into(),
                label: "Router".into(),
                address: "192.168.1.1".into(),
                kind: TargetKind::Gateway,
            }],
            samples: vec![
                Sample {
                    target_id: "t-gw".into(),
                    seq: 0,
                    t_utc_ms: 1_752_800_000_500,
                    rtt_ms: Some(3.2),
                },
                Sample {
                    target_id: "t-gw".into(),
                    seq: 1,
                    t_utc_ms: 1_752_800_001_000,
                    rtt_ms: None,
                },
            ],
        }
    }

    #[test]
    fn session_json_round_trip() {
        let session = sample_session();
        let json = serde_json::to_string(&session).unwrap();
        let back: Session = serde_json::from_str(&json).unwrap();
        assert_eq!(session, back);
    }

    #[test]
    fn session_json_uses_camel_case_and_null_loss() {
        let json = serde_json::to_string(&sample_session()).unwrap();
        assert!(json.contains("\"schemaVersion\":1"));
        assert!(json.contains("\"tUtcMs\""));
        assert!(json.contains("\"rttMs\":null"));
        assert!(json.contains("\"kind\":\"gateway\""));
        assert!(json.contains("\"connectionLabel\":\"Wi-Fi\""));
    }
}
