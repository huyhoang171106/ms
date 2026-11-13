use serde::{Deserialize, Serialize};

/// Protocol wire version.
pub const PROTOCOL_VERSION: &str = "1.0";

/// Server identifier returned in `initialize`.
pub const SERVER_NAME: &str = "ms";

/// Server crate version.
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Default limits for Protocol v1 (Section 4.1).
pub const DEFAULT_MAX_FRAME_BYTES: usize = 1024 * 1024; // 1 MiB
pub const DEFAULT_MAX_EDIT_FILE_BYTES: usize = 8 * 1024 * 1024; // 8 MiB
pub const DEFAULT_MAX_BATCH_RECORDS: usize = 256;
pub const DEFAULT_MAX_OUTPUT_BYTES_PER_REQUEST: usize = 1024 * 1024; // 1 MiB
pub const DEFAULT_DEADLINE_MS: u64 = 30_000;
pub const DEFAULT_MAX_DEADLINE_MS: u64 = 300_000;
pub const DEFAULT_MAX_CONCURRENT_READS_PER_CONNECTION: usize = 4;
pub const DEFAULT_MAX_CONCURRENT_MUTATIONS_PER_WORKSPACE: usize = 1;

/// Host-enforced hard limits. Clients may narrow these via `ClientLimits`, never widen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardLimits {
    pub max_frame_bytes: usize,
    pub max_edit_file_bytes: usize,
    pub max_batch_records: usize,
    pub max_output_bytes_per_request: usize,
    pub default_deadline_ms: u64,
    pub max_deadline_ms: u64,
    pub max_concurrent_reads_per_connection: usize,
    pub max_concurrent_mutations_per_workspace: usize,
}

impl Default for HardLimits {
    fn default() -> Self {
        Self {
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES,
            max_edit_file_bytes: DEFAULT_MAX_EDIT_FILE_BYTES,
            max_batch_records: DEFAULT_MAX_BATCH_RECORDS,
            max_output_bytes_per_request: DEFAULT_MAX_OUTPUT_BYTES_PER_REQUEST,
            default_deadline_ms: DEFAULT_DEADLINE_MS,
            max_deadline_ms: DEFAULT_MAX_DEADLINE_MS,
            max_concurrent_reads_per_connection: DEFAULT_MAX_CONCURRENT_READS_PER_CONNECTION,
            max_concurrent_mutations_per_workspace: DEFAULT_MAX_CONCURRENT_MUTATIONS_PER_WORKSPACE,
        }
    }
}

impl HardLimits {
    /// Returns a new `HardLimits` narrowed by optional `ClientLimits`.
    /// Any client value larger than the host cap is clamped down to the host cap.
    #[must_use]
    pub fn narrow(&self, client: &ClientLimits) -> Self {
        let mut out = self.clone();
        if let Some(v) = client.max_batch_records {
            out.max_batch_records = out.max_batch_records.min(v.max(1));
        }
        if let Some(v) = client.max_output_bytes_per_request {
            out.max_output_bytes_per_request = out.max_output_bytes_per_request.min(v.max(1));
        }
        if let Some(v) = client.default_deadline_ms {
            out.default_deadline_ms = out
                .default_deadline_ms
                .min(v.max(1))
                .min(out.max_deadline_ms);
        }
        out
    }
}

/// Optional client-requested limit overrides (can only narrow `HardLimits`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientLimits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_batch_records: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_bytes_per_request: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_deadline_ms: Option<u64>,
}

/// Actual host capabilities advertised in `initialize`.
/// Clients must inspect these fields rather than inferring capabilities from version strings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub operations: Vec<String>,
    pub allow_write: bool,
    pub allow_external_exec: bool,
    pub supports_cancellation: bool,
    pub supports_idempotency: bool,
    pub max_limits: HardLimits,
}

impl Default for Capabilities {
    fn default() -> Self {
        Self {
            operations: vec![
                "list".to_string(),
                "search".to_string(),
                "read".to_string(),
                "patch".to_string(),
                "tx.list".to_string(),
                "tx.undo".to_string(),
                "schema".to_string(),
            ],
            allow_write: false,
            allow_external_exec: false,
            supports_cancellation: true,
            supports_idempotency: true,
            max_limits: HardLimits::default(),
        }
    }
}

/// Optional capability narrowing requested in `session.open`.
/// Requesting `allow_write: true` when the host has `allow_write: false` is denied.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCapabilities {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_write: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_subpaths: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write_subpaths: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limits: Option<ClientLimits>,
}
