use ms_protocol::{EolKind, ReadLine, TextEdit, validate_patch_edits};

use crate::error::RuntimeError;

/// Computes the full 64-character lowercase hex BLAKE3 digest of `bytes`.
#[must_use]
pub fn blake3_hex(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

/// Computes a short 4-hex-char line tag for UI/diagnostic anchoring.
/// Never used as the sole write precondition.
#[must_use]
pub fn short_line_tag(line_bytes: &[u8]) -> String {
    let hash = blake3::hash(line_bytes);
    let b = hash.as_bytes();
    format!("{:02x}{:02x}", b[0], b[1])
}

/// Parsed structure of a UTF-8 text file.
#[derive(Debug, Clone)]
pub struct AnalyzedText {
    pub has_bom: bool,
    pub eol: EolKind,
    pub has_trailing_newline: bool,
    pub lines: Vec<ReadLine>,
}

/// Validates UTF-8, detects BOM/EOL, and builds 1-based line metadata with exact byte offsets.
pub fn analyze_text(bytes: &[u8], strict_eol: bool) -> Result<AnalyzedText, RuntimeError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|e| RuntimeError::InvalidRequest(format!("file is not valid UTF-8: {e}")))?;

    let has_bom = bytes.starts_with(b"\xEF\xBB\xBF");
    let bom_len = if has_bom { 3 } else { 0 };
    let content = &bytes[bom_len..];

    let mut has_crlf = false;
    let mut has_lf = false;
    let mut has_lone_cr = false;

    let mut i = 0;
    while i < content.len() {
        match content[i] {
            b'\r' => {
                if i + 1 < content.len() && content[i + 1] == b'\n' {
                    has_crlf = true;
                    i += 2;
                    continue;
                }
                has_lone_cr = true;
            }
            b'\n' => {
                has_lf = true;
            }
            _ => {}
        }
        i += 1;
    }

    if strict_eol && has_lone_cr {
        return Err(RuntimeError::InvalidRequest(
            "unsupported bare CR ('\\r') line endings".to_string(),
        ));
    }
    if strict_eol && has_crlf && has_lf {
        return Err(RuntimeError::InvalidRequest(
            "mixed LF and CRLF line endings are not supported".to_string(),
        ));
    }

    let eol = if has_crlf && !has_lf {
        EolKind::Crlf
    } else if has_lf && !has_crlf {
        EolKind::Lf
    } else if has_crlf && has_lf {
        // Only reachable when strict_eol == false (e.g. read)
        EolKind::Lf
    } else {
        EolKind::None
    };

    let has_trailing_newline = !content.is_empty() && content.ends_with(b"\n");

    let mut lines = Vec::new();
    if !content.is_empty() {
        let mut line_start = bom_len;
        let mut line_num: u64 = 1;
        let mut pos = bom_len;

        while pos < bytes.len() {
            if bytes[pos] == b'\n' {
                let line_end = if pos > line_start && bytes[pos - 1] == b'\r' {
                    pos - 1
                } else {
                    pos
                };
                let slice = &bytes[line_start..line_end];
                lines.push(ReadLine {
                    line_number: line_num,
                    line_tag: short_line_tag(slice),
                    start_byte: line_start as u64,
                    end_byte: line_end as u64,
                    text: text[line_start..line_end].to_string(),
                });
                line_num += 1;
                pos += 1;
                line_start = pos;
            } else {
                pos += 1;
            }
        }

        // Trailing line without final newline
        if line_start < bytes.len() {
            let slice = &bytes[line_start..];
            lines.push(ReadLine {
                line_number: line_num,
                line_tag: short_line_tag(slice),
                start_byte: line_start as u64,
                end_byte: bytes.len() as u64,
                text: text[line_start..].to_string(),
            });
        }
    }

    Ok(AnalyzedText {
        has_bom,
        eol,
        has_trailing_newline,
        lines,
    })
}

/// Output of validating and computing a patch in memory.
#[derive(Debug, Clone)]
pub struct ComputedPatch {
    pub before_revision: String,
    pub after_revision: String,
    pub new_bytes: Vec<u8>,
    pub bytes_delta: i64,
    pub edits_applied: usize,
    pub diff_preview: String,
}

