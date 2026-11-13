use std::path::Path;

use ignore::WalkBuilder;
use ms_protocol::{
    DiagnosticSeverity, EntryKind, ErrorCode, ListEntry, ListParams, OperationSchema, PatchParams,
    PatchResult, ReadParams, ReadResult, SchemaParams, SearchMatch, SearchParams, TxKind,
    TxListParams, TxRecord, TxUndoParams, TxUndoResult, builtin_operation_schemas,
    validate_relative_path,
};
use regex::RegexBuilder;

use crate::CancelToken;
use crate::error::RuntimeError;
use crate::journal::{JournalEntry, WorkspaceJournal, now_ms};
use crate::policy::EffectivePolicy;
use crate::text::{analyze_text, blake3_hex, compute_patch};
use crate::workspace_fs::WorkspaceFs;

/// A non-fatal diagnostic emitted during an operation (e.g., skipped non-UTF-8 path).
#[derive(Debug, Clone)]
pub struct DiagnosticNotice {
    pub severity: DiagnosticSeverity,
    pub code: ErrorCode,
    pub message: String,
    pub path: Option<String>,
}

/// Output of `list`.
pub struct ListOutput {
    pub entries: Vec<ListEntry>,
    pub diagnostics: Vec<DiagnosticNotice>,
    pub truncated: bool,
}

/// Output of `search`.
pub struct SearchOutput {
    pub matches: Vec<SearchMatch>,
    pub diagnostics: Vec<DiagnosticNotice>,
    pub truncated: bool,
}

/// Output of `read`.
pub struct ReadOutput {
    pub result: ReadResult,
    pub lines: Vec<ms_protocol::ReadLine>,
    pub truncated: bool,
}

pub fn exec_list(
    fs: &WorkspaceFs,
    policy: &EffectivePolicy,
    params: &ListParams,
    cancel: &CancelToken,
) -> Result<ListOutput, RuntimeError> {
    let start_rel = params.path.as_deref().unwrap_or(".");
    if start_rel != "." {
        validate_relative_path(start_rel)?;
    }
    policy.check_read(start_rel)?;
    // Verify start directory via openat2(BENEATH | NO_SYMLINKS).
    let _dir_fd = fs.open_dir(start_rel)?;

    let root_abs = fs.root_path();
    let start_abs = if start_rel == "." {
        root_abs.to_path_buf()
    } else {
        root_abs.join(start_rel)
    };

    let respect_ignore = params.respect_ignore.unwrap_or(true);
    let include_hidden = params.include_hidden.unwrap_or(false);
    let max_depth = if params.recursive == Some(false) {
        Some(1)
    } else {
        None
    };

    let mut builder = WalkBuilder::new(&start_abs);
    builder
        .follow_links(false)
        .hidden(!include_hidden)
        .git_ignore(respect_ignore)
        .ignore(respect_ignore)
        .parents(respect_ignore)
        .max_depth(max_depth);

    let root_clone = root_abs.to_path_buf();
    let policy_clone = policy.clone();
    builder.filter_entry(move |entry| {
        let Ok(rel) = entry.path().strip_prefix(&root_clone) else {
            return false;
        };
        let Some(rel_str) = rel.to_str() else {
            return true; // Let main loop emit diagnostic for non-UTF-8
        };
        if rel_str.is_empty() {
            return true;
        }
        if entry.file_type().is_some_and(|ft| ft.is_symlink()) {
            return false;
        }
        if entry.file_type().is_some_and(|ft| ft.is_dir()) {
            policy_clone.may_traverse_dir(rel_str)
        } else {
            policy_clone.check_read(rel_str).is_ok()
        }
    });

    let mut entries = Vec::new();
    let mut diagnostics = Vec::new();
    let mut truncated = false;

    for result in builder.build() {
        if cancel.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        let dent = match result {
            Ok(d) => d,
            Err(err) => {
                diagnostics.push(DiagnosticNotice {
                    severity: DiagnosticSeverity::Warning,
                    code: ErrorCode::EIo,
                    message: format!("walk error: {err}"),
                    path: None,
                });
                truncated = true;
                continue;
            }
        };

        let Ok(rel_path) = dent.path().strip_prefix(root_abs) else {
            continue;
        };
        if rel_path.as_os_str().is_empty() {
            continue;
        }
        let Some(rel_str) = rel_path.to_str() else {
            diagnostics.push(DiagnosticNotice {
                severity: DiagnosticSeverity::Warning,
                code: ErrorCode::EInvalidRequest,
                message: "skipped non-UTF-8 path during directory traversal".to_string(),
                path: None,
            });
            truncated = true;
            continue;
        };

        let Some(ft) = dent.file_type() else {
            continue;
        };
        if ft.is_symlink() {
            continue;
        }
        if policy.check_read(rel_str).is_err() {
            continue;
        }

        let (kind, size_bytes) = if ft.is_dir() {
            (EntryKind::Dir, 0)
        } else if ft.is_file() {
            let sz = dent.metadata().map(|m| m.len()).unwrap_or(0);
            (EntryKind::File, sz)
        } else {
            // Skip FIFOs, sockets, device nodes
            continue;
        };

        entries.push(ListEntry {
            path: rel_str.to_string(),
            kind,
            size_bytes,
        });
    }

    entries.sort_by(|a, b| a.path.cmp(&b.path));

    let max_entries = params.max_entries.unwrap_or(10_000);
    if entries.len() > max_entries {
        entries.truncate(max_entries);
        truncated = true;
    }

    // Enforce output byte budget
    let mut byte_budget = policy.limits.max_output_bytes_per_request;
    let mut keep_count = 0usize;
    for e in &entries {
        let approx = e.path.len() + 48;
        if approx > byte_budget && keep_count > 0 {
            truncated = true;
            break;
        }
        byte_budget = byte_budget.saturating_sub(approx);
        keep_count += 1;
    }
    if keep_count < entries.len() {
        entries.truncate(keep_count);
    }

    Ok(ListOutput {
        entries,
        diagnostics,
        truncated,
    })
}

