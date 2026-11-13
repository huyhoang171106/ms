use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::error::{DiagnosticSeverity, ErrorCode, ErrorInfo, Span};
use crate::limits::{Capabilities, HardLimits, SessionCapabilities};
use crate::operations::Operation;

/// Top-level NDJSON request envelope (client -> server).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    /// Connection-unique non-empty request identifier.
    pub id: String,
    /// Method and typed parameters.
    pub body: RequestBody,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestBody {
    Initialize(InitializeParams),
    SessionOpen(SessionOpenParams),
    SessionClose(SessionCloseParams),
    Call(CallParams),
    Cancel(CancelParams),
}

impl RequestBody {
    #[must_use]
    pub const fn method_name(&self) -> &'static str {
        match self {
            Self::Initialize(_) => "initialize",
            Self::SessionOpen(_) => "session.open",
            Self::SessionClose(_) => "session.close",
            Self::Call(_) => "call",
            Self::Cancel(_) => "cancel",
        }
    }
}

#[derive(Serialize)]
struct RequestWire<'a, P: Serialize> {
    id: &'a str,
    method: &'static str,
    params: &'a P,
}

impl Serialize for Request {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let method = self.body.method_name();
        match &self.body {
            RequestBody::Initialize(p) => RequestWire {
                id: &self.id,
                method,
                params: p,
            }
            .serialize(serializer),
            RequestBody::SessionOpen(p) => RequestWire {
                id: &self.id,
                method,
                params: p,
            }
            .serialize(serializer),
            RequestBody::SessionClose(p) => RequestWire {
                id: &self.id,
                method,
                params: p,
            }
            .serialize(serializer),
            RequestBody::Call(p) => RequestWire {
                id: &self.id,
                method,
                params: p,
            }
            .serialize(serializer),
            RequestBody::Cancel(p) => RequestWire {
                id: &self.id,
                method,
                params: p,
            }
            .serialize(serializer),
        }
    }
}

#[derive(Deserialize)]
struct RawRequest {
    id: String,
    method: String,
    #[serde(default)]
    params: Option<serde_json::Value>,
}

impl<'de> Deserialize<'de> for Request {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = RawRequest::deserialize(deserializer)?;
        let params_val = raw
            .params
            .unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new()));
        let body = match raw.method.as_str() {
            "initialize" => {
                let p: InitializeParams =
                    serde_json::from_value(params_val).map_err(serde::de::Error::custom)?;
                RequestBody::Initialize(p)
            }
            "session.open" => {
                let p: SessionOpenParams =
                    serde_json::from_value(params_val).map_err(serde::de::Error::custom)?;
                RequestBody::SessionOpen(p)
            }
            "session.close" => {
                let p: SessionCloseParams =
                    serde_json::from_value(params_val).map_err(serde::de::Error::custom)?;
                RequestBody::SessionClose(p)
            }
            "call" => {
                let p: CallParams =
                    serde_json::from_value(params_val).map_err(serde::de::Error::custom)?;
                RequestBody::Call(p)
            }
            "cancel" => {
                let p: CancelParams =
                    serde_json::from_value(params_val).map_err(serde::de::Error::custom)?;
                RequestBody::Cancel(p)
            }
            other => {
                return Err(serde::de::Error::custom(format!("unknown method: {other}")));
            }
        };
        Ok(Self { id: raw.id, body })
    }
}

/// Parameters for `initialize`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<String>,
}

/// Result returned in `completed.result` for `initialize`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub protocol_version: String,
    pub server_name: String,
    pub server_version: String,
    pub capabilities: Capabilities,
}

/// Parameters for `session.open`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOpenParams {
    /// Optional capability narrowing; cannot widen host policy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<SessionCapabilities>,
}

/// Result returned in `completed.result` for `session.open`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOpenResult {
    pub session_id: String,
    pub allow_write: bool,
    pub effective_limits: HardLimits,
}

/// Parameters for `session.close`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCloseParams {
    pub session_id: String,
}

/// Result returned in `completed.result` for `session.close`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCloseResult {
    pub session_id: String,
    pub closed: bool,
}

/// Parameters for `call`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallParams {
    pub session_id: String,
    pub operation: Operation,
    /// Stable client-supplied idempotency key for mutations across reconnect/restart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    /// Optional per-call deadline in milliseconds (clamped by host `maxDeadlineMs`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_ms: Option<u64>,
}

/// Parameters for `cancel`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelParams {
    pub request_id: String,
}

// ============================================================================
// NDJSON Events (server -> client)
// ============================================================================

/// Top-level NDJSON event envelope (server -> client).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// Monotonically increasing sequence number per request (starts at 1; 0 for connection-level `protocol_error`).
    pub seq: u64,
    #[serde(flatten)]
    pub payload: EventPayload,
}

impl Event {
    #[must_use]
    pub fn records(
        request_id: impl Into<String>,
        seq: u64,
        records: Vec<serde_json::Value>,
        schema_version: Option<String>,
    ) -> Self {
        Self {
            request_id: Some(request_id.into()),
            seq,
            payload: EventPayload::Records {
                records,
                schema_version,
            },
        }
    }

    #[must_use]
    pub fn completed_ok(
        request_id: impl Into<String>,
        seq: u64,
        truncated: bool,
        counters: CompletionCounters,
        result: Option<serde_json::Value>,
    ) -> Self {
        Self {
            request_id: Some(request_id.into()),
            seq,
            payload: EventPayload::Completed {
                status: CompletedStatus::Ok,
                truncated,
                counters,
                result,
                error: None,
            },
        }
    }

    #[must_use]
    pub fn completed_err(
        request_id: impl Into<String>,
        seq: u64,
        status: CompletedStatus,
        truncated: bool,
        counters: CompletionCounters,
        error: ErrorInfo,
    ) -> Self {
        Self {
            request_id: Some(request_id.into()),
            seq,
            payload: EventPayload::Completed {
                status,
                truncated,
                counters,
                result: None,
                error: Some(error),
            },
        }
    }

    #[must_use]
    pub fn protocol_error(code: ErrorCode, message: impl Into<String>, fatal: bool) -> Self {
        Self {
            request_id: None,
            seq: 0,
            payload: EventPayload::ProtocolError {
                code,
                message: message.into(),
                fatal,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventPayload {
    Records {
        records: Vec<serde_json::Value>,
        #[serde(
            default,
            rename = "schemaVersion",
            skip_serializing_if = "Option::is_none"
        )]
        schema_version: Option<String>,
    },
    Bytes {
        #[serde(rename = "dataBase64")]
        data_base64: String,
        encoding: BytesEncoding,
        eof: bool,
    },
    Diagnostic {
        severity: DiagnosticSeverity,
        code: ErrorCode,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        span: Option<Span>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hint: Option<String>,
    },
    Completed {
        status: CompletedStatus,
        truncated: bool,
        counters: CompletionCounters,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<ErrorInfo>,
    },
    ProtocolError {
        code: ErrorCode,
        message: String,
        fatal: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BytesEncoding {
    Base64,
    Utf8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletedStatus {
    Ok,
    Error,
    Cancelled,
    Timeout,
    LimitExceeded,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionCounters {
    pub records_emitted: u64,
    pub bytes_emitted: u64,
    pub duration_ms: u64,
}
