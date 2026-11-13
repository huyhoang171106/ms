use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ms_protocol::{
    CancelParams, CompletedStatus, CompletionCounters, ErrorCode, ErrorInfo, Event, EventPayload,
    InitializeResult, PROTOCOL_VERSION, Request, RequestBody, SERVER_NAME, SERVER_VERSION,
    SessionCloseParams, SessionOpenParams, validate_request,
};
use serde_json::json;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::{Semaphore, mpsc};
use tokio::task::JoinSet;

use crate::backend::{
    CancelToken, EffectiveSession, ExecutionContext, OperationOutcome, RpcBackend,
};
use crate::framing::{FrameRead, NdjsonReader, ParsedFrame, parse_frame};

const OUTPUT_CHANNEL_CAPACITY: usize = 64;

/// Configuration for the NDJSON RPC server.
#[derive(Debug, Clone)]
pub struct RpcServerConfig {
    pub max_frame_bytes: usize,
    pub max_concurrent_reads_per_connection: usize,
    pub max_concurrent_mutations_per_workspace: usize,
    pub output_channel_capacity: usize,
}

impl Default for RpcServerConfig {
    fn default() -> Self {
        Self {
            max_frame_bytes: ms_protocol::DEFAULT_MAX_FRAME_BYTES,
            max_concurrent_reads_per_connection:
                ms_protocol::DEFAULT_MAX_CONCURRENT_READS_PER_CONNECTION,
            max_concurrent_mutations_per_workspace:
                ms_protocol::DEFAULT_MAX_CONCURRENT_MUTATIONS_PER_WORKSPACE,
            output_channel_capacity: OUTPUT_CHANNEL_CAPACITY,
        }
    }
}

struct InFlightEntry {
    session_id: String,
    is_mutation: bool,
    cancel: CancelToken,
}

struct SharedState<B> {
    backend: B,
    sessions: Mutex<HashMap<String, EffectiveSession>>,
    in_flight: Mutex<HashMap<String, InFlightEntry>>,
    read_semaphore: Arc<Semaphore>,
    mutation_semaphore: Arc<Semaphore>,
}

impl<B: RpcBackend> SharedState<B> {
    fn new(backend: B, config: &RpcServerConfig) -> Self {
        Self {
            backend,
            sessions: Mutex::new(HashMap::new()),
            in_flight: Mutex::new(HashMap::new()),
            read_semaphore: Arc::new(Semaphore::new(
                config.max_concurrent_reads_per_connection.max(1),
            )),
            mutation_semaphore: Arc::new(Semaphore::new(
                config.max_concurrent_mutations_per_workspace.max(1),
            )),
        }
    }
}

