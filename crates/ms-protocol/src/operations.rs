use serde::{Deserialize, Serialize};

/// Typed structured operations supported by Protocol v1 `call`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Operation {
    List(ListParams),
    Search(SearchParams),
    Read(ReadParams),
    Patch(PatchParams),
    #[serde(rename = "patch.batch")]
    PatchBatch(PatchBatchParams),
    Edit(EditParams),
    #[serde(rename = "write_file")]
    WriteFile(WriteFileParams),
    #[serde(rename = "delete_file")]
    DeleteFile(DeleteFileParams),
    #[serde(rename = "rename_file")]
    RenameFile(RenameFileParams),
    Outline(OutlineParams),
    #[serde(rename = "context_bundle")]
    ContextBundle(ContextBundleParams),
    #[serde(rename = "tx.list")]
    TxList(TxListParams),
    #[serde(rename = "tx.undo")]
    TxUndo(TxUndoParams),
    Schema(SchemaParams),
}

impl Operation {
    /// Canonical operation name as used on the wire and in capabilities.
    #[must_use]
    pub const fn kind_name(&self) -> &'static str {
        match self {
            Self::List(_) => "list",
            Self::Search(_) => "search",
            Self::Read(_) => "read",
            Self::Patch(_) => "patch",
            Self::PatchBatch(_) => "patch.batch",
            Self::Edit(_) => "edit",
            Self::WriteFile(_) => "write_file",
            Self::DeleteFile(_) => "delete_file",
            Self::RenameFile(_) => "rename_file",
            Self::Outline(_) => "outline",
            Self::ContextBundle(_) => "context_bundle",
            Self::TxList(_) => "tx.list",
            Self::TxUndo(_) => "tx.undo",
            Self::Schema(_) => "schema",
        }
    }

    /// Returns true if this operation can mutate workspace files.
    #[must_use]
    pub const fn is_mutation(&self) -> bool {
        matches!(
            self,
            Self::Patch(_)
                | Self::PatchBatch(_)
                | Self::Edit(_)
                | Self::WriteFile(_)
                | Self::DeleteFile(_)
                | Self::RenameFile(_)
                | Self::TxUndo(_)
        )
    }
}

/// Parameters for `list`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recursive: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depth: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_entries: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_hidden: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub respect_ignore: Option<bool>,
}

/// Parameters for `search`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchParams {
    pub query: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub regex: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub case_sensitive: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_matches: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_lines: Option<usize>,
}

/// Output format for `read`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReadFormat {
    #[default]
    Json,
    Hashline,
}

/// Parameters for `read`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadParams {
    pub path: String,
    /// 1-based starting line number (default: 1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u64>,
    /// Maximum number of lines to return.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_count: Option<u64>,
    /// Output format (`json` default, or `hashline` for compact LLM context).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<ReadFormat>,
}

/// Parameters for `edit` (LLM-friendly multi-mode file mutation).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditParams {
    pub path: String,
    /// Optional full 64-char hex BLAKE3 digest of the entire file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<String>,
    pub edits: Vec<EditSpec>,
    /// When true, validates and returns a preview without modifying the file or journal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// Flexible edit specification: line-range+tag, unique `oldText`/`newText`, or byte-range.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum EditSpec {
    Line {
        #[serde(rename = "startLine")]
        start_line: u64,
        #[serde(rename = "endLine")]
        end_line: u64,
        #[serde(default, rename = "startTag", skip_serializing_if = "Option::is_none")]
        start_tag: Option<String>,
        #[serde(default, rename = "endTag", skip_serializing_if = "Option::is_none")]
        end_tag: Option<String>,
        replacement: String,
    },
    Text {
        #[serde(rename = "oldText")]
        old_text: String,
        #[serde(rename = "newText")]
        new_text: String,
        #[serde(default, rename = "replaceAll", skip_serializing_if = "Option::is_none")]
        replace_all: Option<bool>,
    },
    Byte(TextEdit),
}

/// Parameters for `write_file`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFileParams {
    pub path: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_if_missing: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overwrite: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// Parameters for `delete_file`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteFileParams {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// Parameters for `rename_file`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameFileParams {
    pub from: String,
    pub to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overwrite: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// Parameters for `outline` (multi-language repo map & symbol extractor).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_files: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_symbols_per_file: Option<usize>,
}

