use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use ms_protocol::{
    Capabilities, CompletedStatus, ErrorCode, ErrorInfo, Event, EventPayload, HardLimits,
    Operation, SessionCloseResult, SessionOpenParams, SessionOpenResult,
};
use ms_rpc::{
    ExecuteFuture, ExecutionContext, OperationOutcome, RpcBackend, RpcServerConfig, run_rpc_server,
};
use serde_json::json;
use std::sync::Mutex;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[derive(Clone, Default)]
struct MockBackend {
    exec_count: Arc<AtomicUsize>,
    next_session: Arc<AtomicUsize>,
    sessions: Arc<Mutex<Vec<String>>>,
    delay: Duration,
    records_to_emit: usize,
    record_size: usize,
    allow_write: bool,
}

impl RpcBackend for MockBackend {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            allow_write: self.allow_write,
            ..Capabilities::default()
        }
    }

    fn open_session(&self, params: &SessionOpenParams) -> Result<SessionOpenResult, ErrorInfo> {
        let mut allow_write = self.allow_write;
        let mut limits = HardLimits::default();

        if let Some(req) = &params.capabilities {
            if req.allow_write == Some(true) && !self.allow_write {
                return Err(ErrorInfo::new(
                    ErrorCode::EPolicyDenied,
                    "host policy does not allow writes",
                ));
            }
            if let Some(aw) = req.allow_write {
                allow_write = allow_write && aw;
            }
            if let Some(cl) = &req.limits {
                limits = limits.narrow(cl);
            }
        }

        let seq = self.next_session.fetch_add(1, Ordering::SeqCst) + 1;
        let session_id = format!("s{seq}");
        self.sessions.lock().unwrap().push(session_id.clone());

        Ok(SessionOpenResult {
            session_id,
            allow_write,
            effective_limits: limits,
        })
    }

    fn close_session(&self, session_id: &str) -> Result<SessionCloseResult, ErrorInfo> {
        let mut guard = self.sessions.lock().unwrap();
        if let Some(pos) = guard.iter().position(|s| s == session_id) {
            guard.remove(pos);
            Ok(SessionCloseResult {
                session_id: session_id.to_string(),
                closed: true,
            })
        } else {
            Err(ErrorInfo::new(
                ErrorCode::ESessionNotFound,
                format!("session '{session_id}' not found"),
            ))
        }
    }

    fn execute(&self, ctx: ExecutionContext, operation: Operation) -> ExecuteFuture<'_> {
        Box::pin(async move {
            self.exec_count.fetch_add(1, Ordering::SeqCst);

            if !self.delay.is_zero() {
                let step = Duration::from_millis(5);
                let mut elapsed = Duration::ZERO;
                while elapsed < self.delay {
                    if ctx.cancel.is_cancelled() {
                        return Err(ErrorInfo::new(ErrorCode::ECancelled, "cancelled"));
                    }
                    if std::time::Instant::now() >= ctx.deadline {
                        return Err(ErrorInfo::new(ErrorCode::ETimeout, "deadline exceeded"));
                    }
                    tokio::time::sleep(step).await;
                    elapsed += step;
                }
            }

            let mut records = Vec::with_capacity(self.records_to_emit);
            let pad = "x".repeat(self.record_size);
            for i in 0..self.records_to_emit {
                records.push(json!({ "idx": i, "pad": pad }));
            }

            Ok(OperationOutcome {
                records,
                schema_version: Some("1.0".to_string()),
                diagnostics: Vec::new(),
                result: Some(json!({ "kind": operation.kind_name() })),
                truncated: false,
            })
        })
    }
}

async fn read_events(reader: impl tokio::io::AsyncRead + Unpin) -> Vec<Event> {
    let mut lines = BufReader::new(reader).lines();
    let mut out = Vec::new();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let ev: Event =
            serde_json::from_str(&line).expect("server stdout must be valid Event JSON");
        out.push(ev);
    }
    out
}