/// Runs the NDJSON Protocol v1 server over `reader` (`stdin`) and `writer` (`stdout`).
///
/// Operational diagnostics (never file contents) are emitted via `eprintln!` only on fatal errors.
pub async fn run_rpc_server<B, R, W>(
    backend: B,
    reader: R,
    writer: W,
    config: RpcServerConfig,
) -> std::io::Result<()>
where
    B: RpcBackend,
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (out_tx, mut out_rx) = mpsc::channel::<Event>(config.output_channel_capacity.max(1));

    let writer_handle = tokio::spawn(async move {
        let mut writer = writer;
        while let Some(event) = out_rx.recv().await {
            let mut line = match serde_json::to_vec(&event) {
                Ok(v) => v,
                Err(_) => continue,
            };
            line.push(b'\n');
            if writer.write_all(&line).await.is_err() {
                break;
            }
            if writer.flush().await.is_err() {
                break;
            }
        }
    });

    let state = Arc::new(SharedState::new(backend, &config));
    let mut ndjson = NdjsonReader::new(reader, config.max_frame_bytes);
    let mut seen_ids: HashSet<String> = HashSet::new();
    let mut tasks: JoinSet<()> = JoinSet::new();

    loop {
        // Reap finished background tasks to keep JoinSet bounded.
        while tasks.try_join_next().is_some() {}

        match ndjson.next_frame().await {
            Ok(FrameRead::Eof) => break,
            Ok(FrameRead::Oversized) => {
                let err_ev = Event::protocol_error(
                    ErrorCode::EProtocol,
                    format!("frame exceeds maxFrameBytes ({})", config.max_frame_bytes),
                    true,
                );
                let _ = tokio::time::timeout(Duration::from_secs(2), out_tx.send(err_ev)).await;
                break;
            }
            Ok(FrameRead::Line(bytes)) => match parse_frame(&bytes) {
                ParsedFrame::Empty => continue,
                ParsedFrame::ProtocolError(msg) => {
                    send_event_detached(
                        &out_tx,
                        &mut tasks,
                        Event::protocol_error(ErrorCode::EProtocol, msg, false),
                    );
                }
                ParsedFrame::InvalidRequestWithId { id, code, message } => {
                    if !seen_ids.insert(id.clone()) {
                        let ev = duplicate_id_event(id);
                        send_event_detached(&out_tx, &mut tasks, ev);
                    } else {
                        let ev = Event::completed_err(
                            id,
                            1,
                            CompletedStatus::Error,
                            false,
                            CompletionCounters::default(),
                            ErrorInfo::new(code, message),
                        );
                        send_event_detached(&out_tx, &mut tasks, ev);
                    }
                }
                ParsedFrame::Request(req) => {
                    if !seen_ids.insert(req.id.clone()) {
                        send_event_detached(&out_tx, &mut tasks, duplicate_id_event(req.id));
                        continue;
                    }
                    if let Err(proto_err) = validate_request(&req) {
                        let ev = Event::completed_err(
                            req.id,
                            1,
                            CompletedStatus::Error,
                            false,
                            CompletionCounters::default(),
                            ErrorInfo::from(proto_err),
                        );
                        send_event_detached(&out_tx, &mut tasks, ev);
                        continue;
                    }
                    dispatch_request(req, &state, &out_tx, &mut tasks);
                }
            },
            Err(io_err) => {
                eprintln!("ms-rpc: stdin read error: {}", io_err.kind());
                break;
            }
        }
    }

    // On EOF / disconnect: cancel all in-flight read operations, let mutations finish cleanly.
    {
        let in_flight = state.in_flight.lock().expect("in_flight mutex poisoned");
        for entry in in_flight.values() {
            if !entry.is_mutation {
                entry.cancel.cancel();
            }
        }
    }

    // Wait for all spawned request tasks to emit their terminal `completed` events.
    while tasks.join_next().await.is_some() {}

    // Close output channel and wait for writer task to flush.
    drop(out_tx);
    let _ = writer_handle.await;

    Ok(())
}

fn duplicate_id_event(id: String) -> Event {
    Event::completed_err(
        id,
        1,
        CompletedStatus::Error,
        false,
        CompletionCounters::default(),
        ErrorInfo::new(
            ErrorCode::EDuplicateRequestId,
            "duplicate request id in connection",
        ),
    )
}

fn send_event_detached(out_tx: &mpsc::Sender<Event>, tasks: &mut JoinSet<()>, event: Event) {
    if let Err(mpsc::error::TrySendError::Full(ev)) = out_tx.try_send(event) {
        let tx = out_tx.clone();
        tasks.spawn(async move {
            let _ = tx.send(ev).await;
        });
    }
}