pub fn exec_search(
    fs: &WorkspaceFs,
    policy: &EffectivePolicy,
    params: &SearchParams,
    cancel: &CancelToken,
) -> Result<SearchOutput, RuntimeError> {
    if params.query.is_empty() {
        return Err(RuntimeError::InvalidRequest(
            "search query cannot be empty".to_string(),
        ));
    }

    let start_rel = params.path.as_deref().unwrap_or(".");
    if start_rel != "." {
        validate_relative_path(start_rel)?;
    }
    policy.check_read(start_rel)?;

    let case_sensitive = params.case_sensitive.unwrap_or(true);
    let pattern = if params.regex.unwrap_or(false) {
        params.query.clone()
    } else {
        regex::escape(&params.query)
    };

    let re = RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .size_limit(10 * 1024 * 1024)
        .dfa_size_limit(10 * 1024 * 1024)
        .build()
        .map_err(|e| RuntimeError::InvalidRequest(format!("invalid search pattern: {e}")))?;

    let max_matches = params
        .max_matches
        .unwrap_or(policy.limits.max_batch_records)
        .min(10_000);

    // Collect candidate file paths deterministically.
    let list_params = ListParams {
        path: params.path.clone(),
        recursive: Some(true),
        max_entries: Some(50_000),
        include_hidden: Some(false),
        respect_ignore: Some(true),
    };

    // If start_rel is a single regular file, search just that file; otherwise walk directory.
    let mut candidate_files: Vec<String> = Vec::new();
    let mut diagnostics = Vec::new();
    let mut truncated = false;

    if start_rel != "." && fs.open_file_read(start_rel).is_ok() {
        candidate_files.push(start_rel.to_string());
    } else {
        let listed = exec_list(fs, policy, &list_params, cancel)?;
        diagnostics.extend(listed.diagnostics);
        if listed.truncated {
            truncated = true;
        }
        for e in listed.entries {
            if e.kind == EntryKind::File {
                candidate_files.push(e.path);
            }
        }
    }

    let mut matches = Vec::new();
    let mut output_bytes = 0usize;
    let max_output_bytes = policy.limits.max_output_bytes_per_request;

    'outer: for rel_path in candidate_files {
        if cancel.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        if matches.len() >= max_matches {
            truncated = true;
            break;
        }

        let bytes = match fs.read_file_bytes(&rel_path, policy.limits.max_edit_file_bytes) {
            Ok((b, _)) => b,
            Err(RuntimeError::ResourceLimit(msg)) => {
                diagnostics.push(DiagnosticNotice {
                    severity: DiagnosticSeverity::Warning,
                    code: ErrorCode::EResourceLimit,
                    message: format!("skipped oversized file '{rel_path}': {msg}"),
                    path: Some(rel_path),
                });
                continue;
            }
            Err(_) => continue,
        };

        let Ok(analyzed) = analyze_text(&bytes, false) else {
            // Binary / non-UTF-8 file: skip silently.
            continue;
        };

        for line in &analyzed.lines {
            if cancel.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            for m in re.find_iter(&line.text) {
                let start_byte = line.start_byte + (m.start() as u64);
                let end_byte = line.start_byte + (m.end() as u64);
                let approx_bytes = rel_path.len() + line.text.len() + 64;
                if output_bytes + approx_bytes > max_output_bytes && !matches.is_empty() {
                    truncated = true;
                    break 'outer;
                }
                output_bytes += approx_bytes;

                matches.push(SearchMatch {
                    path: rel_path.clone(),
                    line_number: line.line_number,
                    line_tag: line.line_tag.clone(),
                    start_byte,
                    end_byte,
                    line_text: line.text.clone(),
                });

                if matches.len() >= max_matches {
                    truncated = true;
                    break 'outer;
                }
            }
        }
    }

    Ok(SearchOutput {
        matches,
        diagnostics,
        truncated,
    })
}