/// Parameters for `context_bundle` (1-shot target snippet + imports + symbols + tests).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBundleParams {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radius: Option<u64>,
}

/// Parameters for `patch`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchParams {
    pub path: String,
    /// Required full 64-char hex BLAKE3 digest of the entire file.
    pub expected_revision: String,
    pub edits: Vec<TextEdit>,
    /// When true, validates and returns a preview without modifying the file or journal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// A single file operation inside `patch.batch`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BatchFileOp {
    Patch(PatchParams),
    Edit(EditParams),
    #[serde(rename = "write_file")]
    WriteFile(WriteFileParams),
    #[serde(rename = "delete_file")]
    DeleteFile(DeleteFileParams),
}

/// Parameters for `patch.batch`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchBatchParams {
    pub operations: Vec<BatchFileOp>,
    /// When true, validates all operations and returns a preview without modifying files or journal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
}

/// A single byte-range edit against the original file snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextEdit {
    /// Inclusive start byte offset in the original file snapshot.
    pub start_byte: u64,
    /// Exclusive end byte offset in the original file snapshot.
    pub end_byte: u64,
    /// Optional expected UTF-8 text (LF-normalized on wire) within `[start_byte, end_byte)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_text: Option<String>,
    /// Optional short line tag for UI/diagnostic anchoring.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_tag: Option<String>,
    /// Replacement UTF-8 text (LF-normalized on wire; runtime converts to file's EOL).
    pub replacement: String,
}

/// Parameters for `tx.list`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TxListParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_undone: Option<bool>,
}

/// Parameters for `tx.undo`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TxUndoParams {
    /// If provided, must match the latest un-undone transaction in the workspace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transaction_id: Option<String>,
}

/// Parameters for `schema`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation: Option<String>,
}