#[tokio::test]
async fn t03_invalid_json_duplicate_id_and_unknown_command() {
    let backend = MockBackend::default();
    let exec_count = Arc::clone(&backend.exec_count);

    let (client_in, server_in) = tokio::io::duplex(64 * 1024);
    let (server_out, client_out) = tokio::io::duplex(64 * 1024);

    let srv = tokio::spawn(async move {
        run_rpc_server(backend, server_in, server_out, RpcServerConfig::default()).await
    });

    let mut writer = client_in;
    // 1. Invalid JSON without valid id -> protocol_error
    writer.write_all(b"{not valid json\n").await.unwrap();
    // 2. Unknown method WITH valid id -> completed(error, EUnknownCommand)
    writer
        .write_all(b"{\"id\":\"r-unk\",\"method\":\"bogus\",\"params\":{}}\n")
        .await
        .unwrap();
    // 3. Initialize + duplicate id
    writer
        .write_all(b"{\"id\":\"r-init\",\"method\":\"initialize\",\"params\":{}}\n")
        .await
        .unwrap();
    writer
        .write_all(b"{\"id\":\"r-init\",\"method\":\"initialize\",\"params\":{}}\n")
        .await
        .unwrap();
    // 4. Open session + call + duplicate call id
    writer
        .write_all(b"{\"id\":\"r-open\",\"method\":\"session.open\",\"params\":{}}\n")
        .await
        .unwrap();
    writer
        .write_all(b"{\"id\":\"r-call\",\"method\":\"call\",\"params\":{\"sessionId\":\"s1\",\"operation\":{\"kind\":\"list\"}}}\n")
        .await
        .unwrap();
    writer
        .write_all(b"{\"id\":\"r-call\",\"method\":\"call\",\"params\":{\"sessionId\":\"s1\",\"operation\":{\"kind\":\"list\"}}}\n")
        .await
        .unwrap();

    // Wait for r-call's completed event before closing stdin (since EOF cancels in-flight reads).
    let mut lines = BufReader::new(client_out).lines();
    let mut events = Vec::new();
    let mut saw_call_completed = false;
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let ev: Event =
            serde_json::from_str(&line).expect("server stdout must be valid Event JSON");
        if ev.request_id.as_deref() == Some("r-call")
            && matches!(&ev.payload, EventPayload::Completed { .. })
        {
            saw_call_completed = true;
            events.push(ev);
            break;
        }
        events.push(ev);
    }
    assert!(saw_call_completed);
    drop(writer);
    while let Ok(Some(line)) = lines.next_line().await {
        if !line.trim().is_empty() {
            events.push(serde_json::from_str(&line).unwrap());
        }
    }
    srv.await.unwrap().unwrap();

    // Execute should have run exactly ONCE for r-call, not twice!
    assert_eq!(exec_count.load(Ordering::SeqCst), 1);

    assert!(matches!(
        &events[0].payload,
        EventPayload::ProtocolError {
            code: ErrorCode::EProtocol,
            fatal: false,
            ..
        }
    ));

    let unk = events
        .iter()
        .find(|e| e.request_id.as_deref() == Some("r-unk"))
        .unwrap();
    assert!(matches!(
        &unk.payload,
        EventPayload::Completed {
            status: CompletedStatus::Error,
            error: Some(err),
            ..
        } if err.code == ErrorCode::EUnknownCommand
    ));

    let dup_count = events
        .iter()
        .filter(|e| {
            matches!(
                &e.payload,
                EventPayload::Completed {
                    status: CompletedStatus::Error,
                    error: Some(err),
                    ..
                } if err.code == ErrorCode::EDuplicateRequestId
            )
        })
        .count();
    assert_eq!(dup_count, 2);
}

#[tokio::test]
async fn t03_fragmented_frame_and_oversized_frame_closes_connection() {
    let backend = MockBackend::default();
    let (mut client_in, server_in) = tokio::io::duplex(64 * 1024);
    let (server_out, client_out) = tokio::io::duplex(64 * 1024);

    let cfg = RpcServerConfig {
        max_frame_bytes: 256,
        ..RpcServerConfig::default()
    };

    let srv =
        tokio::spawn(async move { run_rpc_server(backend, server_in, server_out, cfg).await });

    // Send a fragmented valid frame in 3 chunks
    let frame = b"{\"id\":\"r1\",\"method\":\"initialize\",\"params\":{}}\n";
    client_in.write_all(&frame[..10]).await.unwrap();
    tokio::time::sleep(Duration::from_millis(10)).await;
    client_in.write_all(&frame[10..25]).await.unwrap();
    tokio::time::sleep(Duration::from_millis(10)).await;
    client_in.write_all(&frame[25..]).await.unwrap();

    // Send an oversized frame (> 256 bytes)
    let big = format!(
        "{{\"id\":\"r2\",\"method\":\"initialize\",\"params\":{{\"clientName\":\"{}\"}}}}\n",
        "a".repeat(300)
    );
    let _ = client_in.write_all(big.as_bytes()).await;

    let events = read_events(client_out).await;
    srv.await.unwrap().unwrap();

    assert!(events.iter().any(|e| {
        e.request_id.as_deref() == Some("r1")
            && matches!(
                &e.payload,
                EventPayload::Completed {
                    status: CompletedStatus::Ok,
                    ..
                }
            )
    }));
    assert!(events.iter().any(|e| {
        matches!(
            &e.payload,
            EventPayload::ProtocolError {
                code: ErrorCode::EProtocol,
                fatal: true,
                ..
            }
        )
    }));
}