pub fn exec_read(
    fs: &WorkspaceFs,
    policy: &EffectivePolicy,
    params: &ReadParams,
) -> Result<ReadOutput, RuntimeError> {
    validate_relative_path(&params.path)?;
    if params.start_line == Some(0) {
        return Err(RuntimeError::InvalidRequest(
            "startLine is 1-based and must be >= 1".to_string(),
        ));
    }
    policy.check_read(&params.path)?;

    let (bytes, _st) = fs.read_file_bytes(&params.path, policy.limits.max_edit_file_bytes)?;
    let file_revision = blake3_hex(&bytes);
    let total_bytes = bytes.len() as u64;
    let analyzed = analyze_text(&bytes, false)?;
    let total_lines = analyzed.lines.len() as u64;

    let start_idx =
        usize::try_from(params.start_line.unwrap_or(1).saturating_sub(1)).unwrap_or(usize::MAX);
    let max_lines = params
        .line_count
        .map_or(usize::MAX, |c| usize::try_from(c).unwrap_or(usize::MAX));

    let mut out_lines = Vec::new();
    let mut output_bytes = 0usize;
    let max_output_bytes = policy.limits.max_output_bytes_per_request;
    let mut truncated = false;

    if start_idx < analyzed.lines.len() {
        for line in analyzed.lines[start_idx..].iter().take(max_lines) {
            let approx = line.text.len() + 64;
            if output_bytes + approx > max_output_bytes && !out_lines.is_empty() {
                truncated = true;
                break;
            }
            output_bytes += approx;
            out_lines.push(line.clone());
        }
    }

    Ok(ReadOutput {
        result: ReadResult {
            path: params.path.clone(),
            file_revision,
            total_lines,
            total_bytes,
            eol: analyzed.eol,
            has_bom: analyzed.has_bom,
            has_trailing_newline: analyzed.has_trailing_newline,
        },
        lines: out_lines,
        truncated,
    })
}