// ============================================================================
// Record & Result DTOs
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListEntry {
    pub path: String,
    pub kind: EntryKind,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    /// 1-based line number.
    pub line_number: u64,
    /// Short line tag for UI reference (never sole write precondition).
    pub line_tag: String,
    /// Byte offset of match start within the file.
    pub start_byte: u64,
    /// Byte offset of match end within the file.
    pub end_byte: u64,
    /// Byte offset of the start of the line, for locating the match in line_text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_start_byte: Option<u64>,
    /// Line text (LF-normalized).
    pub line_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadLine {
    /// 1-based line number.
    pub line_number: u64,
    /// Short line tag for UI reference.
    pub line_tag: String,
    /// Byte offset of the start of this line (excluding any leading BOM on line 1? No: exact byte offset in file).
    pub start_byte: u64,
    /// Byte offset of the end of this line's content (before EOL).
    pub end_byte: u64,
    /// Line text (without EOL).
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EolKind {
    Lf,
    Crlf,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResult {
    pub path: String,
    /// Full 64-char hex BLAKE3 digest of the entire file snapshot.
    pub file_revision: String,
    pub total_lines: u64,
    pub total_bytes: u64,
    pub eol: EolKind,
    pub has_bom: bool,
    pub has_trailing_newline: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hashline: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFileResult {
    pub path: String,
    pub dry_run: bool,
    pub created: bool,
    pub before_revision: String,
    pub after_revision: String,
    pub bytes_written: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transaction_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteFileResult {
    pub path: String,
    pub dry_run: bool,
    pub before_revision: String,
    pub bytes_deleted: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transaction_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameFileResult {
    pub from: String,
    pub to: String,
    pub dry_run: bool,
    pub file_revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transaction_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineSymbol {
    pub line: u64,
    pub kind: String,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineFile {
    pub path: String,
    pub lines: u64,
    pub symbols: Vec<OutlineSymbol>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextTestMatch {
    pub path: String,
    pub snippet: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBundleResult {
    pub path: String,
    pub file_revision: String,
    pub target_line: u64,
    pub hashline_snippet: String,
    pub imports: Vec<String>,
    pub local_symbols: Vec<OutlineSymbol>,
    pub related_tests: Vec<ContextTestMatch>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchResult {
    pub path: String,
    pub dry_run: bool,
    pub before_revision: String,
    pub after_revision: String,
    pub edits_applied: usize,
    pub bytes_delta: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transaction_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff_preview: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchItemResult {
    pub kind: String,
    pub path: String,
    pub before_revision: String,
    pub after_revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transaction_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchBatchResult {
    pub dry_run: bool,
    pub operations_applied: usize,
    pub results: Vec<BatchItemResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TxKind {
    Patch,
    Write,
    Delete,
    Rename,
    Undo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TxState {
    Prepared,
    Committed,
    Aborted,
    Conflict,
    Undone,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TxRecord {
    pub transaction_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    pub kind: TxKind,
    pub state: TxState,
    pub path: String,
    pub before_revision: String,
    pub after_revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_tx_id: Option<String>,
    pub epoch: u64,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TxUndoResult {
    pub undo_transaction_id: String,
    pub undone_transaction_id: String,
    pub path: String,
    pub before_revision: String,
    pub restored_revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

// ============================================================================
// Schema Metadata DTOs
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldType {
    String,
    U64,
    I64,
    Usize,
    Bool,
    Enum,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldSchema {
    pub name: String,
    pub field_type: FieldType,
    pub nullable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationSchema {
    pub name: String,
    pub description: String,
    pub mutates: bool,
    pub fields: Vec<FieldSchema>,
}

fn field(name: &str, field_type: FieldType, nullable: bool) -> FieldSchema {
    FieldSchema {
        name: name.to_string(),
        field_type,
        nullable,
    }
}

/// Returns the fixed record schemas for all Protocol v1 operations.
#[must_use]
pub fn builtin_operation_schemas() -> Vec<OperationSchema> {
    vec![
        OperationSchema {
            name: "list".to_string(),
            description: "List workspace files and directories deterministically with ignore rules.".to_string(),
            mutates: false,
            fields: vec![
                field("path", FieldType::String, false),
                field("kind", FieldType::Enum, false),
                field("sizeBytes", FieldType::U64, false),
            ],
        },
        OperationSchema {
            name: "search".to_string(),
            description: "Bounded literal or regex search across readable workspace files.".to_string(),
            mutates: false,
            fields: vec![
                field("path", FieldType::String, false),
                field("lineNumber", FieldType::U64, false),
                field("lineTag", FieldType::String, false),
                field("startByte", FieldType::U64, false),
                field("endByte", FieldType::U64, false),
                field("lineText", FieldType::String, false),
            ],
        },
        OperationSchema {
            name: "read".to_string(),
            description: "Read lines with 1-based line numbers, tags, byte offsets, and full BLAKE3 fileRevision.".to_string(),
            mutates: false,
            fields: vec![
                field("lineNumber", FieldType::U64, false),
                field("lineTag", FieldType::String, false),
                field("startByte", FieldType::U64, false),
                field("endByte", FieldType::U64, false),
                field("text", FieldType::String, false),
            ],
        },
        OperationSchema {
            name: "patch".to_string(),
            description: "Atomically and durably patch a single regular file with expectedRevision precondition.".to_string(),
            mutates: true,
            fields: vec![
                field("path", FieldType::String, false),
                field("dryRun", FieldType::Bool, false),
                field("beforeRevision", FieldType::String, false),
                field("afterRevision", FieldType::String, false),
                field("editsApplied", FieldType::Usize, false),
                field("bytesDelta", FieldType::I64, false),
                field("transactionId", FieldType::String, true),
                field("operationId", FieldType::String, true),
                field("diffPreview", FieldType::String, true),
            ],
        },
        OperationSchema {
            name: "patch.batch".to_string(),
            description: "Atomically apply a batch of file mutations with up-front validation and automatic preimage rollback on failure.".to_string(),
            mutates: true,
            fields: vec![
                field("dryRun", FieldType::Bool, false),
                field("operationsApplied", FieldType::Usize, false),
                field("results", FieldType::Enum, false),
                field("operationId", FieldType::String, true),
            ],
        },
        OperationSchema {
            name: "edit".to_string(),
            description: "Atomically and durably edit a file via line-range+tag, oldText/newText, or byte-range.".to_string(),
            mutates: true,
            fields: vec![
                field("path", FieldType::String, false),
                field("dryRun", FieldType::Bool, false),
                field("beforeRevision", FieldType::String, false),
                field("afterRevision", FieldType::String, false),
                field("editsApplied", FieldType::Usize, false),
                field("bytesDelta", FieldType::I64, false),
                field("transactionId", FieldType::String, true),
                field("operationId", FieldType::String, true),
                field("diffPreview", FieldType::String, true),
            ],
        },
        OperationSchema {
            name: "write_file".to_string(),
            description: "Atomically create or overwrite a regular file with WAL journaling and undo.".to_string(),
            mutates: true,
            fields: vec![
                field("path", FieldType::String, false),
                field("dryRun", FieldType::Bool, false),
                field("created", FieldType::Bool, false),
                field("beforeRevision", FieldType::String, false),
                field("afterRevision", FieldType::String, false),
                field("bytesWritten", FieldType::U64, false),
                field("transactionId", FieldType::String, true),
                field("operationId", FieldType::String, true),
            ],
        },
        OperationSchema {
            name: "delete_file".to_string(),
            description: "Atomically delete a regular file with WAL preimage and undo.".to_string(),
            mutates: true,
            fields: vec![
                field("path", FieldType::String, false),
                field("dryRun", FieldType::Bool, false),
                field("beforeRevision", FieldType::String, false),
                field("bytesDeleted", FieldType::U64, false),
                field("transactionId", FieldType::String, true),
                field("operationId", FieldType::String, true),
            ],
        },
        OperationSchema {
            name: "rename_file".to_string(),
            description: "Atomically rename/move a regular file within the workspace with WAL journaling and undo.".to_string(),
            mutates: true,
            fields: vec![
                field("from", FieldType::String, false),
                field("to", FieldType::String, false),
                field("dryRun", FieldType::Bool, false),
                field("fileRevision", FieldType::String, false),
                field("transactionId", FieldType::String, true),
                field("operationId", FieldType::String, true),
            ],
        },
        OperationSchema {
            name: "outline".to_string(),
            description: "Extract multi-language file tree and key symbol signatures in 1 call.".to_string(),
            mutates: false,
            fields: vec![
                field("path", FieldType::String, false),
                field("lines", FieldType::U64, false),
                field("symbols", FieldType::Enum, false),
            ],
        },
        OperationSchema {
            name: "context_bundle".to_string(),
            description: "Return target hashline snippet, local imports/symbols, and related tests in 1 call.".to_string(),
            mutates: false,
            fields: vec![
                field("path", FieldType::String, false),
                field("fileRevision", FieldType::String, false),
                field("targetLine", FieldType::U64, false),
                field("hashlineSnippet", FieldType::String, false),
                field("imports", FieldType::Enum, false),
                field("localSymbols", FieldType::Enum, false),
                field("relatedTests", FieldType::Enum, false),
            ],
        },
        OperationSchema {
            name: "tx.list".to_string(),
            description: "List durable journal transactions for the workspace.".to_string(),
            mutates: false,
            fields: vec![
                field("transactionId", FieldType::String, false),
                field("operationId", FieldType::String, true),
                field("kind", FieldType::Enum, false),
                field("state", FieldType::Enum, false),
                field("path", FieldType::String, false),
                field("beforeRevision", FieldType::String, false),
                field("afterRevision", FieldType::String, false),
                field("targetTxId", FieldType::String, true),
                field("epoch", FieldType::U64, false),
                field("createdAtMs", FieldType::U64, false),
            ],
        },
        OperationSchema {
            name: "tx.undo".to_string(),
            description: "Durably undo the latest un-undone workspace transaction after verifying postimage.".to_string(),
            mutates: true,
            fields: vec![
                field("undoTransactionId", FieldType::String, false),
                field("undoneTransactionId", FieldType::String, false),
                field("path", FieldType::String, false),
                field("beforeRevision", FieldType::String, false),
                field("restoredRevision", FieldType::String, false),
                field("operationId", FieldType::String, true),
            ],
        },
        OperationSchema {
            name: "schema".to_string(),
            description: "Describe record schemas for Protocol v1 operations.".to_string(),
            mutates: false,
            fields: vec![
                field("name", FieldType::String, false),
                field("description", FieldType::String, false),
                field("mutates", FieldType::Bool, false),
                field("fields", FieldType::Enum, false),
            ],
        },
    ]
}
