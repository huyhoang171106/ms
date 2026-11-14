use crate::error::ProtocolError;
use crate::messages::{Request, RequestBody};
use crate::operations::{EditSpec, Operation, TextEdit};

/// Validates a workspace-relative UTF-8 path at the protocol boundary.
///
/// Rejects empty paths, NUL bytes, backslashes, leading `/`, `.` or `..` traversal
/// segments, and ASCII control characters. Filesystem-level symlink and `openat2`
/// checks are enforced by `ms-runtime`.
pub fn validate_relative_path(path: &str) -> Result<(), ProtocolError> {
    if path.is_empty() {
        return Err(ProtocolError::InvalidPath("path cannot be empty".into()));
    }
    if path.contains('\0') {
        return Err(ProtocolError::InvalidPath("path contains NUL byte".into()));
    }
    if path.starts_with('/') {
        return Err(ProtocolError::InvalidPath(
            "absolute paths are not allowed".into(),
        ));
    }
    if path.contains('\\') {
        return Err(ProtocolError::InvalidPath(
            "backslashes are not allowed in relative paths".into(),
        ));
    }
    if path.chars().any(|c| c.is_control()) {
        return Err(ProtocolError::InvalidPath(
            "path contains control characters".into(),
        ));
    }
    for segment in path.split('/') {
        if segment == ".." {
            return Err(ProtocolError::InvalidPath(
                "parent directory traversal ('..') is not allowed".into(),
            ));
        }
    }
    Ok(())
}

/// Validates a full BLAKE3 revision string (64 lowercase hex characters).
pub fn validate_revision_hex(rev: &str) -> Result<(), ProtocolError> {
    if rev.len() != 64 || !rev.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return Err(ProtocolError::InvalidRevision(
            "expected 64-character lowercase hex BLAKE3 digest".into(),
        ));
    }
    Ok(())
}

/// Validates `patch` edits for well-formed byte ranges and non-overlap.
pub fn validate_patch_edits(edits: &[TextEdit]) -> Result<(), ProtocolError> {
    if edits.is_empty() {
        return Err(ProtocolError::InvalidEdit(
            "edits list cannot be empty".into(),
        ));
    }

    let mut ranges: Vec<(u64, u64, usize)> = Vec::with_capacity(edits.len());
    for (idx, edit) in edits.iter().enumerate() {
        if edit.start_byte > edit.end_byte {
            return Err(ProtocolError::InvalidEdit(format!(
                "edit[{idx}] has startByte ({}) > endByte ({})",
                edit.start_byte, edit.end_byte
            )));
        }
        ranges.push((edit.start_byte, edit.end_byte, idx));
    }

    // Sort by (start_byte, end_byte) to detect overlaps or duplicate point inserts at the same offset.
    ranges.sort_unstable_by_key(|&(s, e, _)| (s, e));
    for win in ranges.windows(2) {
        let (s1, e1, i1) = win[0];
        let (s2, e2, i2) = win[1];
        if s1 == s2 && e1 == e2 {
            return Err(ProtocolError::InvalidEdit(format!(
                "edit[{i1}] and edit[{i2}] target identical range [{s1}, {e1})"
            )));
        }
        if s2 < e1 {
            return Err(ProtocolError::InvalidEdit(format!(
                "edit[{i1}] [{s1}, {e1}) overlaps edit[{i2}] [{s2}, {e2})"
            )));
        }
    }

    Ok(())
}

/// Validates a deserialized `Request` before dispatch.
pub fn validate_request(req: &Request) -> Result<(), ProtocolError> {
    if req.id.trim().is_empty() {
        return Err(ProtocolError::InvalidRequest(
            "request id cannot be empty".into(),
        ));
    }

    match &req.body {
        RequestBody::Initialize(_) => Ok(()),
        RequestBody::SessionOpen(params) => {
            if let Some(caps) = &params.capabilities {
                if let Some(paths) = &caps.read_subpaths {
                    for p in paths {
                        validate_relative_path(p)?;
                    }
                }
                if let Some(paths) = &caps.write_subpaths {
                    for p in paths {
                        validate_relative_path(p)?;
                    }
                }
            }
            Ok(())
        }
        RequestBody::SessionClose(params) => {
            if params.session_id.trim().is_empty() {
                return Err(ProtocolError::InvalidRequest(
                    "sessionId cannot be empty".into(),
                ));
            }
            Ok(())
        }
        RequestBody::Cancel(params) => {
            if params.request_id.trim().is_empty() {
                return Err(ProtocolError::InvalidRequest(
                    "requestId cannot be empty".into(),
                ));
            }
            Ok(())
        }
        RequestBody::Call(params) => {
            if params.session_id.trim().is_empty() {
                return Err(ProtocolError::InvalidRequest(
                    "sessionId cannot be empty".into(),
                ));
            }
            if let Some(op_id) = &params.operation_id
                && op_id.trim().is_empty()
            {
                return Err(ProtocolError::InvalidRequest(
                    "operationId cannot be empty when provided".into(),
                ));
            }
            validate_operation(&params.operation)
        }
    }
}