pub fn exec_patch(
    fs: &WorkspaceFs,
    policy: &EffectivePolicy,
    journal: &mut WorkspaceJournal,
    params: &PatchParams,
    operation_id: Option<&str>,
    payload_hash: &str,
) -> Result<PatchResult, RuntimeError> {
    validate_relative_path(&params.path)?;
    policy.check_write(&params.path)?;

    if journal.has_unresolved_conflict() {
        return Err(RuntimeError::RecoveryConflict(
            "workspace has an unresolved crash-recovery conflict in the journal".to_string(),
        ));
    }

    let dry_run = params.dry_run.unwrap_or(false);
    if !dry_run
        && let Some(op_id) = operation_id
        && let Some(stored) = journal.check_idempotency(op_id, payload_hash)?
    {
        return Ok(stored.to_patch_result());
    }

    let target_meta = fs.validate_write_target(&params.path)?;
    let (original_bytes, _) =
        fs.read_file_bytes(&params.path, policy.limits.max_edit_file_bytes)?;
    let computed = compute_patch(&original_bytes, &params.expected_revision, &params.edits)?;

    if computed.new_bytes.len() > policy.limits.max_edit_file_bytes {
        return Err(RuntimeError::ResourceLimit(format!(
            "patched file size ({} bytes) exceeds maxEditFileBytes ({})",
            computed.new_bytes.len(),
            policy.limits.max_edit_file_bytes
        )));
    }

    if dry_run {
        return Ok(PatchResult {
            path: params.path.clone(),
            dry_run: true,
            before_revision: computed.before_revision,
            after_revision: computed.after_revision,
            edits_applied: computed.edits_applied,
            bytes_delta: computed.bytes_delta,
            transaction_id: None,
            operation_id: operation_id.map(str::to_string),
            diff_preview: Some(computed.diff_preview),
        });
    }

    // Check state/ledger quota before touching disk or journal.
    journal.check_state_quota((original_bytes.len() as u64).saturating_add(4096))?;

    let tx_id = journal.next_tx_id();
    let preimage_file = format!("{tx_id}.pre");
    let temp_name = format!(".ms_tmp_{tx_id}");
    let epoch = journal.current_epoch();

    journal.write_preimage(&preimage_file, &original_bytes)?;
    journal.append_entry(JournalEntry::Prepared {
        tx_id: tx_id.clone(),
        operation_id: operation_id.map(str::to_string),
        payload_hash: Some(payload_hash.to_string()),
        kind: TxKind::Patch,
        path: params.path.clone(),
        target_dev: target_meta.dev,
        target_ino: target_meta.ino,
        target_mode: target_meta.mode,
        temp_name: temp_name.clone(),
        before_revision: computed.before_revision.clone(),
        after_revision: computed.after_revision.clone(),
        preimage_file,
        target_tx_id: None,
        epoch,
        created_at_ms: now_ms(),
        bytes_delta: computed.bytes_delta,
        edits_applied: computed.edits_applied,
    })?;

    if let Err(e) =
        fs.atomic_stage_and_replace(&params.path, &target_meta, &computed.new_bytes, &temp_name)
    {
        let _ = journal.append_entry(JournalEntry::Aborted {
            tx_id,
            reason: e.to_string(),
            aborted_at_ms: now_ms(),
        });
        return Err(e);
    }

    journal.append_entry(JournalEntry::Committed {
        tx_id: tx_id.clone(),
        committed_at_ms: now_ms(),
    })?;

    Ok(PatchResult {
        path: params.path.clone(),
        dry_run: false,
        before_revision: computed.before_revision,
        after_revision: computed.after_revision,
        edits_applied: computed.edits_applied,
        bytes_delta: computed.bytes_delta,
        transaction_id: Some(tx_id),
        operation_id: operation_id.map(str::to_string),
        diff_preview: None,
    })
}

pub fn exec_tx_list(journal: &WorkspaceJournal, params: &TxListParams) -> Vec<TxRecord> {
    journal.list_transactions(params)
}

