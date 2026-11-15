//! Protocol v1 NDJSON DTOs, error codes, capability limits, and validation.
//!
//! This crate intentionally has zero filesystem, network, or process dependencies.

pub mod error;
pub mod limits;
pub mod messages;
pub mod operations;
pub mod validate;

pub use error::{DiagnosticSeverity, ErrorCode, ErrorInfo, ProtocolError, Span};
pub use limits::{
    Capabilities, ClientLimits, DEFAULT_DEADLINE_MS, DEFAULT_MAX_BATCH_RECORDS,
    DEFAULT_MAX_CONCURRENT_MUTATIONS_PER_WORKSPACE, DEFAULT_MAX_CONCURRENT_READS_PER_CONNECTION,
    DEFAULT_MAX_DEADLINE_MS, DEFAULT_MAX_EDIT_FILE_BYTES, DEFAULT_MAX_FRAME_BYTES,
    DEFAULT_MAX_OUTPUT_BYTES_PER_REQUEST, HardLimits, PROTOCOL_VERSION, SERVER_NAME,
    SERVER_VERSION, SessionCapabilities,
};
pub use messages::{
    BytesEncoding, CallParams, CancelParams, CompletedStatus, CompletionCounters, Event,
    EventPayload, InitializeParams, InitializeResult, Request, RequestBody, SessionCloseParams,
    SessionCloseResult, SessionOpenParams, SessionOpenResult,
};
pub use operations::{
    BatchFileOp, BatchItemResult, ContextBundleParams, ContextBundleResult, ContextTestMatch,
    DeleteFileParams, DeleteFileResult, EditParams, EditSpec, EntryKind, EolKind, FieldSchema,
    FieldType, ListEntry, ListParams, Operation, OperationSchema, OutlineFile, OutlineParams,
    OutlineSymbol, PatchBatchParams, PatchBatchResult, PatchParams, PatchResult, ReadFormat,
    ReadLine, ReadParams, ReadResult, RenameFileParams, RenameFileResult, SchemaParams,
    SearchMatch, SearchParams, TextEdit, TxKind, TxListParams, TxRecord, TxState, TxUndoParams,
    TxUndoResult, WriteFileParams, WriteFileResult, builtin_operation_schemas,
};
pub use validate::{
    normalize_relative_path, validate_operation, validate_patch_edits, validate_relative_path,
    validate_request, validate_revision_hex,
};
