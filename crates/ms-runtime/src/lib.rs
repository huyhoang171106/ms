//! Capability-confined Linux workspace runtime, operations, and durable crash-recovery journal.

pub mod error;
pub mod journal;
pub mod lock;
pub mod ops;
pub mod policy;
pub mod text;
pub mod workspace_fs;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use ms_protocol::{
    CallParams, Capabilities, CompletionCounters, HardLimits, Operation, PROTOCOL_VERSION,
    SessionCloseResult, SessionOpenParams, SessionOpenResult, validate_operation,
};
use tokio::sync::Notify;

pub use error::RuntimeError;
pub use ops::DiagnosticNotice;
pub use policy::{DEFAULT_MAX_STATE_BYTES, EffectivePolicy, HostConfig, default_secret_patterns};

use journal::WorkspaceJournal;
use lock::WorkspaceLease;
use ops::{
    compute_state_rel_prefix, exec_list, exec_patch, exec_read, exec_schema, exec_search,
    exec_tx_list, exec_tx_undo,
};
use text::blake3_hex;
use workspace_fs::WorkspaceFs;

/// Lightweight cooperative cancellation token for in-flight runtime calls.
#[derive(Debug, Clone)]
pub struct CancelToken {
    flag: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl Default for CancelToken {
    fn default() -> Self {
        Self::new()
    }
}

impl CancelToken {
    #[must_use]
    pub fn new() -> Self {
        Self {
            flag: Arc::new(AtomicBool::new(false)),
            notify: Arc::new(Notify::new()),
        }
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::Acquire)
    }

    pub async fn cancelled(&self) {
        loop {
            let notified = self.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
            if self.is_cancelled() {
                return;
            }
        }
    }
}

/// Structured output returned by `Runtime::execute_call`.
#[derive(Debug, Clone)]
pub struct ExecutionOutput {
    pub records: Vec<serde_json::Value>,
    pub schema_version: Option<String>,
    pub result: Option<serde_json::Value>,
    pub diagnostics: Vec<DiagnosticNotice>,
    pub truncated: bool,
    pub counters: CompletionCounters,
}

#[derive(Debug, Clone)]
struct SessionState {
    policy: EffectivePolicy,
}

/// Workspace-scoped runtime enforcing Linux `openat2` confinement, host policy,
/// single-writer lease, and durable crash-recovery journaling.
#[derive(Debug)]
pub struct Runtime {
    fs: Arc<WorkspaceFs>,
    host_policy: EffectivePolicy,
    limits: HardLimits,
    _lease: Option<WorkspaceLease>,
    journal: Arc<std::sync::Mutex<WorkspaceJournal>>,
    mutation_queue: Arc<tokio::sync::Mutex<()>>,
    sessions: Arc<std::sync::Mutex<HashMap<String, SessionState>>>,
    next_session_id: AtomicU64,
}

impl Runtime {
    /// Initializes the runtime for `config.workspace_root`, probes `openat2`,
    /// acquires the cooperative write lease (if `allow_write` is true), and runs
    /// startup crash recovery on the durable journal.
    pub fn new(config: HostConfig) -> Result<Self, RuntimeError> {
        let fs = Arc::new(WorkspaceFs::open_root(&config.workspace_root)?);
        let (dev, ino) = fs.root_identity();

        let lease = if config.allow_write {
            Some(WorkspaceLease::acquire(&config.state_dir, dev, ino)?)
        } else {
            WorkspaceLease::ensure_private_dir(&config.state_dir)?;
            None
        };

        let state_rel_prefix = compute_state_rel_prefix(&config.workspace_root, &config.state_dir);
        let host_policy = EffectivePolicy::from_host(&config, state_rel_prefix)?;

        let journal = WorkspaceJournal::open_and_recover(
            &config.state_dir,
            &fs,
            config.max_state_bytes,
            config.limits.max_edit_file_bytes,
        )?;

        Ok(Self {
            fs,
            host_policy,
            limits: config.limits,
            _lease: lease,
            journal: Arc::new(std::sync::Mutex::new(journal)),
            mutation_queue: Arc::new(tokio::sync::Mutex::new(())),
            sessions: Arc::new(std::sync::Mutex::new(HashMap::new())),
            next_session_id: AtomicU64::new(1),
        })
    }

    /// Returns the root `(st_dev, st_ino)` identity of the workspace.
    #[must_use]
    pub fn root_identity(&self) -> (u64, u64) {
        self.fs.root_identity()
    }

    /// Returns the actual host capabilities advertised in `initialize`.
    #[must_use]
    pub fn capabilities(&self) -> Capabilities {
        let mut ops = vec![
            "list".to_string(),
            "search".to_string(),
            "read".to_string(),
            "tx.list".to_string(),
            "schema".to_string(),
        ];
        if self.host_policy.allow_write {
            ops.push("patch".to_string());
            ops.push("tx.undo".to_string());
        }
        Capabilities {
            operations: ops,
            allow_write: self.host_policy.allow_write,
            allow_external_exec: false,
            supports_cancellation: true,
            supports_idempotency: true,
            max_limits: self.limits.clone(),
        }
    }