fn dispatch_request<B: RpcBackend>(
    req: Request,
    state: &Arc<SharedState<B>>,
    out_tx: &mpsc::Sender<Event>,
    tasks: &mut JoinSet<()>,
) {
    let req_id = req.id;
    match req.body {
        RequestBody::Initialize(_) => {
            let caps = state.backend.capabilities();
            let result = InitializeResult {
                protocol_version: PROTOCOL_VERSION.to_string(),
                server_name: SERVER_NAME.to_string(),
                server_version: SERVER_VERSION.to_string(),
                capabilities: caps,
            };
            let ev = match serde_json::to_value(result) {
                Ok(val) => {
                    Event::completed_ok(req_id, 1, false, CompletionCounters::default(), Some(val))
                }
                Err(e) => Event::completed_err(
                    req_id,
                    1,
                    CompletedStatus::Error,
                    false,
                    CompletionCounters::default(),
                    ErrorInfo::new(ErrorCode::EInternal, format!("serialize error: {e}")),
                ),
            };
            send_event_detached(out_tx, tasks, ev);
        }
        RequestBody::SessionOpen(params) => {
            handle_session_open(req_id, params, state, out_tx, tasks);
        }
        RequestBody::SessionClose(params) => {
            handle_session_close(req_id, params, state, out_tx, tasks);
        }
        RequestBody::Cancel(params) => {
            handle_cancel(req_id, params, state, out_tx, tasks);
        }
        RequestBody::Call(params) => {
            let session_opt = {
                let sessions = state.sessions.lock().expect("sessions mutex poisoned");
                sessions.get(&params.session_id).cloned()
            };
            let Some(session) = session_opt else {
                let ev = Event::completed_err(
                    req_id,
                    1,
                    CompletedStatus::Error,
                    false,
                    CompletionCounters::default(),
                    ErrorInfo::new(
                        ErrorCode::ESessionNotFound,
                        format!("session '{}' not found", params.session_id),
                    ),
                );
                send_event_detached(out_tx, tasks, ev);
                return;
            };

            let is_mutation = params.operation.is_mutation();
            if is_mutation && !session.allow_write {
                let ev = Event::completed_err(
                    req_id,
                    1,
                    CompletedStatus::Error,
                    false,
                    CompletionCounters::default(),
                    ErrorInfo::new(
                        ErrorCode::EPolicyDenied,
                        "session does not allow write operations",
                    ),
                );
                send_event_detached(out_tx, tasks, ev);
                return;
            }

            let requested_deadline = params
                .deadline_ms
                .unwrap_or(session.limits.default_deadline_ms);
            let effective_deadline_ms = requested_deadline
                .max(1)
                .min(session.limits.max_deadline_ms.max(1));
            let deadline = Instant::now() + Duration::from_millis(effective_deadline_ms);
            let cancel = CancelToken::new();

            {
                let mut in_flight = state.in_flight.lock().expect("in_flight mutex poisoned");
                in_flight.insert(
                    req_id.clone(),
                    InFlightEntry {
                        session_id: session.session_id.clone(),
                        is_mutation,
                        cancel: cancel.clone(),
                    },
                );
            }

            let state_cl = Arc::clone(state);
            let tx = out_tx.clone();
            tasks.spawn(async move {
                execute_call_task(
                    req_id,
                    session,
                    params.operation,
                    params.operation_id,
                    deadline,
                    cancel,
                    state_cl,
                    tx,
                )
                .await;
            });
        }
    }
}

fn handle_session_open<B: RpcBackend>(
    req_id: String,
    params: SessionOpenParams,
    state: &Arc<SharedState<B>>,
    out_tx: &mpsc::Sender<Event>,
    tasks: &mut JoinSet<()>,
) {
    let ev = match state.backend.open_session(&params) {
        Ok(res) => {
            let effective = EffectiveSession {
                session_id: res.session_id.clone(),
                allow_write: res.allow_write,
                limits: res.effective_limits.clone(),
            };
            {
                let mut sessions = state.sessions.lock().expect("sessions mutex poisoned");
                sessions.insert(res.session_id.clone(), effective);
            }
            match serde_json::to_value(res) {
                Ok(val) => {
                    Event::completed_ok(req_id, 1, false, CompletionCounters::default(), Some(val))
                }
                Err(e) => Event::completed_err(
                    req_id,
                    1,
                    CompletedStatus::Error,
                    false,
                    CompletionCounters::default(),
                    ErrorInfo::new(ErrorCode::EInternal, format!("serialize error: {e}")),
                ),
            }
        }
        Err(err) => Event::completed_err(
            req_id,
            1,
            CompletedStatus::Error,
            false,
            CompletionCounters::default(),
            err,
        ),
    };
    send_event_detached(out_tx, tasks, ev);
}

