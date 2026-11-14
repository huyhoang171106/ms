use std::path::Path;

use ignore::WalkBuilder;
use ms_protocol::{
    ContextBundleParams, ContextBundleResult, ContextTestMatch, DeleteFileParams, DeleteFileResult,
    DiagnosticSeverity, EditParams, EntryKind, ErrorCode, ListEntry, ListParams, OperationSchema,
    OutlineFile, OutlineParams, OutlineSymbol, PatchParams, PatchResult, ReadFormat, ReadParams,
    ReadResult, RenameFileParams, RenameFileResult, SchemaParams, SearchMatch, SearchParams,
    TxKind, TxListParams, TxRecord, TxUndoParams, TxUndoResult, WriteFileParams, WriteFileResult,
    builtin_operation_schemas, normalize_relative_path, validate_relative_path,
};
use regex::RegexBuilder;

use crate::CancelToken;
use crate::error::RuntimeError;
use crate::journal::{JournalEntry, WorkspaceJournal, now_ms};
use crate::policy::EffectivePolicy;
use crate::text::{
    analyze_text, blake3_hex, compute_patch, format_hashline, resolve_and_compute_edit,
    short_line_tag,
};
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
    let raw_start = params.path.as_deref().unwrap_or(".");
    let start_rel = if raw_start == "." {
        ".".to_string()
    } else {
        normalize_relative_path(raw_start)?
    };
    policy.check_read(&start_rel)?;
    // Verify start directory via openat2(BENEATH | NO_SYMLINKS).
    let _dir_fd = fs.open_dir(&start_rel)?;

    let root_abs = fs.root_path();
    let start_abs = if start_rel == "." {
        root_abs.to_path_buf()
    } else {
        root_abs.join(&start_rel)
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

    let raw_start = params.path.as_deref().unwrap_or(".");
    let start_rel = if raw_start == "." {
        ".".to_string()
    } else {
        normalize_relative_path(raw_start)?
    };
    policy.check_read(&start_rel)?;

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
    let context_lines = params.context_lines.unwrap_or(0).min(10);

    let mut candidate_files: Vec<String> = Vec::new();
    let mut diagnostics = Vec::new();
    let mut truncated = false;

    if start_rel != "." && fs.open_file_read(&start_rel).is_ok() {
        candidate_files.push(start_rel);
    } else {
        let _dir_fd = fs.open_dir(&start_rel)?;
        let root_abs = fs.root_path();
        let start_abs = if start_rel == "." {
            root_abs.to_path_buf()
        } else {
            root_abs.join(&start_rel)
        };

        let mut builder = WalkBuilder::new(&start_abs);
        builder
            .follow_links(false)
            .hidden(true)
            .git_ignore(true)
            .ignore(true)
            .parents(true);

        let root_clone = root_abs.to_path_buf();
        let policy_clone = policy.clone();
        builder.filter_entry(move |entry| {
            let Ok(rel) = entry.path().strip_prefix(&root_clone) else {
                return false;
            };
            let Some(rel_str) = rel.to_str() else {
                return false;
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

        for result in builder.build() {
            if cancel.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            let Ok(dent) = result else { continue };
            if !dent.file_type().is_some_and(|ft| ft.is_file()) {
                continue;
            }
            let Ok(rel_path) = dent.path().strip_prefix(root_abs) else {
                continue;
            };
            let Some(rel_str) = rel_path.to_str() else {
                continue;
            };
            if policy.check_read(rel_str).is_ok() {
                candidate_files.push(rel_str.to_string());
            }
        }
        candidate_files.sort();
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

        // Fast binary check & UTF-8 validation without per-line BLAKE3 hashing.
        if bytes.contains(&0) {
            continue;
        }
        let Ok(text) = std::str::from_utf8(&bytes) else {
            continue;
        };

        // Fast whole-file precheck before scanning lines.
        if !re.is_match(text) {
            continue;
        }

        let bom_len = if bytes.starts_with(b"\xEF\xBB\xBF") {
            3
        } else {
            0
        };
        let mut line_starts: Vec<(usize, usize)> = Vec::new();
        {
            let mut ls = bom_len;
            let mut pos = bom_len;
            while pos < bytes.len() {
                if bytes[pos] == b'\n' {
                    let le = if pos > ls && bytes[pos - 1] == b'\r' {
                        pos - 1
                    } else {
                        pos
                    };
                    line_starts.push((ls, le));
                    pos += 1;
                    ls = pos;
                } else {
                    pos += 1;
                }
            }
            if ls < bytes.len() {
                line_starts.push((ls, bytes.len()));
            }
        }

        let mut last_emitted_line: Option<usize> = None;

        for (line_idx, &(ls, le)) in line_starts.iter().enumerate() {
            if cancel.is_cancelled() {
                return Err(RuntimeError::Cancelled);
            }
            let line_text = &text[ls..le];
            let mut line_matched = false;
            for m in re.find_iter(line_text) {
                if !line_matched && context_lines > 0 {
                    let ctx_start = line_idx.saturating_sub(context_lines);
                    let first_new = last_emitted_line.map_or(ctx_start, |p| (p + 1).max(ctx_start));
                    for (c_idx, &(cls, cle)) in line_starts
                        .iter()
                        .enumerate()
                        .take(line_idx)
                        .skip(first_new)
                    {
                        let ctx_text = &text[cls..cle];
                        let approx_bytes = rel_path.len() + ctx_text.len() + 64;
                        if output_bytes + approx_bytes > max_output_bytes && !matches.is_empty() {
                            truncated = true;
                            break 'outer;
                        }
                        output_bytes += approx_bytes;
                        matches.push(SearchMatch {
                            path: rel_path.clone(),
                            line_number: (c_idx + 1) as u64,
                            line_tag: short_line_tag(&bytes[cls..cle]),
                            start_byte: cls as u64,
                            end_byte: cls as u64,
                            line_text: ctx_text.to_string(),
                        });
                    }
                }
                line_matched = true;

                let start_byte = (ls + m.start()) as u64;
                let end_byte = (ls + m.end()) as u64;
                let approx_bytes = rel_path.len() + line_text.len() + 64;
                if output_bytes + approx_bytes > max_output_bytes && !matches.is_empty() {
                    truncated = true;
                    break 'outer;
                }
                output_bytes += approx_bytes;

                matches.push(SearchMatch {
                    path: rel_path.clone(),
                    line_number: (line_idx + 1) as u64,
                    line_tag: short_line_tag(&bytes[ls..le]),
                    start_byte,
                    end_byte,
                    line_text: line_text.to_string(),
                });
                last_emitted_line = Some(line_idx);

                if matches.len() >= max_matches {
                    truncated = true;
                    break 'outer;
                }
            }

            if line_matched && context_lines > 0 {
                let ctx_end = (line_idx + 1 + context_lines).min(line_starts.len());
                for (c_idx, &(cls, cle)) in line_starts
                    .iter()
                    .enumerate()
                    .take(ctx_end)
                    .skip(line_idx + 1)
                {
                    let ctx_text = &text[cls..cle];
                    if re.is_match(ctx_text) {
                        break;
                    }
                    let approx_bytes = rel_path.len() + ctx_text.len() + 64;
                    if output_bytes + approx_bytes > max_output_bytes && !matches.is_empty() {
                        truncated = true;
                        break 'outer;
                    }
                    output_bytes += approx_bytes;
                    matches.push(SearchMatch {
                        path: rel_path.clone(),
                        line_number: (c_idx + 1) as u64,
                        line_tag: short_line_tag(&bytes[cls..cle]),
                        start_byte: cls as u64,
                        end_byte: cls as u64,
                        line_text: ctx_text.to_string(),
                    });
                    last_emitted_line = Some(c_idx);
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
    let is_hashline = params.format == Some(ReadFormat::Hashline);

    if start_idx < analyzed.lines.len() {
        for line in analyzed.lines[start_idx..].iter().take(max_lines) {
            let approx = if is_hashline {
                line.text.len() + 16
            } else {
                line.text.len() + 64
            };
            if output_bytes + approx > max_output_bytes && !out_lines.is_empty() {
                truncated = true;
                break;
            }
            output_bytes += approx;
            out_lines.push(line.clone());
        }
    }

    let (hashline, lines) = if is_hashline {
        let formatted = format_hashline(&file_revision, analyzed.eol, total_lines, &out_lines);
        (Some(formatted), Vec::new())
    } else {
        (None, out_lines)
    };

    Ok(ReadOutput {
        result: ReadResult {
            path: params.path.clone(),
            file_revision,
            total_lines,
            total_bytes,
            eol: analyzed.eol,
            has_bom: analyzed.has_bom,
            has_trailing_newline: analyzed.has_trailing_newline,
            hashline,
        },
        lines,
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
        dest_path: None,
        existed_before: true,
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

pub fn exec_edit(
    fs: &WorkspaceFs,
    policy: &EffectivePolicy,
    journal: &mut WorkspaceJournal,
    params: &EditParams,
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
    let computed = resolve_and_compute_edit(
        &original_bytes,
        params.expected_revision.as_deref(),
        &params.edits,
    )?;

    if computed.new_bytes.len() > policy.limits.max_edit_file_bytes {
        return Err(RuntimeError::ResourceLimit(format!(
            "edited file size ({} bytes) exceeds maxEditFileBytes ({})",
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
        dest_path: None,
        existed_before: true,
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

pub fn exec_write_file(
    fs: &WorkspaceFs,
    policy: &EffectivePolicy,
    journal: &mut WorkspaceJournal,
    params: &WriteFileParams,
    operation_id: Option<&str>,
    payload_hash: &str,
) -> Result<WriteFileResult, RuntimeError> {
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
        return Ok(stored.to_write_result());
    }

    let new_bytes = params.content.as_bytes();
    if new_bytes.len() > policy.limits.max_edit_file_bytes {
        return Err(RuntimeError::ResourceLimit(format!(
            "file size ({} bytes) exceeds maxEditFileBytes ({})",
            new_bytes.len(),
            policy.limits.max_edit_file_bytes
        )));
    }
    let after_revision = blake3_hex(new_bytes);

    let create_if_missing = params.create_if_missing.unwrap_or(true);
    let overwrite = params.overwrite.unwrap_or(false);

    match fs.validate_write_target(&params.path) {
        Ok(target_meta) => {
            // File already exists.
            let (original_bytes, _) =
                fs.read_file_bytes(&params.path, policy.limits.max_edit_file_bytes)?;
            let before_revision = blake3_hex(&original_bytes);

            if let Some(exp_rev) = &params.expected_revision {
                if *exp_rev != before_revision {
                    return Err(RuntimeError::conflict_with_details(
                        format!(
                            "stale expectedRevision: expected {exp_rev}, actual {before_revision}"
                        ),
                        "Re-read the file or pass current fileRevision.",
                        serde_json::json!({ "fileRevision": before_revision }),
                    ));
                }
            } else if !overwrite {
                return Err(RuntimeError::conflict_with_details(
                    format!(
                        "file '{}' already exists and overwrite is false",
                        params.path
                    ),
                    "Set overwrite=true or provide expectedRevision.",
                    serde_json::json!({ "fileRevision": before_revision }),
                ));
            }

            if dry_run {
                return Ok(WriteFileResult {
                    path: params.path.clone(),
                    dry_run: true,
                    created: false,
                    before_revision,
                    after_revision,
                    bytes_written: new_bytes.len() as u64,
                    transaction_id: None,
                    operation_id: operation_id.map(str::to_string),
                });
            }

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
                kind: TxKind::Write,
                path: params.path.clone(),
                dest_path: None,
                existed_before: true,
                target_dev: target_meta.dev,
                target_ino: target_meta.ino,
                target_mode: target_meta.mode,
                temp_name: temp_name.clone(),
                before_revision: before_revision.clone(),
                after_revision: after_revision.clone(),
                preimage_file,
                target_tx_id: None,
                epoch,
                created_at_ms: now_ms(),
                bytes_delta: (new_bytes.len() as i64) - (original_bytes.len() as i64),
                edits_applied: 1,
            })?;

            if let Err(e) =
                fs.atomic_stage_and_replace(&params.path, &target_meta, new_bytes, &temp_name)
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

            Ok(WriteFileResult {
                path: params.path.clone(),
                dry_run: false,
                created: false,
                before_revision,
                after_revision,
                bytes_written: new_bytes.len() as u64,
                transaction_id: Some(tx_id),
                operation_id: operation_id.map(str::to_string),
            })
        }
        Err(RuntimeError::NotFound(_)) => {
            if !create_if_missing {
                return Err(RuntimeError::NotFound(format!(
                    "file '{}' does not exist and createIfMissing is false",
                    params.path
                )));
            }
            if params.expected_revision.is_some() {
                return Err(RuntimeError::NotFound(format!(
                    "file '{}' does not exist for expectedRevision",
                    params.path
                )));
            }

            if dry_run {
                return Ok(WriteFileResult {
                    path: params.path.clone(),
                    dry_run: true,
                    created: true,
                    before_revision: String::new(),
                    after_revision,
                    bytes_written: new_bytes.len() as u64,
                    transaction_id: None,
                    operation_id: operation_id.map(str::to_string),
                });
            }

            journal.check_state_quota(4096)?;
            let tx_id = journal.next_tx_id();
            let temp_name = format!(".ms_tmp_{tx_id}");
            let epoch = journal.current_epoch();

            journal.append_entry(JournalEntry::Prepared {
                tx_id: tx_id.clone(),
                operation_id: operation_id.map(str::to_string),
                payload_hash: Some(payload_hash.to_string()),
                kind: TxKind::Write,
                path: params.path.clone(),
                dest_path: None,
                existed_before: false,
                target_dev: 0,
                target_ino: 0,
                target_mode: 0o644,
                temp_name: temp_name.clone(),
                before_revision: String::new(),
                after_revision: after_revision.clone(),
                preimage_file: String::new(),
                target_tx_id: None,
                epoch,
                created_at_ms: now_ms(),
                bytes_delta: new_bytes.len() as i64,
                edits_applied: 1,
            })?;

            if let Err(e) = fs.atomic_create_new(&params.path, new_bytes, &temp_name) {
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

            Ok(WriteFileResult {
                path: params.path.clone(),
                dry_run: false,
                created: true,
                before_revision: String::new(),
                after_revision,
                bytes_written: new_bytes.len() as u64,
                transaction_id: Some(tx_id),
                operation_id: operation_id.map(str::to_string),
            })
        }
        Err(e) => Err(e),
    }
}

pub fn exec_delete_file(
    fs: &WorkspaceFs,
    policy: &EffectivePolicy,
    journal: &mut WorkspaceJournal,
    params: &DeleteFileParams,
    operation_id: Option<&str>,
    payload_hash: &str,
) -> Result<DeleteFileResult, RuntimeError> {
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
        return Ok(stored.to_delete_result());
    }

    let target_meta = fs.validate_write_target(&params.path)?;
    let (original_bytes, _) =
        fs.read_file_bytes(&params.path, policy.limits.max_edit_file_bytes)?;
    let before_revision = blake3_hex(&original_bytes);

    if let Some(exp_rev) = &params.expected_revision
        && *exp_rev != before_revision
    {
        return Err(RuntimeError::conflict_with_details(
            format!("stale expectedRevision: expected {exp_rev}, actual {before_revision}"),
            "Verify current fileRevision before deleting.",
            serde_json::json!({ "fileRevision": before_revision }),
        ));
    }

    if dry_run {
        return Ok(DeleteFileResult {
            path: params.path.clone(),
            dry_run: true,
            before_revision,
            bytes_deleted: original_bytes.len() as u64,
            transaction_id: None,
            operation_id: operation_id.map(str::to_string),
        });
    }

    journal.check_state_quota((original_bytes.len() as u64).saturating_add(4096))?;
    let tx_id = journal.next_tx_id();
    let preimage_file = format!("{tx_id}.pre");
    let epoch = journal.current_epoch();

    journal.write_preimage(&preimage_file, &original_bytes)?;
    journal.append_entry(JournalEntry::Prepared {
        tx_id: tx_id.clone(),
        operation_id: operation_id.map(str::to_string),
        payload_hash: Some(payload_hash.to_string()),
        kind: TxKind::Delete,
        path: params.path.clone(),
        dest_path: None,
        existed_before: true,
        target_dev: target_meta.dev,
        target_ino: target_meta.ino,
        target_mode: target_meta.mode,
        temp_name: String::new(),
        before_revision: before_revision.clone(),
        after_revision: String::new(),
        preimage_file,
        target_tx_id: None,
        epoch,
        created_at_ms: now_ms(),
        bytes_delta: -(original_bytes.len() as i64),
        edits_applied: 1,
    })?;

    if let Err(e) = fs.atomic_delete(&params.path, &target_meta) {
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

    Ok(DeleteFileResult {
        path: params.path.clone(),
        dry_run: false,
        before_revision,
        bytes_deleted: original_bytes.len() as u64,
        transaction_id: Some(tx_id),
        operation_id: operation_id.map(str::to_string),
    })
}

pub fn exec_rename_file(
    fs: &WorkspaceFs,
    policy: &EffectivePolicy,
    journal: &mut WorkspaceJournal,
    params: &RenameFileParams,
    operation_id: Option<&str>,
    payload_hash: &str,
) -> Result<RenameFileResult, RuntimeError> {
    validate_relative_path(&params.from)?;
    validate_relative_path(&params.to)?;
    policy.check_write(&params.from)?;
    policy.check_write(&params.to)?;

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
        return Ok(stored.to_rename_result());
    }

    let target_meta = fs.validate_write_target(&params.from)?;
    let (original_bytes, _) =
        fs.read_file_bytes(&params.from, policy.limits.max_edit_file_bytes)?;
    let file_revision = blake3_hex(&original_bytes);

    if let Some(exp_rev) = &params.expected_revision
        && *exp_rev != file_revision
    {
        return Err(RuntimeError::conflict_with_details(
            format!("stale expectedRevision: expected {exp_rev}, actual {file_revision}"),
            "Verify current fileRevision before renaming.",
            serde_json::json!({ "fileRevision": file_revision }),
        ));
    }

    if dry_run {
        return Ok(RenameFileResult {
            from: params.from.clone(),
            to: params.to.clone(),
            dry_run: true,
            file_revision,
            transaction_id: None,
            operation_id: operation_id.map(str::to_string),
        });
    }

    journal.check_state_quota(4096)?;
    let tx_id = journal.next_tx_id();
    let epoch = journal.current_epoch();
    let overwrite = params.overwrite.unwrap_or(false);

    journal.append_entry(JournalEntry::Prepared {
        tx_id: tx_id.clone(),
        operation_id: operation_id.map(str::to_string),
        payload_hash: Some(payload_hash.to_string()),
        kind: TxKind::Rename,
        path: params.from.clone(),
        dest_path: Some(params.to.clone()),
        existed_before: true,
        target_dev: target_meta.dev,
        target_ino: target_meta.ino,
        target_mode: target_meta.mode,
        temp_name: String::new(),
        before_revision: file_revision.clone(),
        after_revision: file_revision.clone(),
        preimage_file: String::new(),
        target_tx_id: None,
        epoch,
        created_at_ms: now_ms(),
        bytes_delta: 0,
        edits_applied: 1,
    })?;

    if let Err(e) = fs.atomic_rename(&params.from, &params.to, &target_meta, overwrite) {
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

    Ok(RenameFileResult {
        from: params.from.clone(),
        to: params.to.clone(),
        dry_run: false,
        file_revision,
        transaction_id: Some(tx_id),
        operation_id: operation_id.map(str::to_string),
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
    if let Some(dest) = &latest.dest_path {
        policy.check_write(dest)?;
    }

    let undo_tx_id = journal.next_tx_id();
    let undo_preimage_file = format!("{undo_tx_id}.pre");
    let temp_name = format!(".ms_tmp_{undo_tx_id}");
    let epoch = journal.current_epoch();

    match latest.kind {
        TxKind::Patch => {
            let target_meta = fs.validate_write_target(&latest.path)?;
            let (current_bytes, _) =
                fs.read_file_bytes(&latest.path, policy.limits.max_edit_file_bytes)?;
            let current_rev = blake3_hex(&current_bytes);

            if current_rev != latest.after_revision {
                return Err(RuntimeError::UndoConflict(format!(
                    "cannot undo '{}': current file revision ({current_rev}) does not match postimage ({})",
                    latest.tx_id, latest.after_revision
                )));
            }

            let preimage_bytes =
                journal.read_preimage(&latest.preimage_file, &latest.before_revision)?;
            journal.check_state_quota((current_bytes.len() as u64).saturating_add(4096))?;
            let bytes_delta = (preimage_bytes.len() as i64) - (current_bytes.len() as i64);

            journal.write_preimage(&undo_preimage_file, &current_bytes)?;
            journal.append_entry(JournalEntry::Prepared {
                tx_id: undo_tx_id.clone(),
                operation_id: operation_id.map(str::to_string),
                payload_hash: Some(payload_hash.to_string()),
                kind: TxKind::Undo,
                path: latest.path.clone(),
                dest_path: None,
                existed_before: true,
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
        TxKind::Write => {
            let target_meta = fs.validate_write_target(&latest.path)?;
            let (current_bytes, _) =
                fs.read_file_bytes(&latest.path, policy.limits.max_edit_file_bytes)?;
            let current_rev = blake3_hex(&current_bytes);

            if current_rev != latest.after_revision {
                return Err(RuntimeError::UndoConflict(format!(
                    "cannot undo '{}': current file revision ({current_rev}) does not match postimage ({})",
                    latest.tx_id, latest.after_revision
                )));
            }

            if !latest.existed_before {
                // Undo file creation -> delete the file.
                journal.check_state_quota((current_bytes.len() as u64).saturating_add(4096))?;
                journal.write_preimage(&undo_preimage_file, &current_bytes)?;
                journal.append_entry(JournalEntry::Prepared {
                    tx_id: undo_tx_id.clone(),
                    operation_id: operation_id.map(str::to_string),
                    payload_hash: Some(payload_hash.to_string()),
                    kind: TxKind::Undo,
                    path: latest.path.clone(),
                    dest_path: None,
                    existed_before: false,
                    target_dev: target_meta.dev,
                    target_ino: target_meta.ino,
                    target_mode: target_meta.mode,
                    temp_name: String::new(),
                    before_revision: current_rev.clone(),
                    after_revision: String::new(),
                    preimage_file: undo_preimage_file,
                    target_tx_id: Some(latest.tx_id.clone()),
                    epoch,
                    created_at_ms: now_ms(),
                    bytes_delta: -(current_bytes.len() as i64),
                    edits_applied: 1,
                })?;

                if let Err(e) = fs.atomic_delete(&latest.path, &target_meta) {
                    let _ = journal.append_entry(JournalEntry::Aborted {
                        tx_id: undo_tx_id,
                        reason: e.to_string(),
                        aborted_at_ms: now_ms(),
                    });
                    return Err(e);
                }
            } else {
                // Undo file overwrite -> restore preimage.
                let preimage_bytes =
                    journal.read_preimage(&latest.preimage_file, &latest.before_revision)?;
                journal.check_state_quota((current_bytes.len() as u64).saturating_add(4096))?;
                let bytes_delta = (preimage_bytes.len() as i64) - (current_bytes.len() as i64);

                journal.write_preimage(&undo_preimage_file, &current_bytes)?;
                journal.append_entry(JournalEntry::Prepared {
                    tx_id: undo_tx_id.clone(),
                    operation_id: operation_id.map(str::to_string),
                    payload_hash: Some(payload_hash.to_string()),
                    kind: TxKind::Undo,
                    path: latest.path.clone(),
                    dest_path: None,
                    existed_before: true,
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

                if let Err(e) = fs.atomic_stage_and_replace(
                    &latest.path,
                    &target_meta,
                    &preimage_bytes,
                    &temp_name,
                ) {
                    let _ = journal.append_entry(JournalEntry::Aborted {
                        tx_id: undo_tx_id,
                        reason: e.to_string(),
                        aborted_at_ms: now_ms(),
                    });
                    return Err(e);
                }
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
        TxKind::Delete => {
            if fs.open_file_read(&latest.path).is_ok() {
                return Err(RuntimeError::UndoConflict(format!(
                    "cannot undo delete '{}': '{}' already exists again",
                    latest.tx_id, latest.path
                )));
            }
            let preimage_bytes =
                journal.read_preimage(&latest.preimage_file, &latest.before_revision)?;
            journal.check_state_quota(4096)?;
            journal.append_entry(JournalEntry::Prepared {
                tx_id: undo_tx_id.clone(),
                operation_id: operation_id.map(str::to_string),
                payload_hash: Some(payload_hash.to_string()),
                kind: TxKind::Undo,
                path: latest.path.clone(),
                dest_path: None,
                existed_before: false,
                target_dev: 0,
                target_ino: 0,
                target_mode: 0o644,
                temp_name: temp_name.clone(),
                before_revision: String::new(),
                after_revision: latest.before_revision.clone(),
                preimage_file: String::new(),
                target_tx_id: Some(latest.tx_id.clone()),
                epoch,
                created_at_ms: now_ms(),
                bytes_delta: preimage_bytes.len() as i64,
                edits_applied: 1,
            })?;

            if let Err(e) = fs.atomic_create_new(&latest.path, &preimage_bytes, &temp_name) {
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
                before_revision: String::new(),
                restored_revision: latest.before_revision,
                operation_id: operation_id.map(str::to_string),
            })
        }
        TxKind::Rename => {
            let dest = latest.dest_path.clone().ok_or_else(|| {
                RuntimeError::UndoConflict("rename transaction missing dest_path".to_string())
            })?;
            let target_meta = fs.validate_write_target(&dest)?;
            let (current_bytes, _) =
                fs.read_file_bytes(&dest, policy.limits.max_edit_file_bytes)?;
            let current_rev = blake3_hex(&current_bytes);
            if current_rev != latest.after_revision {
                return Err(RuntimeError::UndoConflict(format!(
                    "cannot undo rename '{}': destination revision mismatch",
                    latest.tx_id
                )));
            }
            journal.check_state_quota(4096)?;
            journal.append_entry(JournalEntry::Prepared {
                tx_id: undo_tx_id.clone(),
                operation_id: operation_id.map(str::to_string),
                payload_hash: Some(payload_hash.to_string()),
                kind: TxKind::Undo,
                path: dest.clone(),
                dest_path: Some(latest.path.clone()),
                existed_before: true,
                target_dev: target_meta.dev,
                target_ino: target_meta.ino,
                target_mode: target_meta.mode,
                temp_name: String::new(),
                before_revision: current_rev.clone(),
                after_revision: latest.before_revision.clone(),
                preimage_file: String::new(),
                target_tx_id: Some(latest.tx_id.clone()),
                epoch,
                created_at_ms: now_ms(),
                bytes_delta: 0,
                edits_applied: 1,
            })?;

            if let Err(e) = fs.atomic_rename(&dest, &latest.path, &target_meta, false) {
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
        TxKind::Undo => Err(RuntimeError::UndoConflict(
            "cannot undo an undo transaction directly".to_string(),
        )),
    }
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

/// Output of `outline`.
pub struct OutlineOutput {
    pub files: Vec<OutlineFile>,
    pub truncated: bool,
}

/// Fast multi-language symbol & file-tree extractor (`outline` / `repo_map`).
pub fn exec_outline(
    fs: &WorkspaceFs,
    policy: &EffectivePolicy,
    params: &OutlineParams,
    cancel: &CancelToken,
) -> Result<OutlineOutput, RuntimeError> {
    let list_params = ListParams {
        path: params.path.clone(),
        recursive: Some(true),
        max_entries: Some(10_000),
        include_hidden: Some(false),
        respect_ignore: Some(true),
    };
    let listed = exec_list(fs, policy, &list_params, cancel)?;
    let max_files = params.max_files.unwrap_or(200).min(1_000);
    let max_syms = params.max_symbols_per_file.unwrap_or(50).min(200);

    let mut files = Vec::new();
    let mut truncated = listed.truncated;

    for entry in listed.entries {
        if cancel.is_cancelled() {
            return Err(RuntimeError::Cancelled);
        }
        if entry.kind != EntryKind::File {
            continue;
        }
        if !is_supported_source_file(&entry.path) {
            continue;
        }
        if files.len() >= max_files {
            truncated = true;
            break;
        }
        let Ok((bytes, _)) = fs.read_file_bytes(&entry.path, policy.limits.max_edit_file_bytes)
        else {
            continue;
        };
        if bytes.contains(&0) {
            continue;
        }
        let Ok(text) = std::str::from_utf8(&bytes) else {
            continue;
        };
        let (lines_count, symbols) = extract_symbols(&entry.path, text, max_syms);
        files.push(OutlineFile {
            path: entry.path,
            lines: lines_count,
            symbols,
        });
    }

    Ok(OutlineOutput { files, truncated })
}

/// 1-shot compound context bundle (`context_bundle`).
pub fn exec_context_bundle(
    fs: &WorkspaceFs,
    policy: &EffectivePolicy,
    params: &ContextBundleParams,
    cancel: &CancelToken,
) -> Result<ContextBundleResult, RuntimeError> {
    validate_relative_path(&params.path)?;
    policy.check_read(&params.path)?;

    let (bytes, _) = fs.read_file_bytes(&params.path, policy.limits.max_edit_file_bytes)?;
    let file_revision = blake3_hex(&bytes);
    let analyzed = analyze_text(&bytes, false)?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|e| RuntimeError::InvalidRequest(format!("file is not valid UTF-8: {e}")))?;

    let (_, local_symbols) = extract_symbols(&params.path, text, 100);
    let imports = extract_imports(&params.path, text);

    let target_line = if let Some(l) = params.line {
        l.min(analyzed.lines.len().max(1) as u64)
    } else if let Some(sym) = &params.symbol {
        local_symbols
            .iter()
            .find(|s| s.signature.contains(sym.as_str()))
            .map(|s| s.line)
            .or_else(|| {
                analyzed
                    .lines
                    .iter()
                    .find(|l| l.text.contains(sym.as_str()))
                    .map(|l| l.line_number)
            })
            .unwrap_or(1)
    } else {
        1
    };

    let radius = usize::try_from(params.radius.unwrap_or(25).min(100)).unwrap_or(25);
    let total = analyzed.lines.len();
    let hashline_snippet = if total == 0 {
        format!("rev:{file_revision} eol:NONE lines:0-0/0")
    } else {
        let idx = usize::try_from(target_line.saturating_sub(1))
            .unwrap_or(0)
            .min(total - 1);
        let start = idx.saturating_sub(radius);
        let end = (idx + radius + 1).min(total);
        format_hashline(
            &file_revision,
            analyzed.eol,
            total as u64,
            &analyzed.lines[start..end],
        )
    };

    // Find related test files in workspace.
    let stem = Path::new(&params.path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let mut related_tests = Vec::new();
    if let Ok(listed) = exec_list(
        fs,
        policy,
        &ListParams {
            path: None,
            recursive: Some(true),
            max_entries: Some(5_000),
            include_hidden: Some(false),
            respect_ignore: Some(true),
        },
        cancel,
    ) {
        for entry in listed.entries {
            if entry.kind != EntryKind::File || entry.path == params.path {
                continue;
            }
            if !is_test_file(&entry.path) {
                continue;
            }
            let name_matches = !stem.is_empty() && entry.path.contains(stem);
            if let Ok((tb, _)) = fs.read_file_bytes(&entry.path, 256 * 1024)
                && let Ok(ttext) = std::str::from_utf8(&tb)
            {
                let content_matches = !stem.is_empty() && ttext.contains(stem);
                if name_matches || content_matches {
                    let (_, tsyms) = extract_symbols(&entry.path, ttext, 8);
                    let snippet = if tsyms.is_empty() {
                        ttext.lines().take(5).collect::<Vec<_>>().join("\n")
                    } else {
                        tsyms
                            .iter()
                            .map(|s| format!("{}: {}", s.line, s.signature))
                            .collect::<Vec<_>>()
                            .join("\n")
                    };
                    related_tests.push(ContextTestMatch {
                        path: entry.path,
                        snippet,
                    });
                    if related_tests.len() >= 5 {
                        break;
                    }
                }
            }
        }
    }

    Ok(ContextBundleResult {
        path: params.path.clone(),
        file_revision,
        target_line,
        hashline_snippet,
        imports,
        local_symbols,
        related_tests,
    })
}

fn is_supported_source_file(path: &str) -> bool {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    matches!(
        ext,
        "rs" | "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "py" | "go"
    )
}

fn is_test_file(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.contains("/tests/")
        || lower.starts_with("tests/")
        || lower.contains("_test.")
        || lower.contains(".test.")
        || lower.contains(".spec.")
        || lower.contains("/test_")
        || lower.starts_with("test_")
}

fn extract_imports(path: &str, text: &str) -> Vec<String> {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    let mut out = Vec::new();
    for line in text.lines().take(120) {
        let t = line.trim();
        let is_imp = match ext {
            "rs" => t.starts_with("use ") || t.starts_with("pub use ") || t.starts_with("mod "),
            "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => {
                t.starts_with("import ") || (t.starts_with("const ") && t.contains("require("))
            }
            "py" => t.starts_with("import ") || t.starts_with("from "),
            "go" => t.starts_with("import "),
            _ => false,
        };
        if is_imp {
            out.push(t.to_string());
            if out.len() >= 30 {
                break;
            }
        }
    }
    out
}

fn extract_symbols(path: &str, text: &str, max_syms: usize) -> (u64, Vec<OutlineSymbol>) {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    let mut syms = Vec::new();
    let mut line_count = 0u64;

    for (idx, line) in text.lines().enumerate() {
        line_count = (idx + 1) as u64;
        if syms.len() >= max_syms {
            continue;
        }
        let t = line.trim();
        if t.is_empty() || t.starts_with("//") || t.starts_with('#') {
            continue;
        }
        let kind: Option<&str> = match ext {
            "rs" => {
                let s = t
                    .strip_prefix("pub(crate) ")
                    .or_else(|| t.strip_prefix("pub(super) "))
                    .or_else(|| t.strip_prefix("pub "))
                    .unwrap_or(t);
                let s = s.strip_prefix("async ").unwrap_or(s);
                let s = s.strip_prefix("unsafe ").unwrap_or(s);
                if s.starts_with("fn ") {
                    Some("fn")
                } else if s.starts_with("struct ") {
                    Some("struct")
                } else if s.starts_with("enum ") {
                    Some("enum")
                } else if s.starts_with("trait ") {
                    Some("trait")
                } else if s.starts_with("impl ") || s.starts_with("impl<") {
                    Some("impl")
                } else if s.starts_with("mod ") {
                    Some("mod")
                } else {
                    None
                }
            }
            "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => {
                let s = t.strip_prefix("export ").unwrap_or(t);
                let s = s.strip_prefix("default ").unwrap_or(s);
                let s = s.strip_prefix("async ").unwrap_or(s);
                if s.starts_with("function ") {
                    Some("function")
                } else if s.starts_with("class ") {
                    Some("class")
                } else if s.starts_with("interface ") {
                    Some("interface")
                } else if s.starts_with("type ") {
                    Some("type")
                } else if t.starts_with("export ")
                    && (s.starts_with("const ") || s.starts_with("let "))
                {
                    Some("export")
                } else {
                    None
                }
            }
            "py" => {
                let s = t.strip_prefix("async ").unwrap_or(t);
                if s.starts_with("def ") {
                    Some("def")
                } else if s.starts_with("class ") {
                    Some("class")
                } else {
                    None
                }
            }
            "go" => {
                if t.starts_with("func ") {
                    Some("func")
                } else if t.starts_with("type ")
                    && (t.contains(" struct") || t.contains(" interface"))
                {
                    Some("type")
                } else {
                    None
                }
            }
            _ => None,
        };

        if let Some(k) = kind {
            let sig = t.split('{').next().unwrap_or(t).trim().to_string();
            syms.push(OutlineSymbol {
                line: line_count,
                kind: k.to_string(),
                signature: sig,
            });
        }
    }

    (line_count, syms)
}

/// Computes `state_dir` relative path if it is inside `workspace_root` (so policy can deny it).
pub fn compute_state_rel_prefix(workspace_root: &Path, state_dir: &Path) -> Option<String> {
    let ws_canon = std::fs::canonicalize(workspace_root).ok()?;
    let st_canon = std::fs::canonicalize(state_dir).ok()?;
    let rel = st_canon.strip_prefix(&ws_canon).ok()?;
    let s = rel.to_str()?;
    Some(s.trim_matches('/').to_string())
}
