use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use ms_protocol::{
    DeleteFileResult, PatchResult, RenameFileResult, TxKind, TxListParams, TxRecord, TxState,
    TxUndoResult, WriteFileResult,
};
use serde::{Deserialize, Serialize};

use crate::error::RuntimeError;
use crate::lock::WorkspaceLease;
use crate::text::blake3_hex;
use crate::workspace_fs::{WorkspaceFs, write_and_sync_file};

const JOURNAL_FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct JournalEnvelope {
    version: u32,
    digest: String,
    payload: String,
}

const fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "entryType", rename_all = "camelCase")]
#[allow(clippy::large_enum_variant)]
pub enum JournalEntry {
    Prepared {
        tx_id: String,
        operation_id: Option<String>,
        payload_hash: Option<String>,
        kind: TxKind,
        path: String,
        #[serde(default)]
        dest_path: Option<String>,
        #[serde(default = "default_true")]
        existed_before: bool,
        target_dev: u64,
        target_ino: u64,
        target_mode: u32,
        temp_name: String,
        before_revision: String,
        after_revision: String,
        preimage_file: String,
        target_tx_id: Option<String>,
        epoch: u64,
        created_at_ms: u64,
        bytes_delta: i64,
        edits_applied: usize,
    },
    Committed {
        tx_id: String,
        committed_at_ms: u64,
    },
    Aborted {
        tx_id: String,
        reason: String,
        aborted_at_ms: u64,
    },
    Conflict {
        tx_id: String,
        reason: String,
        detected_at_ms: u64,
    },
    Undone {
        tx_id: String,
        undone_by_tx_id: String,
        undone_at_ms: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EpochState {
    epoch: u64,
}

/// In-memory representation of a durable transaction reconstructed from `journal.jsonl`.
#[derive(Debug, Clone)]
pub struct StoredTx {
    pub tx_id: String,
    pub operation_id: Option<String>,
    pub payload_hash: Option<String>,
    pub kind: TxKind,
    pub state: TxState,
    pub path: String,
    pub dest_path: Option<String>,
    pub existed_before: bool,
    pub temp_name: String,
    pub before_revision: String,
    pub after_revision: String,
    pub preimage_file: String,
    pub target_tx_id: Option<String>,
    pub epoch: u64,
    pub created_at_ms: u64,
    pub bytes_delta: i64,
    pub edits_applied: usize,
}

impl StoredTx {
    #[must_use]
    pub fn to_tx_record(&self) -> TxRecord {
        TxRecord {
            transaction_id: self.tx_id.clone(),
            operation_id: self.operation_id.clone(),
            kind: self.kind,
            state: self.state,
            path: self.path.clone(),
            before_revision: self.before_revision.clone(),
            after_revision: self.after_revision.clone(),
            target_tx_id: self.target_tx_id.clone(),
            epoch: self.epoch,
            created_at_ms: self.created_at_ms,
        }
    }

    #[must_use]
    pub fn to_patch_result(&self) -> PatchResult {
        PatchResult {
            path: self.path.clone(),
            dry_run: false,
            before_revision: self.before_revision.clone(),
            after_revision: self.after_revision.clone(),
            edits_applied: self.edits_applied,
            bytes_delta: self.bytes_delta,
            transaction_id: Some(self.tx_id.clone()),
            operation_id: self.operation_id.clone(),
            diff_preview: None,
        }
    }

    #[must_use]
    pub fn to_undo_result(&self) -> TxUndoResult {
        TxUndoResult {
            undo_transaction_id: self.tx_id.clone(),
            undone_transaction_id: self.target_tx_id.clone().unwrap_or_default(),
            path: self.path.clone(),
            before_revision: self.before_revision.clone(),
            restored_revision: self.after_revision.clone(),
            operation_id: self.operation_id.clone(),
        }
    }

    #[must_use]
    pub fn to_write_result(&self) -> WriteFileResult {
        WriteFileResult {
            path: self.path.clone(),
            dry_run: false,
            created: !self.existed_before,
            before_revision: self.before_revision.clone(),
            after_revision: self.after_revision.clone(),
            bytes_written: self.bytes_delta.max(0) as u64,
            transaction_id: Some(self.tx_id.clone()),
            operation_id: self.operation_id.clone(),
        }
    }

    #[must_use]
    pub fn to_delete_result(&self) -> DeleteFileResult {
        DeleteFileResult {
            path: self.path.clone(),
            dry_run: false,
            before_revision: self.before_revision.clone(),
            bytes_deleted: (-self.bytes_delta).max(0) as u64,
            transaction_id: Some(self.tx_id.clone()),
            operation_id: self.operation_id.clone(),
        }
    }

    #[must_use]
    pub fn to_rename_result(&self) -> RenameFileResult {
        RenameFileResult {
            from: self.path.clone(),
            to: self.dest_path.clone().unwrap_or_default(),
            dry_run: false,
            file_revision: self.after_revision.clone(),
            transaction_id: Some(self.tx_id.clone()),
            operation_id: self.operation_id.clone(),
        }
    }
}

/// Durable per-workspace transaction journal, preimage store, and crash-recovery engine.
#[derive(Debug)]
pub struct WorkspaceJournal {
    ws_dir: PathBuf,
    preimages_dir: PathBuf,
    journal_path: PathBuf,
    epoch_path: PathBuf,
    max_state_bytes: u64,
    current_epoch: u64,
    txs: Vec<StoredTx>,
    tx_index: HashMap<String, usize>,
    op_index: HashMap<String, usize>,
    next_seq: u64,
}

impl WorkspaceJournal {
    /// Opens (or initializes) the workspace journal and runs startup crash recovery.
    pub fn open_and_recover(
        state_dir: &Path,
        fs: &WorkspaceFs,
        max_state_bytes: u64,
        max_file_bytes: usize,
    ) -> Result<Self, RuntimeError> {
        let (dev, ino) = fs.root_identity();
        WorkspaceLease::ensure_private_dir(state_dir)?;
        let workspaces_dir = state_dir.join("workspaces");
        WorkspaceLease::ensure_private_dir(&workspaces_dir)?;

        let ws_dir = workspaces_dir.join(format!("{dev}_{ino}"));
        WorkspaceLease::ensure_private_dir(&ws_dir)?;

        let preimages_dir = ws_dir.join("preimages");
        WorkspaceLease::ensure_private_dir(&preimages_dir)?;

        let journal_path = ws_dir.join("journal.jsonl");
        let epoch_path = ws_dir.join("epoch.json");

        let current_epoch = load_or_init_epoch(&epoch_path)?;

        let mut journal = Self {
            ws_dir,
            preimages_dir,
            journal_path,
            epoch_path,
            max_state_bytes,
            current_epoch,
            txs: Vec::new(),
            tx_index: HashMap::new(),
            op_index: HashMap::new(),
            next_seq: 1,
        };

        journal.load_journal()?;
        journal.recover_prepared(fs, max_file_bytes)?;

        Ok(journal)
    }

    #[must_use]
    pub const fn current_epoch(&self) -> u64 {
        self.current_epoch
    }

    /// Advances the retention epoch (older `operationId`s will return `EIdempotencyExpired`).
    pub fn advance_epoch(&mut self) -> Result<u64, RuntimeError> {
        self.current_epoch += 1;
        save_epoch(&self.epoch_path, self.current_epoch)?;
        Ok(self.current_epoch)
    }

    /// Generates a unique transaction ID.
    pub fn next_tx_id(&mut self) -> String {
        let seq = self.next_seq;
        self.next_seq += 1;
        format!("tx-{}-{seq:06}", now_ms())
    }

    /// Returns true if any transaction in the journal is in `TxState::Conflict`.
    #[must_use]
    pub fn has_unresolved_conflict(&self) -> bool {
        self.txs.iter().any(|t| t.state == TxState::Conflict)
    }

    /// Checks idempotency for `operation_id` and `payload_hash`.
    /// Returns `Ok(Some(tx))` if the operation already committed and should be replayed.
    pub fn check_idempotency(
        &self,
        operation_id: &str,
        payload_hash: &str,
    ) -> Result<Option<&StoredTx>, RuntimeError> {
        let Some(&idx) = self.op_index.get(operation_id) else {
            return Ok(None);
        };
        let tx = &self.txs[idx];
        if tx.epoch < self.current_epoch {
            return Err(RuntimeError::IdempotencyExpired(format!(
                "operationId '{operation_id}' belongs to expired epoch {} (current {})",
                tx.epoch, self.current_epoch
            )));
        }
        if tx.payload_hash.as_deref() != Some(payload_hash) {
            return Err(RuntimeError::IdempotencyConflict(format!(
                "operationId '{operation_id}' was already used with a different payload"
            )));
        }
        match tx.state {
            TxState::Committed | TxState::Undone => Ok(Some(tx)),
            TxState::Conflict => Err(RuntimeError::RecoveryConflict(format!(
                "previous execution of operationId '{operation_id}' ended in recovery conflict"
            ))),
            TxState::Prepared => Err(RuntimeError::RecoveryConflict(format!(
                "operationId '{operation_id}' is still in PREPARED state"
            ))),
            TxState::Aborted => {
                // Previous attempt aborted before commit; allow clean retry.
                Ok(None)
            }
        }
    }

    /// Checks that writing `additional_bytes` to state dir will not exceed `max_state_bytes`.
    pub fn check_state_quota(&self, additional_bytes: u64) -> Result<(), RuntimeError> {
        let current = self.current_state_bytes()?;
        if current.saturating_add(additional_bytes) > self.max_state_bytes {
            return Err(RuntimeError::ResourceLimit(format!(
                "state/ledger quota exceeded ({} + {} > {} bytes)",
                current, additional_bytes, self.max_state_bytes
            )));
        }
        Ok(())
    }

    /// Writes preimage bytes to `preimages/<preimage_file>` (mode 0600) and fsyncs file + dir.
    pub fn write_preimage(&self, preimage_file: &str, bytes: &[u8]) -> Result<(), RuntimeError> {
        let path = self.preimages_dir.join(preimage_file);
        let mut f = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&path)
            .map_err(|e| RuntimeError::Io(format!("create preimage file: {e}")))?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|e| RuntimeError::Io(format!("chmod preimage file: {e}")))?;
        write_and_sync_file(&mut f, bytes)?;
        sync_dir(&self.preimages_dir)?;
        Ok(())
    }