/// Validates an `Operation` payload.
pub fn validate_operation(op: &Operation) -> Result<(), ProtocolError> {
    match op {
        Operation::List(p) => {
            if let Some(path) = &p.path
                && path != "."
            {
                validate_relative_path(path)?;
            }
            Ok(())
        }
        Operation::Search(p) => {
            if p.query.is_empty() {
                return Err(ProtocolError::InvalidRequest(
                    "search query cannot be empty".into(),
                ));
            }
            if let Some(path) = &p.path
                && path != "."
            {
                validate_relative_path(path)?;
            }
            Ok(())
        }
        Operation::Read(p) => {
            validate_relative_path(&p.path)?;
            if p.start_line == Some(0) {
                return Err(ProtocolError::InvalidRequest(
                    "startLine is 1-based and must be >= 1".into(),
                ));
            }
            Ok(())
        }
        Operation::Patch(p) => {
            validate_relative_path(&p.path)?;
            validate_revision_hex(&p.expected_revision)?;
            validate_patch_edits(&p.edits)?;
            Ok(())
        }
        Operation::Edit(p) => {
            validate_relative_path(&p.path)?;
            if let Some(rev) = &p.expected_revision {
                validate_revision_hex(rev)?;
            }
            if p.edits.is_empty() {
                return Err(ProtocolError::InvalidEdit(
                    "edits list cannot be empty".into(),
                ));
            }
            let mut byte_edits = Vec::new();
            for (idx, spec) in p.edits.iter().enumerate() {
                match spec {
                    EditSpec::Line {
                        start_line,
                        end_line,
                        ..
                    } => {
                        if *start_line == 0 || *end_line < *start_line {
                            return Err(ProtocolError::InvalidEdit(format!(
                                "edit[{idx}] invalid line range [{start_line}, {end_line}] (1-based, startLine <= endLine)"
                            )));
                        }
                    }
                    EditSpec::Text { old_text, .. } => {
                        if old_text.is_empty() {
                            return Err(ProtocolError::InvalidEdit(format!(
                                "edit[{idx}] oldText cannot be empty"
                            )));
                        }
                    }
                    EditSpec::Byte(te) => {
                        byte_edits.push(te.clone());
                    }
                }
            }
            if !byte_edits.is_empty() {
                validate_patch_edits(&byte_edits)?;
            }
            Ok(())
        }
        Operation::WriteFile(p) => {
            validate_relative_path(&p.path)?;
            if let Some(rev) = &p.expected_revision {
                validate_revision_hex(rev)?;
            }
            Ok(())
        }
        Operation::DeleteFile(p) => {
            validate_relative_path(&p.path)?;
            if let Some(rev) = &p.expected_revision {
                validate_revision_hex(rev)?;
            }
            Ok(())
        }
        Operation::RenameFile(p) => {
            validate_relative_path(&p.from)?;
            validate_relative_path(&p.to)?;
            if p.from == p.to {
                return Err(ProtocolError::InvalidRequest(
                    "rename_file 'from' and 'to' paths must differ".into(),
                ));
            }
            if let Some(rev) = &p.expected_revision {
                validate_revision_hex(rev)?;
            }
            Ok(())
        }
        Operation::Outline(p) => {
            if let Some(path) = &p.path
                && path != "."
            {
                validate_relative_path(path)?;
            }
            Ok(())
        }
        Operation::ContextBundle(p) => {
            validate_relative_path(&p.path)?;
            if p.line == Some(0) {
                return Err(ProtocolError::InvalidRequest(
                    "line is 1-based and must be >= 1".into(),
                ));
            }
            Ok(())
        }
        Operation::TxList(_) | Operation::TxUndo(_) | Operation::Schema(_) => Ok(()),
    }
}
