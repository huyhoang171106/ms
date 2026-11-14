use std::path::PathBuf;
use std::sync::Arc;

use ms_protocol::{
    CallParams, ContextBundleParams, ContextBundleResult, DeleteFileParams, EditParams, ErrorCode,
    Operation, OutlineFile, OutlineParams, PatchResult, ReadFormat, ReadParams, ReadResult,
    SearchMatch, SearchParams, SessionCapabilities, SessionOpenParams, TxUndoParams,
    WriteFileParams,
};
use ms_runtime::{CancelToken, Runtime};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::exec::{exec_and_distill, read_log};

pub async fn run_mcp_stdio_server(
    runtime: Arc<Runtime>,
    workspace_root: PathBuf,
) -> Result<(), std::io::Error> {
    let caps = runtime.capabilities();
    let session = runtime
        .open_session(&SessionOpenParams {
            capabilities: Some(SessionCapabilities {
                allow_write: Some(caps.allow_write),
                ..SessionCapabilities::default()
            }),
        })
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    let session_id = session.session_id;

    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut reader = BufReader::new(stdin);
    let mut line = String::new();

    loop {
        line.clear();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let req: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => {
                let err_resp = json!({
                    "jsonrpc": "2.0",
                    "id": Value::Null,
                    "error": { "code": -32700, "message": format!("Parse error: {e}") }
                });
                write_json_line(&mut stdout, &err_resp).await?;
                continue;
            }
        };

        let id = req.get("id").cloned();
        let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let params = req.get("params").cloned().unwrap_or_else(|| json!({}));

        // Notifications have no `id` and expect no response.
        if id.is_none()
            || id.as_ref().is_some_and(Value::is_null) && method.starts_with("notifications/")
        {
            continue;
        }
        let req_id = id.unwrap_or(Value::Null);

        let response = match method {
            "initialize" => json!({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": { "tools": {} },
                    "serverInfo": {
                        "name": "ms",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }
            }),
            "ping" => json!({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {}
            }),
            "tools/list" => json!({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": { "tools": tool_definitions() }
            }),
            "tools/call" => {
                let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
                let args = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let (text, is_error) =
                    dispatch_tool_call(&runtime, &session_id, &workspace_root, name, args).await;
                let mut result = json!({
                    "content": [{ "type": "text", "text": text }]
                });
                if is_error {
                    result["isError"] = json!(true);
                }
                json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": result
                })
            }
            _ => json!({
                "jsonrpc": "2.0",
                "id": req_id,
                "error": { "code": -32601, "message": format!("Method not found: {method}") }
            }),
        };

        write_json_line(&mut stdout, &response).await?;
    }

    let _ = runtime.close_session(&session_id);
    Ok(())
}

async fn write_json_line(
    stdout: &mut tokio::io::Stdout,
    val: &Value,
) -> Result<(), std::io::Error> {
    let mut s = serde_json::to_string(val).map_err(std::io::Error::other)?;
    s.push('\n');
    stdout.write_all(s.as_bytes()).await?;
    stdout.flush().await
}

fn tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "ms_exec",
            "description": "Run a shell/test/build command with ANSI stripping, command-aware distillation, and auto-attached hashline snippets on failure. Saves full raw output under a log_id.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Command to execute in workspace root" },
                    "timeoutMs": { "type": "integer", "description": "Timeout in ms (default 60000)" }
                },
                "required": ["command"]
            }
        }),
        json!({
            "name": "ms_log",
            "description": "Inspect persisted raw command log by log_id on demand.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Log ID returned by ms_exec" },
                    "tail": { "type": "integer", "description": "Last N lines to return (default 200)" },
                    "grep": { "type": "string", "description": "Optional regex/substring filter" }
                },
                "required": ["id"]
            }
        }),
        json!({
            "name": "ms_read",
            "description": "Read a workspace file in compact hashline format (rev + line:tag| text).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "startLine": { "type": "integer", "description": "1-based start line (default 1)" },
                    "lineCount": { "type": "integer", "description": "Max lines (default 200)" }
                },
                "required": ["path"]
            }
        }),
        json!({
            "name": "ms_search",
            "description": "Fast regex/literal search across workspace files, grouped by file.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "path": { "type": "string" },
                    "regex": { "type": "boolean" },
                    "caseSensitive": { "type": "boolean" },
                    "maxMatches": { "type": "integer" },
                    "contextLines": { "type": "integer" }
                },
                "required": ["query"]
            }
        }),
        json!({
            "name": "ms_edit",
            "description": "Atomically edit a file via line-range+tag ({startLine,endLine,startTag?,endTag?,replacement}), unique {oldText,newText}, or byte-range. Self-heals on conflict.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "expectedRevision": { "type": "string" },
                    "edits": { "type": "array", "items": { "type": "object" } },
                    "dryRun": { "type": "boolean" }
                },
                "required": ["path", "edits"]
            }
        }),
        json!({
            "name": "ms_write",
            "description": "Atomically create or overwrite a workspace file with WAL journaling and undo.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string" },
                    "overwrite": { "type": "boolean" },
                    "expectedRevision": { "type": "string" }
                },
                "required": ["path", "content"]
            }
        }),
        json!({
            "name": "ms_delete",
            "description": "Atomically delete a workspace file with WAL preimage and undo.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "expectedRevision": { "type": "string" }
                },
                "required": ["path"]
            }
        }),
        json!({
            "name": "ms_undo",
            "description": "Undo the latest un-undone workspace mutation via durable WAL.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "transactionId": { "type": "string" }
                }
            }
        }),
        json!({
            "name": "ms_outline",
            "description": "Get multi-language repo map and key symbols (Rust/TS/JS/Python/Go) in 1 call.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "maxFiles": { "type": "integer" }
                }
            }
        }),
        json!({
            "name": "ms_context",
            "description": "1-shot context bundle: target hashline snippet, local imports/symbols, and related tests.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "line": { "type": "integer" },
                    "symbol": { "type": "string" },
                    "radius": { "type": "integer" }
                },
                "required": ["path"]
            }
        }),
    ]
}