    /// Reads preimage bytes and verifies their BLAKE3 digest matches `expected_digest`.
    pub fn read_preimage(
        &self,
        preimage_file: &str,
        expected_digest: &str,
    ) -> Result<Vec<u8>, RuntimeError> {
        let path = self.preimages_dir.join(preimage_file);
        let bytes = fs::read(&path)
            .map_err(|e| RuntimeError::Io(format!("read preimage '{preimage_file}': {e}")))?;
        let actual = blake3_hex(&bytes);
        if actual != expected_digest {
            return Err(RuntimeError::RecoveryConflict(format!(
                "preimage '{preimage_file}' checksum mismatch (expected {expected_digest}, actual {actual})"
            )));
        }
        Ok(bytes)
    }

    /// Appends a versioned, checksummed `JournalEntry` to `journal.jsonl` and fsyncs.
    pub fn append_entry(&mut self, entry: JournalEntry) -> Result<(), RuntimeError> {
        let payload = serde_json::to_string(&entry)
            .map_err(|e| RuntimeError::Internal(format!("serialize journal entry: {e}")))?;
        let digest = blake3_hex(payload.as_bytes());
        let env = JournalEnvelope {
            version: JOURNAL_FORMAT_VERSION,
            digest,
            payload,
        };
        let mut line = serde_json::to_string(&env)
            .map_err(|e| RuntimeError::Internal(format!("serialize journal envelope: {e}")))?;
        line.push('\n');

        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(&self.journal_path)
            .map_err(|e| RuntimeError::Io(format!("open journal.jsonl: {e}")))?;
        fs::set_permissions(&self.journal_path, fs::Permissions::from_mode(0o600))
            .map_err(|e| RuntimeError::Io(format!("chmod journal.jsonl: {e}")))?;
        write_and_sync_file(&mut f, line.as_bytes())?;
        sync_dir(&self.ws_dir)?;

        self.apply_entry_in_memory(entry);
        Ok(())
    }