    /// Opens a new session, narrowing host capabilities if requested.
    pub fn open_session(
        &self,
        params: &SessionOpenParams,
    ) -> Result<SessionOpenResult, RuntimeError> {
        let effective = self.host_policy.narrow(params.capabilities.as_ref())?;
        let seq = self.next_session_id.fetch_add(1, Ordering::Relaxed);
        let session_id = format!("s-{seq}");
        let allow_write = effective.allow_write;
        let effective_limits = effective.limits.clone();

        let mut guard = self
            .sessions
            .lock()
            .map_err(|_| RuntimeError::Internal("session lock poisoned".to_string()))?;
        guard.insert(session_id.clone(), SessionState { policy: effective });

        Ok(SessionOpenResult {
            session_id,
            allow_write,
            effective_limits,
        })
    }

    /// Closes an active session.
    pub fn close_session(&self, session_id: &str) -> Result<SessionCloseResult, RuntimeError> {
        let mut guard = self
            .sessions
            .lock()
            .map_err(|_| RuntimeError::Internal("session lock poisoned".to_string()))?;
        if guard.remove(session_id).is_none() {
            return Err(RuntimeError::SessionNotFound(format!(
                "session '{session_id}' not found"
            )));
        }
        Ok(SessionCloseResult {
            session_id: session_id.to_string(),
            closed: true,
        })
    }

    /// Advances the idempotency retention epoch in the workspace journal.
    pub fn advance_epoch(&self) -> Result<u64, RuntimeError> {
        let mut j = self
            .journal
            .lock()
            .map_err(|_| RuntimeError::Internal("journal lock poisoned".to_string()))?;
        j.advance_epoch()
    }

