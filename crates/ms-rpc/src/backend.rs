use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use ms_protocol::{
    CallParams, Capabilities, ErrorInfo, HardLimits, Operation, SessionCloseResult,
    SessionOpenParams, SessionOpenResult,
};
use ms_runtime::{DiagnosticNotice, Runtime};
use serde_json::Value;
use tokio::sync::watch;

/// Cooperative cancellation token shared between the RPC dispatcher and runtime operations.
///
/// Supports both synchronous polling (`is_cancelled()`) inside blocking filesystem/search loops
/// and asynchronous waiting (`cancelled().await`) in `tokio::select!`.
#[derive(Debug, Clone)]
pub struct CancelToken {
    flag: Arc<AtomicBool>,
    tx: Arc<watch::Sender<bool>>,
    rx: watch::Receiver<bool>,
}

impl CancelToken {
    #[must_use]
    pub fn new() -> Self {
        let (tx, rx) = watch::channel(false);
        Self {
            flag: Arc::new(AtomicBool::new(false)),
            tx: Arc::new(tx),
            rx,
        }
    }

    /// Triggers cancellation for all clones of this token.
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::Release);
        let _ = self.tx.send(true);
    }

    /// Returns true if cancellation has been requested.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::Acquire)
    }

    /// Resolves when cancellation is requested.
    pub async fn cancelled(&mut self) {
        if self.is_cancelled() {
            return;
        }
        while !*self.rx.borrow_and_update() {
            if self.rx.changed().await.is_err() {
                break;
            }
        }
    }
}

impl Default for CancelToken {
    fn default() -> Self {
        Self::new()
    }
}

/// Effective narrowed policy for an active session tracked by the dispatcher.
#[derive(Debug, Clone)]
pub struct EffectiveSession {
    pub session_id: String,
    pub allow_write: bool,
    pub limits: HardLimits,
}

/// Per-request execution context passed to the runtime backend.
#[derive(Debug, Clone)]
pub struct ExecutionContext {
    pub session: EffectiveSession,
    pub operation_id: Option<String>,
    pub deadline: Instant,
    pub cancel: CancelToken,
}

/// Result produced by executing a single `Operation`.
#[derive(Debug, Clone, Default)]
pub struct OperationOutcome {
    /// Structured records to emit in `records` events (batched according to `max_batch_records`).
    pub records: Vec<Value>,
    /// Optional schema version tag for `records` events.
    pub schema_version: Option<String>,
    /// Non-fatal diagnostics emitted before `completed`.
    pub diagnostics: Vec<DiagnosticNotice>,
    /// Optional structured result payload for the terminal `completed` event.
    pub result: Option<Value>,
    /// True if the operation itself truncated results (e.g. `maxEntries` or `maxMatches`).
    pub truncated: bool,
}

pub type ExecuteFuture<'a> =
    Pin<Box<dyn Future<Output = Result<OperationOutcome, ErrorInfo>> + Send + 'a>>;

/// Backend interface implemented by `ms-runtime` (`RuntimeAdapter`) and test doubles.
pub trait RpcBackend: Send + Sync + 'static {
    /// Returns the actual host capabilities advertised by `initialize`.
    fn capabilities(&self) -> Capabilities;

    /// Opens a session, narrowing capabilities if requested.
    fn open_session(&self, params: &SessionOpenParams) -> Result<SessionOpenResult, ErrorInfo>;

    /// Closes an active session.
    fn close_session(&self, session_id: &str) -> Result<SessionCloseResult, ErrorInfo>;

    /// Executes a typed operation within the given `ExecutionContext`.
    fn execute(&self, ctx: ExecutionContext, operation: Operation) -> ExecuteFuture<'_>;
}

/// Adapter connecting `ms_runtime::Runtime` to `ms_rpc::RpcBackend`.
#[derive(Debug, Clone)]
pub struct RuntimeAdapter {
    runtime: Arc<Runtime>,
}

impl RuntimeAdapter {
    #[must_use]
    pub fn new(runtime: Arc<Runtime>) -> Self {
        Self { runtime }
    }
}

impl RpcBackend for RuntimeAdapter {
    fn capabilities(&self) -> Capabilities {
        self.runtime.capabilities()
    }

    fn open_session(&self, params: &SessionOpenParams) -> Result<SessionOpenResult, ErrorInfo> {
        self.runtime.open_session(params).map_err(ErrorInfo::from)
    }

    fn close_session(&self, session_id: &str) -> Result<SessionCloseResult, ErrorInfo> {
        self.runtime
            .close_session(session_id)
            .map_err(ErrorInfo::from)
    }

    fn execute(&self, ctx: ExecutionContext, operation: Operation) -> ExecuteFuture<'_> {
        Box::pin(async move {
            let remaining_ms = ctx
                .deadline
                .saturating_duration_since(Instant::now())
                .as_millis()
                .max(1) as u64;
            let call = CallParams {
                session_id: ctx.session.session_id,
                operation,
                operation_id: ctx.operation_id,
                deadline_ms: Some(remaining_ms),
            };

            let rt_cancel = ms_runtime::CancelToken::new();
            let rt_cancel_cl = rt_cancel.clone();
            let mut rpc_cancel = ctx.cancel.clone();
            let bridge = tokio::spawn(async move {
                rpc_cancel.cancelled().await;
                rt_cancel_cl.cancel();
            });

            let res = self.runtime.execute_call(&call, rt_cancel).await;
            bridge.abort();

            let out = res.map_err(ErrorInfo::from)?;
            Ok(OperationOutcome {
                records: out.records,
                schema_version: out.schema_version,
                diagnostics: out.diagnostics,
                result: out.result,
                truncated: out.truncated,
            })
        })
    }
}