    /// Lists transactions in reverse chronological order (newest first), optionally filtered.
    #[must_use]
    pub fn list_transactions(&self, params: &TxListParams) -> Vec<TxRecord> {
        let include_undone = params.include_undone.unwrap_or(true);
        let mut out = Vec::new();
        for tx in self.txs.iter().rev() {
            if !include_undone && tx.state == TxState::Undone {
                continue;
            }
            if let Some(op_id) = &params.operation_id
                && tx.operation_id.as_deref() != Some(op_id.as_str())
            {
                continue;
            }
            out.push(tx.to_tx_record());
            if let Some(limit) = params.limit
                && out.len() >= limit
            {
                break;
            }
        }
        out
    }

    /// Finds the latest un-undone `Patch` transaction in the workspace.
    #[must_use]
    pub fn latest_undoable(&self) -> Option<&StoredTx> {
        self.txs
            .iter()
            .rev()
            .find(|tx| tx.kind != TxKind::Undo && tx.state == TxState::Committed)
    }

    fn load_journal(&mut self) -> Result<(), RuntimeError> {
        if !self.journal_path.exists() {
            return Ok(());
        }
        let mut f = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&self.journal_path)
            .map_err(|e| RuntimeError::Io(format!("open journal.jsonl for recovery: {e}")))?;

