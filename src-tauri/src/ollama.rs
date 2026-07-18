use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

const OLLAMA_BASE: &str = "http://localhost:11434";
const STATUS_TIMEOUT_MS: u64 = 1500;

/// Pending cancellation senders for in-flight `ollama_generate` calls, keyed
/// by the frontend-supplied request id.
#[derive(Default)]
pub struct OllamaState(pub Mutex<HashMap<String, oneshot::Sender<()>>>);

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .build()
            .expect("failed to build reqwest client")
    })
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaModel {
    pub name: String,
    pub size_bytes: u64,
    pub parameter_size: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaStatus {
    pub reachable: bool,
    pub version: Option<String>,
    pub binary_installed: bool,
    pub models: Vec<OllamaModel>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PullProgress {
    model: String,
    status: String,
    completed: Option<u64>,
    total: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GenerateChunk {
    request_id: String,
    content: String,
    done: bool,
}

#[derive(Deserialize)]
struct VersionResponse {
    version: String,
}

#[derive(Deserialize)]
struct TagsResponse {
    models: Vec<TagsModel>,
}

#[derive(Deserialize)]
struct TagsModel {
    name: String,
    size: u64,
    details: Option<TagsModelDetails>,
}

#[derive(Deserialize)]
struct TagsModelDetails {
    parameter_size: Option<String>,
}

#[derive(Deserialize)]
struct PullLine {
    status: Option<String>,
    total: Option<u64>,
    completed: Option<u64>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct ChatLine {
    message: Option<ChatMessage>,
    #[serde(default)]
    done: bool,
}

#[derive(Deserialize)]
struct ChatMessage {
    content: String,
}

/// Parses the body of a GET /api/tags response into our model list.
fn parse_tags_response(json: &str) -> Result<Vec<OllamaModel>, String> {
    let parsed: TagsResponse =
        serde_json::from_str(json).map_err(|e| format!("cannot parse /api/tags response: {e}"))?;
    Ok(parsed
        .models
        .into_iter()
        .map(|m| OllamaModel {
            name: m.name,
            size_bytes: m.size,
            parameter_size: m.details.and_then(|d| d.parameter_size),
        })
        .collect())
}

/// Appends `chunk` to `buffer` and pulls out every complete (`\n`-terminated)
/// line, leaving any trailing partial line in `buffer` for the next call.
/// Blank lines are dropped since Ollama's NDJSON stream never emits them
/// meaningfully.
fn extract_lines(buffer: &mut String, chunk: &str) -> Vec<String> {
    buffer.push_str(chunk);
    let mut lines = Vec::new();
    while let Some(pos) = buffer.find('\n') {
        let line = buffer[..pos].trim().to_string();
        buffer.drain(..=pos);
        if !line.is_empty() {
            lines.push(line);
        }
    }
    lines
}

#[cfg(unix)]
fn binary_installed() -> bool {
    std::process::Command::new("which")
        .arg("ollama")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(windows)]
fn binary_installed() -> bool {
    std::process::Command::new("where")
        .arg("ollama")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

async fn fetch_models() -> Result<Vec<OllamaModel>, String> {
    let resp = client()
        .get(format!("{OLLAMA_BASE}/api/tags"))
        .timeout(Duration::from_millis(STATUS_TIMEOUT_MS))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let text = resp.text().await.map_err(|e| e.to_string())?;
    parse_tags_response(&text)
}

/// Never errors just because Ollama isn't running: an unreachable server is
/// reported as `reachable: false`, not a `Result::Err`.
#[tauri::command]
pub async fn ollama_status() -> Result<OllamaStatus, String> {
    let installed = binary_installed();

    let version_resp = client()
        .get(format!("{OLLAMA_BASE}/api/version"))
        .timeout(Duration::from_millis(STATUS_TIMEOUT_MS))
        .send()
        .await;

    let Ok(resp) = version_resp else {
        return Ok(OllamaStatus {
            reachable: false,
            version: None,
            binary_installed: installed,
            models: Vec::new(),
        });
    };

    if !resp.status().is_success() {
        return Ok(OllamaStatus {
            reachable: false,
            version: None,
            binary_installed: installed,
            models: Vec::new(),
        });
    }

    let version = resp.json::<VersionResponse>().await.ok().map(|v| v.version);
    let models = fetch_models().await.unwrap_or_default();

    Ok(OllamaStatus {
        reachable: true,
        version,
        binary_installed: installed,
        models,
    })
}

/// Streams a `POST /api/pull`, emitting `ollama-pull-progress` events as
/// NDJSON progress lines arrive. Resolves once a `{"status":"success"}` line
/// is seen; an `{"error": ...}` line fails the command. No overall timeout —
/// model downloads can be gigabytes.
#[tauri::command]
pub async fn ollama_pull(app: AppHandle, model: String) -> Result<(), String> {
    let body = serde_json::json!({ "model": model, "stream": true });
    let resp = client()
        .post(format!("{OLLAMA_BASE}/api/pull"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("cannot reach Ollama at {OLLAMA_BASE}: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Ollama returned {status}: {text}"));
    }

    let mut stream = resp.bytes_stream();
    let mut line_buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("stream error while pulling {model}: {e}"))?;
        let text = String::from_utf8_lossy(&bytes);
        for line in extract_lines(&mut line_buffer, &text) {
            let parsed: PullLine = serde_json::from_str(&line)
                .map_err(|e| format!("cannot parse Ollama pull response: {e}"))?;
            if let Some(error) = parsed.error {
                return Err(error);
            }
            let status = parsed.status.unwrap_or_default();
            let _ = app.emit(
                "ollama-pull-progress",
                PullProgress {
                    model: model.clone(),
                    status: status.clone(),
                    completed: parsed.completed,
                    total: parsed.total,
                },
            );
            if status == "success" {
                return Ok(());
            }
        }
    }

    Ok(())
}

/// Runs the actual `/api/chat` request/stream loop for [`ollama_generate`],
/// racing each chunk against `cancel_rx` so a cancellation can interrupt the
/// read at any point.
async fn run_generate(
    app: &AppHandle,
    request_id: &str,
    model: &str,
    prompt: &str,
    format_schema: serde_json::Value,
    cancel_rx: &mut oneshot::Receiver<()>,
) -> Result<String, String> {
    let body = serde_json::json!({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": true,
        "format": format_schema,
        "options": {"temperature": 0.2, "num_ctx": 8192},
    });

    let resp = client()
        .post(format!("{OLLAMA_BASE}/api/chat"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("cannot reach Ollama at {OLLAMA_BASE}: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Ollama returned {status}: {text}"));
    }

    let mut stream = resp.bytes_stream();
    let mut line_buffer = String::new();
    let mut full_content = String::new();

    loop {
        tokio::select! {
            biased;
            _ = &mut *cancel_rx => {
                return Err("cancelled".into());
            }
            chunk = stream.next() => {
                let Some(chunk) = chunk else { break; };
                let bytes = chunk.map_err(|e| format!("stream error while generating: {e}"))?;
                let text = String::from_utf8_lossy(&bytes);
                for line in extract_lines(&mut line_buffer, &text) {
                    let parsed: ChatLine = serde_json::from_str(&line)
                        .map_err(|e| format!("cannot parse Ollama chat response: {e}"))?;
                    if let Some(message) = parsed.message {
                        if !message.content.is_empty() {
                            full_content.push_str(&message.content);
                            let _ = app.emit(
                                "ollama-generate-chunk",
                                GenerateChunk {
                                    request_id: request_id.to_string(),
                                    content: message.content,
                                    done: false,
                                },
                            );
                        }
                    }
                    if parsed.done {
                        let _ = app.emit(
                            "ollama-generate-chunk",
                            GenerateChunk {
                                request_id: request_id.to_string(),
                                content: String::new(),
                                done: true,
                            },
                        );
                        return Ok(full_content);
                    }
                }
            }
        }
    }

    Ok(full_content)
}

/// Streams a `POST /api/chat` completion, emitting `ollama-generate-chunk`
/// events as content arrives and returning the full accumulated text.
/// Cancellable via [`ollama_cancel`] using the same `request_id`.
#[tauri::command]
pub async fn ollama_generate(
    app: AppHandle,
    state: State<'_, OllamaState>,
    request_id: String,
    model: String,
    prompt: String,
    format_schema: serde_json::Value,
) -> Result<String, String> {
    let (cancel_tx, mut cancel_rx) = oneshot::channel();
    {
        state
            .0
            .lock()
            .unwrap()
            .insert(request_id.clone(), cancel_tx);
    }

    let result = run_generate(&app, &request_id, &model, &prompt, format_schema, &mut cancel_rx).await;

    state.0.lock().unwrap().remove(&request_id);
    result
}

/// Cancels an in-flight [`ollama_generate`] call. A no-op (still `Ok`) if
/// the request already finished or never existed.
#[tauri::command]
pub async fn ollama_cancel(state: State<'_, OllamaState>, request_id: String) -> Result<(), String> {
    if let Some(tx) = state.0.lock().unwrap().remove(&request_id) {
        let _ = tx.send(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tags_response_into_models() {
        let json = r#"{
            "models": [
                {
                    "name": "gemma3:4b",
                    "model": "gemma3:4b",
                    "modified_at": "2024-01-01T00:00:00Z",
                    "size": 3300000000,
                    "digest": "abc123",
                    "details": {
                        "parent_model": "",
                        "format": "gguf",
                        "family": "gemma3",
                        "families": ["gemma3"],
                        "parameter_size": "4.3B",
                        "quantization_level": "Q4_0"
                    }
                }
            ]
        }"#;
        let models = parse_tags_response(json).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].name, "gemma3:4b");
        assert_eq!(models[0].size_bytes, 3_300_000_000);
        assert_eq!(models[0].parameter_size.as_deref(), Some("4.3B"));
    }

    #[test]
    fn parses_tags_response_with_missing_details() {
        let json = r#"{"models":[{"name":"llama3","size":100}]}"#;
        let models = parse_tags_response(json).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].parameter_size, None);
    }

    #[test]
    fn parses_empty_tags_response() {
        let json = r#"{"models":[]}"#;
        assert_eq!(parse_tags_response(json).unwrap(), Vec::new());
    }

    #[test]
    fn rejects_malformed_tags_response() {
        assert!(parse_tags_response("not json").is_err());
    }

    #[test]
    fn extract_lines_handles_split_across_chunks() {
        let mut buf = String::new();
        let mut all = Vec::new();
        all.extend(extract_lines(&mut buf, "{\"status\":\"pulling\"}\n{\"stat"));
        all.extend(extract_lines(&mut buf, "us\":\"success\"}\n"));
        assert_eq!(
            all,
            vec![
                "{\"status\":\"pulling\"}".to_string(),
                "{\"status\":\"success\"}".to_string(),
            ]
        );
        assert!(buf.is_empty());
    }

    #[test]
    fn extract_lines_skips_blank_lines_and_buffers_partial_line() {
        let mut buf = String::new();
        let lines = extract_lines(&mut buf, "\n\n{\"a\":1}\n\n{\"b\":2");
        assert_eq!(lines, vec!["{\"a\":1}".to_string()]);
        assert_eq!(buf, "{\"b\":2");
    }

    #[test]
    fn ollama_model_json_uses_camel_case() {
        let model = OllamaModel {
            name: "gemma3:4b".into(),
            size_bytes: 3_300_000_000,
            parameter_size: Some("4.3B".into()),
        };
        let json = serde_json::to_string(&model).unwrap();
        assert!(json.contains("\"sizeBytes\":3300000000"));
        assert!(json.contains("\"parameterSize\":\"4.3B\""));
        let back: OllamaModel = serde_json::from_str(&json).unwrap();
        assert_eq!(model, back);
    }

    #[test]
    fn ollama_status_json_uses_camel_case() {
        let status = OllamaStatus {
            reachable: true,
            version: Some("0.5.1".into()),
            binary_installed: true,
            models: vec![OllamaModel {
                name: "gemma3:4b".into(),
                size_bytes: 3_300_000_000,
                parameter_size: None,
            }],
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"binaryInstalled\":true"));
        assert!(json.contains("\"reachable\":true"));
        let back: OllamaStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(status, back);
    }
}