pub fn exec_tx_undo(
    fs: &WorkspaceFs,
    policy: &EffectivePolicy,
    journal: &mut WorkspaceJournal,
    params: &TxUndoParams,
    operation_id: Option<&str>,
    payload_hash: &str,
) -> Result<TxUndoResult, RuntimeError> {
    if !policy.allow_write {
        return Err(RuntimeError::policy_denied_with_hint(
            "tx.undo denied: session/host is read-only",
            "Open a write-enabled session if the host allows writes.",
        ));
    }

    if journal.has_unresolved_conflict() {
        return Err(RuntimeError::RecoveryConflict(
            "workspace has an unresolved crash-recovery conflict in the journal".to_string(),
        ));
    }

    if let Some(op_id) = operation_id
        && let Some(stored) = journal.check_idempotency(op_id, payload_hash)?
    {
        return Ok(stored.to_undo_result());
    }

    let latest = journal
        .latest_undoable()
        .cloned()
        .ok_or_else(|| RuntimeError::UndoConflict("no undoable transaction in workspace".into()))?;

    if let Some(req_tx_id) = &params.transaction_id
        && req_tx_id != &latest.tx_id
    {
        return Err(RuntimeError::UndoConflict(format!(
            "transaction '{req_tx_id}' is not the latest un-undone transaction ('{}')",
            latest.tx_id
        )));
    }

    policy.check_write(&latest.path)?;

    let target_meta = fs.validate_write_target(&latest.path)?;
    let (current_bytes, _) = fs.read_file_bytes(&latest.path, policy.limits.max_edit_file_bytes)?;
    let current_rev = blake3_hex(&current_bytes);

    if current_rev != latest.after_revision {
        return Err(RuntimeError::UndoConflict(format!(
            "cannot undo '{}': current file revision ({current_rev}) does not match postimage ({})",
            latest.tx_id, latest.after_revision
        )));
    }

    let preimage_bytes = journal.read_preimage(&latest.preimage_file, &latest.before_revision)?;

    journal.check_state_quota((current_bytes.len() as u64).saturating_add(4096))?;

    let undo_tx_id = journal.next_tx_id();
    let undo_preimage_file = format!("{undo_tx_id}.pre");
    let temp_name = format!(".ms_tmp_{undo_tx_id}");
    let epoch = journal.current_epoch();
    let bytes_delta = (preimage_bytes.len() as i64) - (current_bytes.len() as i64);

    journal.write_preimage(&undo_preimage_file, &current_bytes)?;
    journal.append_entry(JournalEntry::Prepared {
        tx_id: undo_tx_id.clone(),
        operation_id: operation_id.map(str::to_string),
        payload_hash: Some(payload_hash.to_string()),
        kind: TxKind::Undo,
        path: latest.path.clone(),
        target_dev: target_meta.dev,
        target_ino: target_meta.ino,
        target_mode: target_meta.mode,
        temp_name: temp_name.clone(),
        before_revision: current_rev.clone(),
        after_revision: latest.before_revision.clone(),
        preimage_file: undo_preimage_file,
        target_tx_id: Some(latest.tx_id.clone()),
        epoch,
        created_at_ms: now_ms(),
        bytes_delta,
        edits_applied: 1,
    })?;

    if let Err(e) =
        fs.atomic_stage_and_replace(&latest.path, &target_meta, &preimage_bytes, &temp_name)
    {
        let _ = journal.append_entry(JournalEntry::Aborted {
            tx_id: undo_tx_id,
            reason: e.to_string(),
            aborted_at_ms: now_ms(),
        });
        return Err(e);
    }

    journal.append_entry(JournalEntry::Committed {
        tx_id: undo_tx_id.clone(),
        committed_at_ms: now_ms(),
    })?;

    journal.append_entry(JournalEntry::Undone {
        tx_id: latest.tx_id.clone(),
        undone_by_tx_id: undo_tx_id.clone(),
        undone_at_ms: now_ms(),
    })?;

    Ok(TxUndoResult {
        undo_transaction_id: undo_tx_id,
        undone_transaction_id: latest.tx_id,
        path: latest.path,
        before_revision: current_rev,
        restored_revision: latest.before_revision,
        operation_id: operation_id.map(str::to_string),
    })
}

pub fn exec_schema(params: &SchemaParams) -> Result<Vec<OperationSchema>, RuntimeError> {
    let all = builtin_operation_schemas();
    if let Some(name) = &params.operation {
        let filtered: Vec<OperationSchema> = all.into_iter().filter(|s| s.name == *name).collect();
        if filtered.is_empty() {
            return Err(RuntimeError::UnknownCommand(format!(
                "unknown operation '{name}'"
            )));
        }
        Ok(filtered)
    } else {
        Ok(all)
    }
}

/// Computes `state_dir` relative path if it is inside `workspace_root` (so policy can deny it).
pub fn compute_state_rel_prefix(workspace_root: &Path, state_dir: &Path) -> Option<String> {
    let ws_canon = std::fs::canonicalize(workspace_root).ok()?;
    let st_canon = std::fs::canonicalize(state_dir).ok()?;
    let rel = st_canon.strip_prefix(&ws_canon).ok()?;
    let s = rel.to_str()?;
    Some(s.trim_matches('/').to_string())
}