fn handle_session_close<B: RpcBackend>(
    req_id: String,
    params: SessionCloseParams,
    state: &Arc<SharedState<B>>,
    out_tx: &mpsc::Sender<Event>,
    tasks: &mut JoinSet<()>,
) {
    let ev = match state.backend.close_session(&params.session_id) {
        Ok(res) => {
            {
                let mut sessions = state.sessions.lock().expect("sessions mutex poisoned");
                sessions.remove(&params.session_id);
            }
            {
                let in_flight = state.in_flight.lock().expect("in_flight mutex poisoned");
                for entry in in_flight.values() {
                    if entry.session_id == params.session_id && !entry.is_mutation {
                        entry.cancel.cancel();
                    }
                }
            }
            Event::completed_ok(
                req_id,
                1,
                false,
                CompletionCounters::default(),
                serde_json::to_value(res).ok(),
            )
        }
        Err(err) => Event::completed_err(
            req_id,
            1,
            CompletedStatus::Error,
            false,
            CompletionCounters::default(),
            err,
        ),
    };
    send_event_detached(out_tx, tasks, ev);
}

fn handle_cancel<B: RpcBackend>(
    req_id: String,
    params: CancelParams,
    state: &Arc<SharedState<B>>,
    out_tx: &mpsc::Sender<Event>,
    tasks: &mut JoinSet<()>,
) {
    let cancelled = {
        let in_flight = state.in_flight.lock().expect("in_flight mutex poisoned");
        if let Some(entry) = in_flight.get(&params.request_id) {
            entry.cancel.cancel();
            true
        } else {
            false
        }
    };

    let ev = Event::completed_ok(
        req_id,
        1,
        false,
        CompletionCounters::default(),
        Some(json!({
            "requestId": params.request_id,
            "cancelled": cancelled,
        })),
    );
    send_event_detached(out_tx, tasks, ev);
}

