use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Canonical error codes returned in `EventPayload::Completed`,
/// `EventPayload::Diagnostic`, and `EventPayload::ProtocolError`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    /// Malformed NDJSON frame, invalid JSON, or oversized frame.
    EProtocol,
    /// Request `id` was already used in this connection.
    EDuplicateRequestId,
    /// Invalid request parameters, bad byte offsets, overlapping edits, mixed EOL, or invalid UTF-8.
    EInvalidRequest,
    /// Unknown method or operation name.
    EUnknownCommand,
    /// Operation or feature is not supported in this build/configuration.
    EUnsupported,
    /// Referenced `sessionId` does not exist or is already closed.
    ESessionNotFound,
    /// Access denied by host capability policy, path traversal, symlink, or secret path rule.
    EPolicyDenied,
    /// Target file or directory does not exist.
    ENotFound,
    /// Precondition failed: stale `expectedRevision`, stale text/tag anchor, or external modification.
    EConflict,
    /// Undo precondition failed: current file digest != postimage, or transaction is not latest un-undone.
    EUndoConflict,
    /// Retry with same `operationId` had a different payload hash.
    EIdempotencyConflict,
    /// `operationId` is outside the active retention epoch and cannot be replayed.
    EIdempotencyExpired,
    /// Another runtime instance holds the cooperative single-writer workspace lease.
    EWorkspaceLocked,
    /// Workspace has an unresolved crash-recovery conflict in the journal.
    ERecoveryConflict,
    /// Request exceeded output, file size, state/ledger, or sort memory quota.
    EResourceLimit,
    /// Request was cancelled by `cancel` or connection close.
    ECancelled,
    /// Request exceeded its queue + execution deadline.
    ETimeout,
    /// Underlying OS I/O failure.
    EIo,
    /// Unexpected internal error.
    EInternal,
}

impl ErrorCode {
    /// Returns true if retrying the operation (possibly after re-reading) may succeed.
    #[must_use]
    pub const fn is_retryable(self) -> bool {
        matches!(
            self,
            Self::EConflict
                | Self::EWorkspaceLocked
                | Self::ETimeout
                | Self::ECancelled
                | Self::EIo
        )
    }
}

/// Structured error payload attached to terminal `completed` events.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorInfo {
    pub code: ErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    pub retryable: bool,
}

impl ErrorInfo {
    #[must_use]
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            hint: None,
            retryable: code.is_retryable(),
        }
    }

    #[must_use]
    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
}

/// Diagnostic severity level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticSeverity {
    Info,
    Warning,
    Error,
}

/// Optional source/byte span for diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub start_byte: u64,
    pub end_byte: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u64>,
}

/// Pure validation errors within `ms-protocol`.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    #[error("invalid path: {0}")]
    InvalidPath(String),
    #[error("invalid revision hex: {0}")]
    InvalidRevision(String),
    #[error("invalid patch edit: {0}")]
    InvalidEdit(String),
    #[error("invalid request: {0}")]
    InvalidRequest(String),
}

impl From<ProtocolError> for ErrorInfo {
    fn from(err: ProtocolError) -> Self {
        match &err {
            ProtocolError::InvalidPath(_) => {
                ErrorInfo::new(ErrorCode::EPolicyDenied, err.to_string()).with_hint(
                    "Use a relative UTF-8 path inside the workspace root without '..' or symlinks.",
                )
            }
            ProtocolError::InvalidRevision(_)
            | ProtocolError::InvalidEdit(_)
            | ProtocolError::InvalidRequest(_) => {
                ErrorInfo::new(ErrorCode::EInvalidRequest, err.to_string())
            }
        }
    }
}