#[tokio::test]
async fn t04_cancel_while_running_and_deadline_while_queued() {
    let backend = MockBackend {
        delay: Duration::from_millis(200),
        ..MockBackend::default()
    };

    let (mut client_in, server_in) = tokio::io::duplex(64 * 1024);
    let (server_out, client_out) = tokio::io::duplex(64 * 1024);

    let cfg = RpcServerConfig {
        max_concurrent_reads_per_connection: 1,
        ..RpcServerConfig::default()
    };

    let srv =
        tokio::spawn(async move { run_rpc_server(backend, server_in, server_out, cfg).await });

    client_in
        .write_all(b"{\"id\":\"r-open\",\"method\":\"session.open\",\"params\":{}}\n")
        .await
        .unwrap();
    // r-run occupies the single read permit (takes 200ms)
    client_in
        .write_all(b"{\"id\":\"r-run\",\"method\":\"call\",\"params\":{\"sessionId\":\"s1\",\"operation\":{\"kind\":\"list\"}}}\n")
        .await
        .unwrap();
    // r-queue is queued behind r-run with a tight 30ms deadline -> must timeout in queue!
    client_in
        .write_all(b"{\"id\":\"r-queue\",\"method\":\"call\",\"params\":{\"sessionId\":\"s1\",\"deadlineMs\":30,\"operation\":{\"kind\":\"list\"}}}\n")
        .await
        .unwrap();

    // Wait briefly, then cancel r-run while it's executing
    tokio::time::sleep(Duration::from_millis(20)).await;
    client_in
        .write_all(
            b"{\"id\":\"r-cancel\",\"method\":\"cancel\",\"params\":{\"requestId\":\"r-run\"}}\n",
        )
        .await
        .unwrap();

    tokio::time::sleep(Duration::from_millis(80)).await;
    drop(client_in);

    let events = read_events(client_out).await;
    srv.await.unwrap().unwrap();

    let run_ev = events
        .iter()
        .find(|e| e.request_id.as_deref() == Some("r-run"))
        .unwrap();
    assert!(matches!(
        &run_ev.payload,
        EventPayload::Completed {
            status: CompletedStatus::Cancelled,
            ..
        }
    ));

    let queue_ev = events
        .iter()
        .find(|e| e.request_id.as_deref() == Some("r-queue"))
        .unwrap();
    assert!(matches!(
        &queue_ev.payload,
        EventPayload::Completed {
            status: CompletedStatus::Timeout,
            ..
        }
    ));
}

#[tokio::test]
async fn t04_output_quota_truncates_cleanly_with_limit_exceeded() {
    let backend = MockBackend {
        records_to_emit: 50,
        record_size: 100,
        ..MockBackend::default()
    };

    let (mut client_in, server_in) = tokio::io::duplex(64 * 1024);
    let (server_out, client_out) = tokio::io::duplex(64 * 1024);

    let srv = tokio::spawn(async move {
        run_rpc_server(backend, server_in, server_out, RpcServerConfig::default()).await
    });

    client_in
        .write_all(b"{\"id\":\"r-open\",\"method\":\"session.open\",\"params\":{\"capabilities\":{\"limits\":{\"maxBatchRecords\":5,\"maxOutputBytesPerRequest\":800}}}}\n")
        .await
        .unwrap();
    client_in
        .write_all(b"{\"id\":\"r-call\",\"method\":\"call\",\"params\":{\"sessionId\":\"s1\",\"operation\":{\"kind\":\"list\"}}}\n")
        .await
        .unwrap();

    let mut lines = BufReader::new(client_out).lines();
    let mut events = Vec::new();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let ev: Event = serde_json::from_str(&line).unwrap();
        let done = ev.request_id.as_deref() == Some("r-call")
            && matches!(&ev.payload, EventPayload::Completed { .. });
        events.push(ev);
        if done {
            break;
        }
    }
    drop(client_in);
    srv.await.unwrap().unwrap();

    let call_completed = events
        .iter()
        .find(|e| {
            e.request_id.as_deref() == Some("r-call")
                && matches!(&e.payload, EventPayload::Completed { .. })
        })
        .unwrap();

    assert!(matches!(
        &call_completed.payload,
        EventPayload::Completed {
            status: CompletedStatus::LimitExceeded,
            truncated: true,
            error: Some(err),
            ..
        } if err.code == ErrorCode::EResourceLimit
    ));
}