#[allow(clippy::too_many_arguments)]
async fn execute_call_task<B: RpcBackend>(
    req_id: String,
    session: EffectiveSession,
    operation: ms_protocol::Operation,
    operation_id: Option<String>,
    deadline: Instant,
    mut cancel: CancelToken,
    state: Arc<SharedState<B>>,
    out_tx: mpsc::Sender<Event>,
) {
    let start = Instant::now();
    let is_mutation = operation.is_mutation();
    let max_batch_records = session.limits.max_batch_records.max(1);
    let max_output_bytes = session.limits.max_output_bytes_per_request.max(1);

    let sem = if is_mutation {
        Arc::clone(&state.mutation_semaphore)
    } else {
        Arc::clone(&state.read_semaphore)
    };

    // Wait for concurrency permit while respecting both cancellation and queue+exec deadline.
    let _permit = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            finish_in_flight(&state, &req_id);
            let counters = CompletionCounters {
                records_emitted: 0,
                bytes_emitted: 0,
                duration_ms: start.elapsed().as_millis() as u64,
            };
            let _ = out_tx.send(Event::completed_err(
                req_id,
                1,
                CompletedStatus::Cancelled,
                false,
                counters,
                ErrorInfo::new(ErrorCode::ECancelled, "request cancelled while queued"),
            )).await;
            return;
        }
        _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {
            finish_in_flight(&state, &req_id);
            let counters = CompletionCounters {
                records_emitted: 0,
                bytes_emitted: 0,
                duration_ms: start.elapsed().as_millis() as u64,
            };
            let _ = out_tx.send(Event::completed_err(
                req_id,
                1,
                CompletedStatus::Timeout,
                false,
                counters,
                ErrorInfo::new(ErrorCode::ETimeout, "request deadline exceeded while queued"),
            )).await;
            return;
        }
        permit_res = sem.acquire() => {
            match permit_res {
                Ok(p) => p,
                Err(_) => {
                    finish_in_flight(&state, &req_id);
                    let _ = out_tx.send(Event::completed_err(
                        req_id,
                        1,
                        CompletedStatus::Error,
                        false,
                        CompletionCounters::default(),
                        ErrorInfo::new(ErrorCode::EInternal, "semaphore closed"),
                    )).await;
                    return;
                }
            }
        }
    };

    // Check deadline/cancel once more right after acquiring permit.
    if cancel.is_cancelled() {
        finish_in_flight(&state, &req_id);
        let _ = out_tx
            .send(Event::completed_err(
                req_id,
                1,
                CompletedStatus::Cancelled,
                false,
                CompletionCounters {
                    records_emitted: 0,
                    bytes_emitted: 0,
                    duration_ms: start.elapsed().as_millis() as u64,
                },
                ErrorInfo::new(ErrorCode::ECancelled, "request cancelled"),
            ))
            .await;
        return;
    }
    if Instant::now() >= deadline {
        finish_in_flight(&state, &req_id);
        let _ = out_tx
            .send(Event::completed_err(
                req_id,
                1,
                CompletedStatus::Timeout,
                false,
                CompletionCounters {
                    records_emitted: 0,
                    bytes_emitted: 0,
                    duration_ms: start.elapsed().as_millis() as u64,
                },
                ErrorInfo::new(ErrorCode::ETimeout, "request deadline exceeded"),
            ))
            .await;
        return;
    }

    let ctx = ExecutionContext {
        session,
        operation_id,
        deadline,
        cancel: cancel.clone(),
    };

    let mut exec_fut = state.backend.execute(ctx, operation);

    let exec_result: Result<OperationOutcome, (CompletedStatus, ErrorInfo)> = if is_mutation {
        // Mutations past commit boundary must finish journal/recovery cleanly.
        match exec_fut.await {
            Ok(outcome) => Ok(outcome),
            Err(err) => Err((status_for_error(err.code), err)),
        }
    } else {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                Err((
                    CompletedStatus::Cancelled,
                    ErrorInfo::new(ErrorCode::ECancelled, "request cancelled"),
                ))
            }
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {
                cancel.cancel();
                Err((
                    CompletedStatus::Timeout,
                    ErrorInfo::new(ErrorCode::ETimeout, "request deadline exceeded"),
                ))
            }
            res = &mut exec_fut => {
                match res {
                    Ok(outcome) => Ok(outcome),
                    Err(err) => Err((status_for_error(err.code), err)),
                }
            }
        }
    };

    finish_in_flight(&state, &req_id);

    match exec_result {
        Ok(outcome) => {
            emit_outcome(
                req_id,
                outcome,
                max_batch_records,
                max_output_bytes,
                start,
                &out_tx,
            )
            .await;
        }
        Err((status, err_info)) => {
            let counters = CompletionCounters {
                records_emitted: 0,
                bytes_emitted: 0,
                duration_ms: start.elapsed().as_millis() as u64,
            };
            let _ = out_tx
                .send(Event::completed_err(
                    req_id, 1, status, false, counters, err_info,
                ))
                .await;
        }
    }
}

fn finish_in_flight<B>(state: &Arc<SharedState<B>>, req_id: &str) {
    let mut in_flight = state.in_flight.lock().expect("in_flight mutex poisoned");
    in_flight.remove(req_id);
}

const fn status_for_error(code: ErrorCode) -> CompletedStatus {
    match code {
        ErrorCode::ECancelled => CompletedStatus::Cancelled,
        ErrorCode::ETimeout => CompletedStatus::Timeout,
        ErrorCode::EResourceLimit => CompletedStatus::LimitExceeded,
        _ => CompletedStatus::Error,
    }
}