        let mut raw = Vec::new();
        f.read_to_end(&mut raw)
            .map_err(|e| RuntimeError::Io(format!("read journal.jsonl: {e}")))?;

        if raw.is_empty() {
            return Ok(());
        }

        let mut valid_end: usize = 0;
        let mut pos: usize = 0;
        let total_len = raw.len();

        while pos < total_len {
            let next_nl = raw[pos..].iter().position(|&b| b == b'\n');
            let (line_bytes, line_end, is_last) = match next_nl {
                Some(rel) => {
                    let end = pos + rel + 1;
                    (&raw[pos..pos + rel], end, end == total_len)
                }
                None => (&raw[pos..], total_len, true),
            };

            if line_bytes.is_empty() {
                pos = line_end;
                valid_end = line_end;
                continue;
            }

            let parsed = parse_and_verify_line(line_bytes);
            match parsed {
                Ok(entry) => {
                    self.apply_entry_in_memory(entry);
                    valid_end = line_end;
                    pos = line_end;
                }
                Err(reason) => {
                    if is_last {
                        // Incomplete/corrupt tail from crash mid-write: truncate back to valid_end.
                        f.set_len(valid_end as u64).map_err(|e| {
                            RuntimeError::Io(format!("truncate corrupt journal tail: {e}"))
                        })?;
                        f.seek(SeekFrom::End(0)).ok();
                        f.sync_all().map_err(|e| {
                            RuntimeError::Io(format!("fsync truncated journal: {e}"))
                        })?;
                        break;
                    }
                    return Err(RuntimeError::RecoveryConflict(format!(
                        "corrupt journal record at byte offset {pos}: {reason}"
                    )));
                }
            }
        }