async fn dispatch_tool_call(
    runtime: &Runtime,
    session_id: &str,
    workspace_root: &std::path::Path,
    name: &str,
    args: Value,
) -> (String, bool) {
    match name {
        "ms_exec" => {
            let cmd = match args.get("command").and_then(|v| v.as_str()) {
                Some(c) if !c.trim().is_empty() => c.to_string(),
                _ => return ("missing required 'command' string".to_string(), true),
            };
            let timeout_ms = args
                .get("timeoutMs")
                .and_then(|v| v.as_u64())
                .unwrap_or(60_000);
            match exec_and_distill(workspace_root, &[cmd], timeout_ms).await {
                Ok(res) => (res.distilled, res.exit_code != 0 || res.timed_out),
                Err(e) => (e, true),
            }
        }
        "ms_log" => {
            let id = match args.get("id").and_then(|v| v.as_str()) {
                Some(id) => id,
                None => return ("missing required 'id' string".to_string(), true),
            };
            let tail = args
                .get("tail")
                .and_then(|v| v.as_u64())
                .map(|n| n as usize);
            let grep = args.get("grep").and_then(|v| v.as_str());
            match read_log(id, tail, grep) {
                Ok(text) => (text, false),
                Err(e) => (e, true),
            }
        }
        "ms_read" => {
            let path = match args.get("path").and_then(|v| v.as_str()) {
                Some(p) => p.to_string(),
                None => return ("missing 'path'".to_string(), true),
            };
            let start_line = args.get("startLine").and_then(|v| v.as_u64());
            let line_count = args.get("lineCount").and_then(|v| v.as_u64()).or(Some(200));
            let op = Operation::Read(ReadParams {
                path,
                start_line,
                line_count,
                format: Some(ReadFormat::Hashline),
            });
            match call_runtime(runtime, session_id, op).await {
                Ok(out) => {
                    if let Some(res_val) = out.result
                        && let Ok(rr) = serde_json::from_value::<ReadResult>(res_val)
                        && let Some(hl) = rr.hashline
                    {
                        return (hl, false);
                    }
                    ("unexpected read response".to_string(), true)
                }
                Err(e) => (e, true),
            }
        }
        "ms_search" => {
            let params: SearchParams = match serde_json::from_value(args) {
                Ok(p) => p,
                Err(e) => return (format!("invalid search params: {e}"), true),
            };
            match call_runtime(runtime, session_id, Operation::Search(params)).await {
                Ok(out) => {
                    let mut matches = Vec::with_capacity(out.records.len());
                    for r in out.records {
                        if let Ok(m) = serde_json::from_value::<SearchMatch>(r) {
                            matches.push(m);
                        }
                    }
                    if matches.is_empty() {
                        return ("no matches".to_string(), false);
                    }
                    let mut text = String::new();
                    let mut cur_path = String::new();
                    for m in &matches {
                        if m.path != cur_path {
                            if !cur_path.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(&format!("## {}\n", m.path));
                            cur_path = m.path.clone();
                        }
                        text.push_str(&format!(
                            "{}:{}| {}\n",
                            m.line_number, m.line_tag, m.line_text
                        ));
                    }
                    if out.truncated {
                        text.push_str("... (truncated)");
                    }
                    (text.trim_end().to_string(), false)
                }
                Err(e) => (e, true),
            }
        }
        "ms_edit" => {
            let params: EditParams = match serde_json::from_value(args) {
                Ok(p) => p,
                Err(e) => return (format!("invalid edit params: {e}"), true),
            };
            match call_runtime(runtime, session_id, Operation::Edit(params)).await {
                Ok(out) => {
                    if let Some(val) = out.result
                        && let Ok(pr) = serde_json::from_value::<PatchResult>(val)
                    {
                        let tx = pr.transaction_id.as_deref().unwrap_or("dry-run");
                        return (
                            format!(
                                "ok path:{} edits:{} delta:{} rev:{} tx:{}",
                                pr.path, pr.edits_applied, pr.bytes_delta, pr.after_revision, tx
                            ),
                            false,
                        );
                    }
                    ("edited".to_string(), false)
                }
                Err(e) => (e, true),
            }
        }
        "ms_write" => {
            let params: WriteFileParams = match serde_json::from_value(args) {
                Ok(p) => p,
                Err(e) => return (format!("invalid write params: {e}"), true),
            };
            match call_runtime(runtime, session_id, Operation::WriteFile(params)).await {
                Ok(out) => {
                    let s = out
                        .result
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "ok".to_string());
                    (s, false)
                }
                Err(e) => (e, true),
            }
        }
        "ms_delete" => {
            let params: DeleteFileParams = match serde_json::from_value(args) {
                Ok(p) => p,
                Err(e) => return (format!("invalid delete params: {e}"), true),
            };
            match call_runtime(runtime, session_id, Operation::DeleteFile(params)).await {
                Ok(out) => {
                    let s = out
                        .result
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "ok".to_string());
                    (s, false)
                }
                Err(e) => (e, true),
            }
        }
        "ms_undo" => {
            let params: TxUndoParams = match serde_json::from_value(args) {
                Ok(p) => p,
                Err(e) => return (format!("invalid undo params: {e}"), true),
            };
            match call_runtime(runtime, session_id, Operation::TxUndo(params)).await {
                Ok(out) => {
                    let s = out
                        .result
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "undone".to_string());
                    (s, false)
                }
                Err(e) => (e, true),
            }
        }
        "ms_outline" => {
            let params: OutlineParams = serde_json::from_value(args).unwrap_or_default();
            match call_runtime(runtime, session_id, Operation::Outline(params)).await {
                Ok(out) => {
                    let mut text = String::new();
                    for r in out.records {
                        if let Ok(f) = serde_json::from_value::<OutlineFile>(r) {
                            text.push_str(&format!("{} ({}L)\n", f.path, f.lines));
                            for s in f.symbols {
                                text.push_str(&format!("  {}: {}\n", s.line, s.signature));
                            }
                        }
                    }
                    if text.is_empty() {
                        text.push_str("(no supported source files)");
                    }
                    (text.trim_end().to_string(), false)
                }
                Err(e) => (e, true),
            }
        }
        "ms_context" => {
            let params: ContextBundleParams = match serde_json::from_value(args) {
                Ok(p) => p,
                Err(e) => return (format!("invalid context params: {e}"), true),
            };
            match call_runtime(runtime, session_id, Operation::ContextBundle(params)).await {
                Ok(out) => {
                    if let Some(val) = out.result
                        && let Ok(cb) = serde_json::from_value::<ContextBundleResult>(val)
                    {
                        let mut text = format!("{}\n", cb.hashline_snippet);
                        if !cb.imports.is_empty() {
                            text.push_str("\n# imports\n");
                            for imp in &cb.imports {
                                text.push_str(imp);
                                text.push('\n');
                            }
                        }
                        if !cb.local_symbols.is_empty() {
                            text.push_str("\n# symbols\n");
                            for s in &cb.local_symbols {
                                text.push_str(&format!("{}: {}\n", s.line, s.signature));
                            }
                        }
                        if !cb.related_tests.is_empty() {
                            text.push_str("\n# related tests\n");
                            for t in &cb.related_tests {
                                text.push_str(&format!("## {}\n{}\n", t.path, t.snippet));
                            }
                        }
                        return (text.trim_end().to_string(), false);
                    }
                    ("unexpected context response".to_string(), true)
                }
                Err(e) => (e, true),
            }
        }
        _ => (format!("unknown tool: {name}"), true),
    }
}

async fn call_runtime(
    runtime: &Runtime,
    session_id: &str,
    operation: Operation,
) -> Result<ms_runtime::ExecutionOutput, String> {
    let call = CallParams {
        session_id: session_id.to_string(),
        operation,
        operation_id: None,
        deadline_ms: None,
    };
    runtime
        .execute_call(&call, CancelToken::new())
        .await
        .map_err(|e| {
            let info = e.to_error_info();
            let code = match info.code {
                ErrorCode::EConflict => "E_CONFLICT",
                ErrorCode::EPolicyDenied => "E_POLICY_DENIED",
                ErrorCode::ENotFound => "E_NOT_FOUND",
                ErrorCode::EInvalidRequest => "E_INVALID_REQUEST",
                _ => "ERROR",
            };
            match info.hint {
                Some(h) => format!("[{code}] {}\n{h}", info.message),
                None => format!("[{code}] {}", info.message),
            }
        })
}