    /// Executes a `call` operation within the session's narrowed policy, deadline, and cancel token.
    pub async fn execute_call(
        &self,
        call: &CallParams,
        cancel: CancelToken,
    ) -> Result<ExecutionOutput, RuntimeError> {
        let started = Instant::now();
        validate_operation(&call.operation)?;

        let session_policy = {
            let guard = self
                .sessions
                .lock()
                .map_err(|_| RuntimeError::Internal("session lock poisoned".to_string()))?;
            guard
                .get(&call.session_id)
                .map(|s| s.policy.clone())
                .ok_or_else(|| {
                    RuntimeError::SessionNotFound(format!(
                        "session '{}' not found",
                        call.session_id
                    ))
                })?
        };

        let deadline_ms = call
            .deadline_ms
            .map_or(session_policy.limits.default_deadline_ms, |d| {
                d.min(session_policy.limits.max_deadline_ms)
            })
            .max(1);

        let fut = self.execute_with_policy(call, session_policy, cancel.clone(), started);

        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(RuntimeError::Cancelled),
            res = tokio::time::timeout(Duration::from_millis(deadline_ms), fut) => {
                match res {
                    Ok(inner) => inner,
                    Err(_) => {
                        cancel.cancel();
                        Err(RuntimeError::Timeout)
                    }
                }
            }
        }
    }

    async fn execute_with_policy(
        &self,
        call: &CallParams,
        policy: EffectivePolicy,
        cancel: CancelToken,
        started: Instant,
    ) -> Result<ExecutionOutput, RuntimeError> {
        let fs = Arc::clone(&self.fs);
        let journal = Arc::clone(&self.journal);
        let op = call.operation.clone();
        let operation_id = call.operation_id.clone();

        if op.is_mutation() {
            if !policy.allow_write {
                return Err(RuntimeError::policy_denied_with_hint(
                    "write operation denied: session/host is read-only",
                    "Open a write-enabled session if the host allows writes.",
                ));
            }
            let _mutation_guard = self.mutation_queue.lock().await;
            if cancel.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }

            let payload_bytes = serde_json::to_vec(&op)
                .map_err(|e| RuntimeError::Internal(format!("serialize operation: {e}")))?;
            let payload_hash = blake3_hex(&payload_bytes);

            tokio::task::spawn_blocking(move || {
                let mut j = journal
                    .lock()
                    .map_err(|_| RuntimeError::Internal("journal lock poisoned".to_string()))?;
                match &op {
                    Operation::Patch(p) => {
                        let res = exec_patch(
                            &fs,
                            &policy,
                            &mut j,
                            p,
                            operation_id.as_deref(),
                            &payload_hash,
                        )?;
                        let val = serde_json::to_value(&res)
                            .map_err(|e| RuntimeError::Internal(e.to_string()))?;
                        let bytes = serde_json::to_vec(&val)
                            .map(|v| v.len() as u64)
                            .unwrap_or(0);
                        Ok(ExecutionOutput {
                            records: Vec::new(),
                            schema_version: Some(PROTOCOL_VERSION.to_string()),
                            result: Some(val),
                            diagnostics: Vec::new(),
                            truncated: false,
                            counters: CompletionCounters {
                                records_emitted: 0,
                                bytes_emitted: bytes,
                                duration_ms: started.elapsed().as_millis() as u64,
                            },
                        })
                    }
                    Operation::TxUndo(p) => {
                        let res = exec_tx_undo(
                            &fs,
                            &policy,
                            &mut j,
                            p,
                            operation_id.as_deref(),
                            &payload_hash,
                        )?;
                        let val = serde_json::to_value(&res)
                            .map_err(|e| RuntimeError::Internal(e.to_string()))?;
                        let bytes = serde_json::to_vec(&val)
                            .map(|v| v.len() as u64)
                            .unwrap_or(0);
                        Ok(ExecutionOutput {
                            records: Vec::new(),
                            schema_version: Some(PROTOCOL_VERSION.to_string()),
                            result: Some(val),
                            diagnostics: Vec::new(),
                            truncated: false,
                            counters: CompletionCounters {
                                records_emitted: 0,
                                bytes_emitted: bytes,
                                duration_ms: started.elapsed().as_millis() as u64,
                            },
                        })
                    }
                    _ => unreachable!(),
                }
            })
            .await
            .map_err(|e| RuntimeError::Internal(format!("worker task join error: {e}")))?
        } else {
            tokio::task::spawn_blocking(move || match &op {
                Operation::List(p) => {
                    let out = exec_list(&fs, &policy, p, &cancel)?;
                    let records = to_json_values(&out.entries)?;
                    let bytes = estimate_records_bytes(&records);
                    Ok(ExecutionOutput {
                        counters: CompletionCounters {
                            records_emitted: records.len() as u64,
                            bytes_emitted: bytes,
                            duration_ms: started.elapsed().as_millis() as u64,
                        },
                        records,
                        schema_version: Some(PROTOCOL_VERSION.to_string()),
                        result: None,
                        diagnostics: out.diagnostics,
                        truncated: out.truncated,
                    })
                }
                Operation::Search(p) => {
                    let out = exec_search(&fs, &policy, p, &cancel)?;
                    let records = to_json_values(&out.matches)?;
                    let bytes = estimate_records_bytes(&records);
                    Ok(ExecutionOutput {
                        counters: CompletionCounters {
                            records_emitted: records.len() as u64,
                            bytes_emitted: bytes,
                            duration_ms: started.elapsed().as_millis() as u64,
                        },
                        records,
                        schema_version: Some(PROTOCOL_VERSION.to_string()),
                        result: None,
                        diagnostics: out.diagnostics,
                        truncated: out.truncated,
                    })
                }
                Operation::Read(p) => {
                    let out = exec_read(&fs, &policy, p)?;
                    let records = to_json_values(&out.lines)?;
                    let result = serde_json::to_value(&out.result)
                        .map_err(|e| RuntimeError::Internal(e.to_string()))?;
                    let bytes = estimate_records_bytes(&records)
                        + serde_json::to_vec(&result)
                            .map(|v| v.len() as u64)
                            .unwrap_or(0);
                    Ok(ExecutionOutput {
                        counters: CompletionCounters {
                            records_emitted: records.len() as u64,
                            bytes_emitted: bytes,
                            duration_ms: started.elapsed().as_millis() as u64,
                        },
                        records,
                        schema_version: Some(PROTOCOL_VERSION.to_string()),
                        result: Some(result),
                        diagnostics: Vec::new(),
                        truncated: out.truncated,
                    })
                }
                Operation::TxList(p) => {
                    let j = journal
                        .lock()
                        .map_err(|_| RuntimeError::Internal("journal lock poisoned".to_string()))?;
                    let list = exec_tx_list(&j, p);
                    let records = to_json_values(&list)?;
                    let bytes = estimate_records_bytes(&records);
                    Ok(ExecutionOutput {
                        counters: CompletionCounters {
                            records_emitted: records.len() as u64,
                            bytes_emitted: bytes,
                            duration_ms: started.elapsed().as_millis() as u64,
                        },
                        records,
                        schema_version: Some(PROTOCOL_VERSION.to_string()),
                        result: None,
                        diagnostics: Vec::new(),
                        truncated: false,
                    })
                }
                Operation::Schema(p) => {
                    let schemas = exec_schema(p)?;
                    let records = to_json_values(&schemas)?;
                    let bytes = estimate_records_bytes(&records);
                    Ok(ExecutionOutput {
                        counters: CompletionCounters {
                            records_emitted: records.len() as u64,
                            bytes_emitted: bytes,
                            duration_ms: started.elapsed().as_millis() as u64,
                        },
                        records,
                        schema_version: Some(PROTOCOL_VERSION.to_string()),
                        result: None,
                        diagnostics: Vec::new(),
                        truncated: false,
                    })
                }
                _ => unreachable!(),
            })
            .await
            .map_err(|e| RuntimeError::Internal(format!("worker task join error: {e}")))?
        }
    }
}

fn to_json_values<T: serde::Serialize>(
    items: &[T],
) -> Result<Vec<serde_json::Value>, RuntimeError> {
    items
        .iter()
        .map(|item| serde_json::to_value(item).map_err(|e| RuntimeError::Internal(e.to_string())))
        .collect()
}

fn estimate_records_bytes(records: &[serde_json::Value]) -> u64 {
    records
        .iter()
        .map(|r| serde_json::to_vec(r).map(|v| v.len() as u64).unwrap_or(0))
        .sum()
}