        self.next_seq = (self.txs.len() as u64) + 1;
        Ok(())
    }

    fn recover_prepared(
        &mut self,
        fs: &WorkspaceFs,
        max_file_bytes: usize,
    ) -> Result<(), RuntimeError> {
        let prepared_indices: Vec<usize> = self
            .txs
            .iter()
            .enumerate()
            .filter(|(_, tx)| tx.state == TxState::Prepared)
            .map(|(i, _)| i)
            .collect();

        for idx in prepared_indices {
            let tx = self.txs[idx].clone();
            // Clean up any orphaned staging temp file.
            fs.cleanup_temp_file(&tx.path, &tx.temp_name);

            let check_path = if tx.kind == TxKind::Rename
                || (tx.kind == TxKind::Undo && tx.dest_path.is_some())
            {
                tx.dest_path.as_deref().unwrap_or(&tx.path)
            } else {
                &tx.path
            };

            let current_digest = match fs.read_file_bytes(check_path, max_file_bytes) {
                Ok((bytes, _)) => Some(blake3_hex(&bytes)),
                Err(_) => None,
            };

            match (tx.kind, current_digest.as_deref()) {
                (TxKind::Delete, None) => {
                    self.append_entry(JournalEntry::Committed {
                        tx_id: tx.tx_id.clone(),
                        committed_at_ms: now_ms(),
                    })?;
                }
                (TxKind::Write, None) if !tx.existed_before => {
                    self.append_entry(JournalEntry::Aborted {
                        tx_id: tx.tx_id.clone(),
                        reason: "startup recovery: newly created file not present".to_string(),
                        aborted_at_ms: now_ms(),
                    })?;
                }
                (TxKind::Rename, None) => {
                    let src_matches_before = fs
                        .read_file_bytes(&tx.path, max_file_bytes)
                        .ok()
                        .is_some_and(|(b, _)| blake3_hex(&b) == tx.before_revision);
                    if src_matches_before {
                        self.append_entry(JournalEntry::Aborted {
                            tx_id: tx.tx_id.clone(),
                            reason: "startup recovery: rename source unchanged".to_string(),
                            aborted_at_ms: now_ms(),
                        })?;
                    } else {
                        self.append_entry(JournalEntry::Conflict {
                            tx_id: tx.tx_id.clone(),
                            reason:
                                "startup recovery: rename destination and source missing/changed"
                                    .to_string(),
                            detected_at_ms: now_ms(),
                        })?;
                    }
                }
                (TxKind::Undo, None) if tx.dest_path.is_some() => {
                    let src_matches_before = fs
                        .read_file_bytes(&tx.path, max_file_bytes)
                        .ok()
                        .is_some_and(|(b, _)| blake3_hex(&b) == tx.before_revision);
                    if src_matches_before {
                        self.append_entry(JournalEntry::Aborted {
                            tx_id: tx.tx_id.clone(),
                            reason: "startup recovery: undo rename source unchanged".to_string(),
                            aborted_at_ms: now_ms(),
                        })?;
                    } else {
                        self.append_entry(JournalEntry::Conflict {
                            tx_id: tx.tx_id.clone(),
                            reason: "startup recovery: undo rename destination missing".to_string(),
                            detected_at_ms: now_ms(),
                        })?;
                    }
                }
                (TxKind::Undo, None) if !tx.existed_before => {
                    if tx.after_revision.is_empty() {
                        // Undoing a file creation (deleting the file) succeeded.
                        self.append_entry(JournalEntry::Committed {
                            tx_id: tx.tx_id.clone(),
                            committed_at_ms: now_ms(),
                        })?;
                        if let Some(target_id) = tx.target_tx_id.clone() {
                            self.append_entry(JournalEntry::Undone {
                                tx_id: target_id,
                                undone_by_tx_id: tx.tx_id.clone(),
                                undone_at_ms: now_ms(),
                            })?;
                        }
                    } else {
                        // Undoing a file deletion (re-creating the file) did not happen.
                        self.append_entry(JournalEntry::Aborted {
                            tx_id: tx.tx_id.clone(),
                            reason: "startup recovery: undo delete target not recreated"
                                .to_string(),
                            aborted_at_ms: now_ms(),
                        })?;
                    }
                }
                (_, Some(d)) if d == tx.after_revision => {
                    self.append_entry(JournalEntry::Committed {
                        tx_id: tx.tx_id.clone(),
                        committed_at_ms: now_ms(),
                    })?;
                    if tx.kind == TxKind::Undo
                        && let Some(target_id) = tx.target_tx_id.clone()
                    {
                        self.append_entry(JournalEntry::Undone {
                            tx_id: target_id,
                            undone_by_tx_id: tx.tx_id.clone(),
                            undone_at_ms: now_ms(),
                        })?;
                    }
                }
                (_, Some(d)) if d == tx.before_revision => {
                    self.append_entry(JournalEntry::Aborted {
                        tx_id: tx.tx_id.clone(),
                        reason: "startup recovery: target unchanged (before_revision)".to_string(),
                        aborted_at_ms: now_ms(),
                    })?;
                }
                _ => {
                    self.append_entry(JournalEntry::Conflict {
                        tx_id: tx.tx_id.clone(),
                        reason:
                            "startup recovery: target matches neither before nor after revision"
                                .to_string(),
                        detected_at_ms: now_ms(),
                    })?;
                }
            }
        }
        Ok(())
    }

    fn apply_entry_in_memory(&mut self, entry: JournalEntry) {
        match entry {
            JournalEntry::Prepared {
                tx_id,
                operation_id,
                payload_hash,
                kind,
                path,
                dest_path,
                existed_before,
                target_dev: _,
                target_ino: _,
                target_mode: _,
                temp_name,
                before_revision,
                after_revision,
                preimage_file,
                target_tx_id,
                epoch,
                created_at_ms,
                bytes_delta,
                edits_applied,
            } => {
                let idx = self.txs.len();
                if let Some(op_id) = &operation_id {
                    self.op_index.insert(op_id.clone(), idx);
                }
                self.tx_index.insert(tx_id.clone(), idx);
                self.txs.push(StoredTx {
                    tx_id,
                    operation_id,
                    payload_hash,
                    kind,
                    state: TxState::Prepared,
                    path,
                    dest_path,
                    existed_before,
                    temp_name,
                    before_revision,
                    after_revision,
                    preimage_file,
                    target_tx_id,
                    epoch,
                    created_at_ms,
                    bytes_delta,
                    edits_applied,
                });
            }
            JournalEntry::Committed { tx_id, .. } => {
                if let Some(&idx) = self.tx_index.get(&tx_id) {
                    self.txs[idx].state = TxState::Committed;
                }
            }
            JournalEntry::Aborted { tx_id, .. } => {
                if let Some(&idx) = self.tx_index.get(&tx_id) {
                    self.txs[idx].state = TxState::Aborted;
                }
            }
            JournalEntry::Conflict { tx_id, .. } => {
                if let Some(&idx) = self.tx_index.get(&tx_id) {
                    self.txs[idx].state = TxState::Conflict;
                }
            }
            JournalEntry::Undone { tx_id, .. } => {
                if let Some(&idx) = self.tx_index.get(&tx_id) {
                    self.txs[idx].state = TxState::Undone;
                }
            }
        }
    }

    fn current_state_bytes(&self) -> Result<u64, RuntimeError> {
        let mut total = 0u64;
        if let Ok(meta) = fs::metadata(&self.journal_path) {
            total = total.saturating_add(meta.len());
        }
        if let Ok(entries) = fs::read_dir(&self.preimages_dir) {
            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata() {
                    total = total.saturating_add(meta.len());
                }
            }
        }
        Ok(total)
    }
}