/// Validates `expected_revision` and `edits` against `original_bytes`, then applies
/// edits in descending byte-offset order while preserving BOM, EOL, and trailing newline.
pub fn compute_patch(
    original_bytes: &[u8],
    expected_revision: &str,
    edits: &[TextEdit],
) -> Result<ComputedPatch, RuntimeError> {
    let before_revision = blake3_hex(original_bytes);
    if before_revision != expected_revision {
        return Err(RuntimeError::conflict(
            format!(
                "stale expectedRevision: expected {expected_revision}, actual {before_revision}"
            ),
            "Re-read the file to obtain the current fileRevision and byte offsets.",
        ));
    }

    validate_patch_edits(edits)?;
    let analyzed = analyze_text(original_bytes, true)?;
    let text = std::str::from_utf8(original_bytes)
        .map_err(|e| RuntimeError::InvalidRequest(format!("file is not valid UTF-8: {e}")))?;

    let len = original_bytes.len();
    for (idx, edit) in edits.iter().enumerate() {
        let start = usize::try_from(edit.start_byte)
            .map_err(|_| RuntimeError::InvalidRequest("startByte out of range".to_string()))?;
        let end = usize::try_from(edit.end_byte)
            .map_err(|_| RuntimeError::InvalidRequest("endByte out of range".to_string()))?;

        if end > len {
            return Err(RuntimeError::InvalidRequest(format!(
                "edit[{idx}] endByte ({end}) exceeds file length ({len})"
            )));
        }

        check_offset_boundary(
            original_bytes,
            text,
            analyzed.has_bom,
            start,
            idx,
            "startByte",
        )?;
        check_offset_boundary(original_bytes, text, analyzed.has_bom, end, idx, "endByte")?;

        if edit.replacement.contains('\r') {
            return Err(RuntimeError::InvalidRequest(format!(
                "edit[{idx}] replacement must use LF ('\\n') on the wire, not CR ('\\r')"
            )));
        }

        if let Some(exp_text) = &edit.expected_text {
            let actual_lf = normalize_crlf_to_lf(&text[start..end]);
            if actual_lf != *exp_text {
                return Err(RuntimeError::conflict(
                    format!("edit[{idx}] expectedText mismatch at [{start}, {end})"),
                    "Re-read the file to verify current content before patching.",
                ));
            }
        }

        if let Some(exp_tag) = &edit.expected_tag {
            let actual_tag = find_line_tag_at(&analyzed, start as u64);
            if actual_tag != *exp_tag {
                return Err(RuntimeError::conflict(
                    format!(
                        "edit[{idx}] expectedTag mismatch at offset {start}: expected '{exp_tag}', actual '{actual_tag}'"
                    ),
                    "Re-read the file to verify current line tags.",
                ));
            }
        }
    }

    // Apply in descending start_byte order so earlier offsets remain untouched.
    let mut sorted: Vec<&TextEdit> = edits.iter().collect();
    sorted.sort_by_key(|a| std::cmp::Reverse(a.start_byte));

    let mut new_bytes = original_bytes.to_vec();
    let mut preview_parts = Vec::with_capacity(sorted.len());

    for edit in &sorted {
        let start = edit.start_byte as usize;
        let end = edit.end_byte as usize;
        let converted = convert_lf_to_eol(&edit.replacement, analyzed.eol);

        let old_preview = normalize_crlf_to_lf(&text[start..end]);
        preview_parts.push(format!(
            "@@ [{start}..{end}) @@\n-{old_preview}\n+{}",
            edit.replacement
        ));

        new_bytes.splice(start..end, converted.into_bytes());
    }
    preview_parts.reverse();

    // Verify result is still valid UTF-8 and has consistent EOL.
    analyze_text(&new_bytes, true)?;

    let after_revision = blake3_hex(&new_bytes);
    let bytes_delta = (new_bytes.len() as i64) - (original_bytes.len() as i64);

    Ok(ComputedPatch {
        before_revision,
        after_revision,
        new_bytes,
        bytes_delta,
        edits_applied: edits.len(),
        diff_preview: preview_parts.join("\n"),
    })
}

fn check_offset_boundary(
    bytes: &[u8],
    text: &str,
    has_bom: bool,
    offset: usize,
    edit_idx: usize,
    label: &str,
) -> Result<(), RuntimeError> {
    if has_bom && (offset == 1 || offset == 2) {
        return Err(RuntimeError::InvalidRequest(format!(
            "edit[{edit_idx}] {label} ({offset}) splits UTF-8 BOM"
        )));
    }
    if !text.is_char_boundary(offset) {
        return Err(RuntimeError::InvalidRequest(format!(
            "edit[{edit_idx}] {label} ({offset}) is not on a UTF-8 character boundary"
        )));
    }
    if offset > 0 && offset < bytes.len() && bytes[offset - 1] == b'\r' && bytes[offset] == b'\n' {
        return Err(RuntimeError::InvalidRequest(format!(
            "edit[{edit_idx}] {label} ({offset}) splits a CRLF sequence"
        )));
    }
    Ok(())
}

fn find_line_tag_at(analyzed: &AnalyzedText, offset: u64) -> String {
    for line in &analyzed.lines {
        if offset >= line.start_byte && offset <= line.end_byte {
            return line.line_tag.clone();
        }
    }
    analyzed
        .lines
        .last()
        .map_or_else(|| short_line_tag(b""), |l| l.line_tag.clone())
}

fn normalize_crlf_to_lf(s: &str) -> String {
    s.replace("\r\n", "\n")
}

fn convert_lf_to_eol(lf_text: &str, eol: EolKind) -> String {
    match eol {
        EolKind::Crlf => lf_text.replace('\n', "\r\n"),
        EolKind::Lf | EolKind::None => lf_text.to_string(),
    }
}