async fn emit_outcome(
    req_id: String,
    outcome: OperationOutcome,
    max_batch_records: usize,
    max_output_bytes: usize,
    start: Instant,
    out_tx: &mpsc::Sender<Event>,
) {
    let mut seq: u64 = 1;
    let mut records_emitted: u64 = 0;
    let mut bytes_emitted: u64 = 0;
    let mut quota_exceeded = false;

    for diag in outcome.diagnostics {
        let ev = Event {
            request_id: Some(req_id.clone()),
            seq,
            payload: EventPayload::Diagnostic {
                severity: diag.severity,
                code: diag.code,
                message: diag.message,
                path: diag.path,
                span: None,
                hint: None,
            },
        };
        let ev_bytes = serde_json::to_vec(&ev).map(|v| v.len() + 1).unwrap_or(0);
        if bytes_emitted as usize + ev_bytes > max_output_bytes {
            quota_exceeded = true;
            break;
        }
        bytes_emitted += ev_bytes as u64;
        seq += 1;
        if out_tx.send(ev).await.is_err() {
            return;
        }
    }

    let mut idx = 0;
    let total = outcome.records.len();
    while !quota_exceeded && idx < total {
        let end = (idx + max_batch_records).min(total);
        let mut batch = outcome.records[idx..end].to_vec();
        let mut ev = Event::records(
            req_id.clone(),
            seq,
            batch.clone(),
            outcome.schema_version.clone(),
        );
        let mut ev_bytes = serde_json::to_vec(&ev).map(|v| v.len() + 1).unwrap_or(0);

        if bytes_emitted as usize + ev_bytes > max_output_bytes {
            // Try shrinking batch to fit remaining quota.
            while !batch.is_empty() {
                batch.pop();
                if batch.is_empty() {
                    break;
                }
                ev = Event::records(
                    req_id.clone(),
                    seq,
                    batch.clone(),
                    outcome.schema_version.clone(),
                );
                ev_bytes = serde_json::to_vec(&ev).map(|v| v.len() + 1).unwrap_or(0);
                if bytes_emitted as usize + ev_bytes <= max_output_bytes {
                    break;
                }
            }
            if batch.is_empty() {
                quota_exceeded = true;
                break;
            }
            records_emitted += batch.len() as u64;
            bytes_emitted += ev_bytes as u64;
            seq += 1;
            if out_tx.send(ev).await.is_err() {
                return;
            }
            quota_exceeded = true;
            break;
        }

        records_emitted += batch.len() as u64;
        bytes_emitted += ev_bytes as u64;
        seq += 1;
        idx = end;
        if out_tx.send(ev).await.is_err() {
            return;
        }
    }

    let duration_ms = start.elapsed().as_millis() as u64;
    let counters = CompletionCounters {
        records_emitted,
        bytes_emitted,
        duration_ms,
    };

    if quota_exceeded {
        let _ = out_tx
            .send(Event::completed_err(
                req_id,
                seq,
                CompletedStatus::LimitExceeded,
                true,
                counters,
                ErrorInfo::new(ErrorCode::EResourceLimit, "output byte quota exceeded"),
            ))
            .await;
        return;
    }

    // Check if completed result itself fits in remaining output quota.
    let completed_ev = Event::completed_ok(
        req_id.clone(),
        seq,
        outcome.truncated,
        counters,
        outcome.result,
    );
    let completed_bytes = serde_json::to_vec(&completed_ev)
        .map(|v| v.len() + 1)
        .unwrap_or(0);
    if bytes_emitted as usize + completed_bytes > max_output_bytes {
        let _ = out_tx
            .send(Event::completed_err(
                req_id,
                seq,
                CompletedStatus::LimitExceeded,
                true,
                counters,
                ErrorInfo::new(ErrorCode::EResourceLimit, "output byte quota exceeded"),
            ))
            .await;
    } else {
        let _ = out_tx.send(completed_ev).await;
    }
}