fn parse_and_verify_line(line_bytes: &[u8]) -> Result<JournalEntry, String> {
    let env: JournalEnvelope =
        serde_json::from_slice(line_bytes).map_err(|e| format!("invalid JSON envelope: {e}"))?;
    if env.version != JOURNAL_FORMAT_VERSION {
        return Err(format!("unsupported journal version {}", env.version));
    }
    let expected = blake3_hex(env.payload.as_bytes());
    if env.digest != expected {
        return Err("journal record checksum mismatch".to_string());
    }
    serde_json::from_str::<JournalEntry>(&env.payload)
        .map_err(|e| format!("invalid journal payload: {e}"))
}

fn load_or_init_epoch(epoch_path: &Path) -> Result<u64, RuntimeError> {
    if epoch_path.exists() {
        let data =
            fs::read(epoch_path).map_err(|e| RuntimeError::Io(format!("read epoch.json: {e}")))?;
        let state: EpochState = serde_json::from_slice(&data)
            .map_err(|e| RuntimeError::RecoveryConflict(format!("corrupt epoch.json: {e}")))?;
        return Ok(state.epoch);
    }
    save_epoch(epoch_path, 1)?;
    Ok(1)
}

fn save_epoch(epoch_path: &Path, epoch: u64) -> Result<(), RuntimeError> {
    let data = serde_json::to_vec(&EpochState { epoch })
        .map_err(|e| RuntimeError::Internal(format!("serialize epoch.json: {e}")))?;
    let mut f = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(epoch_path)
        .map_err(|e| RuntimeError::Io(format!("write epoch.json: {e}")))?;
    fs::set_permissions(epoch_path, fs::Permissions::from_mode(0o600))
        .map_err(|e| RuntimeError::Io(format!("chmod epoch.json: {e}")))?;
    write_and_sync_file(&mut f, &data)?;
    Ok(())
}

fn sync_dir(dir: &Path) -> Result<(), RuntimeError> {
    let f = File::open(dir).map_err(|e| RuntimeError::Io(format!("open dir for fsync: {e}")))?;
    f.sync_all()
        .map_err(|e| RuntimeError::Io(format!("fsync dir: {e}")))?;
    Ok(())
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}
