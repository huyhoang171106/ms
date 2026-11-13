use ms_protocol::{ErrorCode, ErrorInfo, ProtocolError};
use thiserror::Error;

/// Errors produced by `ms-runtime`, mapped cleanly to Protocol v1 `ErrorInfo`.
#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error(transparent)]
    Protocol(#[from] ProtocolError),

    #[error("policy denied: {message}")]
    PolicyDenied {
        message: String,
        hint: Option<String>,
    },

    #[error("not found: {0}")]
    NotFound(String),

    #[error("invalid request: {0}")]
    InvalidRequest(String),

    #[error("unknown command: {0}")]
    UnknownCommand(String),

    #[error("unsupported: {0}")]
    Unsupported(String),

    #[error("session not found: {0}")]
    SessionNotFound(String),

    #[error("conflict: {message}")]
    Conflict {
        message: String,
        hint: Option<String>,
    },

    #[error("undo conflict: {0}")]
    UndoConflict(String),

    #[error("idempotency conflict: {0}")]
    IdempotencyConflict(String),

    #[error("idempotency expired: {0}")]
    IdempotencyExpired(String),

    #[error("workspace locked: {0}")]
    WorkspaceLocked(String),

    #[error("recovery conflict: {0}")]
    RecoveryConflict(String),

    #[error("resource limit exceeded: {0}")]
    ResourceLimit(String),

    #[error("operation cancelled")]
    Cancelled,

    #[error("operation timed out")]
    Timeout,

    #[error("I/O error: {0}")]
    Io(String),

    #[error("internal error: {0}")]
    Internal(String),
}

impl RuntimeError {
    #[must_use]
    pub fn policy_denied(message: impl Into<String>) -> Self {
        Self::PolicyDenied {
            message: message.into(),
            hint: None,
        }
    }

    #[must_use]
    pub fn policy_denied_with_hint(message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self::PolicyDenied {
            message: message.into(),
            hint: Some(hint.into()),
        }
    }

    #[must_use]
    pub fn conflict(message: impl Into<String>, hint: impl Into<String>) -> Self {
        Self::Conflict {
            message: message.into(),
            hint: Some(hint.into()),
        }
    }

    #[must_use]
    pub const fn error_code(&self) -> ErrorCode {
        match self {
            Self::Protocol(p) => match p {
                ProtocolError::InvalidPath(_) => ErrorCode::EPolicyDenied,
                ProtocolError::InvalidRevision(_)
                | ProtocolError::InvalidEdit(_)
                | ProtocolError::InvalidRequest(_) => ErrorCode::EInvalidRequest,
            },
            Self::PolicyDenied { .. } => ErrorCode::EPolicyDenied,
            Self::NotFound(_) => ErrorCode::ENotFound,
            Self::InvalidRequest(_) => ErrorCode::EInvalidRequest,
            Self::UnknownCommand(_) => ErrorCode::EUnknownCommand,
            Self::Unsupported(_) => ErrorCode::EUnsupported,
            Self::SessionNotFound(_) => ErrorCode::ESessionNotFound,
            Self::Conflict { .. } => ErrorCode::EConflict,
            Self::UndoConflict(_) => ErrorCode::EUndoConflict,
            Self::IdempotencyConflict(_) => ErrorCode::EIdempotencyConflict,
            Self::IdempotencyExpired(_) => ErrorCode::EIdempotencyExpired,
            Self::WorkspaceLocked(_) => ErrorCode::EWorkspaceLocked,
            Self::RecoveryConflict(_) => ErrorCode::ERecoveryConflict,
            Self::ResourceLimit(_) => ErrorCode::EResourceLimit,
            Self::Cancelled => ErrorCode::ECancelled,
            Self::Timeout => ErrorCode::ETimeout,
            Self::Io(_) => ErrorCode::EIo,
            Self::Internal(_) => ErrorCode::EInternal,
        }
    }

    #[must_use]
    pub fn to_error_info(&self) -> ErrorInfo {
        match self {
            Self::Protocol(p) => ErrorInfo::from(p.clone()),
            Self::PolicyDenied { message, hint } => {
                let mut info = ErrorInfo::new(ErrorCode::EPolicyDenied, message);
                if let Some(h) = hint {
                    info = info.with_hint(h);
                }
                info
            }
            Self::Conflict { message, hint } => {
                let mut info = ErrorInfo::new(ErrorCode::EConflict, message);
                if let Some(h) = hint {
                    info = info.with_hint(h);
                }
                info
            }
            _ => ErrorInfo::new(self.error_code(), self.to_string()),
        }
    }
}

impl From<RuntimeError> for ErrorInfo {
    fn from(err: RuntimeError) -> Self {
        err.to_error_info()
    }
}
