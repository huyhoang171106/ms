use ms_protocol::{EditSpec, EolKind, ReadLine, TextEdit, validate_patch_edits};

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

/// Formats lines in compact `hashline` mode:
/// `rev:<blake3> eol:<LF|CRLF|NONE> lines:<start>-<end>/<total>\n<num>:<tag>| <text>`
#[must_use]
pub fn format_hashline(
    file_revision: &str,
    eol: EolKind,
    total_lines: u64,
    lines: &[ReadLine],
) -> String {
    let eol_str = match eol {
        EolKind::Lf => "LF",
        EolKind::Crlf => "CRLF",
        EolKind::None => "NONE",
    };
    let (start, end) = match (lines.first(), lines.last()) {
        (Some(f), Some(l)) => (f.line_number, l.line_number),
        _ => (0, 0),
    };
    let mut out = format!("rev:{file_revision} eol:{eol_str} lines:{start}-{end}/{total_lines}");
    for l in lines {
        out.push('\n');
        out.push_str(&format!("{}:{}| {}", l.line_number, l.line_tag, l.text));
    }
    out
}

/// Formats up to `2*radius + 1` lines (~15 lines when radius=7) around `target_line` (1-based)
/// for self-healing conflict diagnostics.
#[must_use]
pub fn format_hashline_region(
    analyzed: &AnalyzedText,
    file_revision: &str,
    target_line: u64,
    radius: usize,
) -> String {
    let total = analyzed.lines.len();
    if total == 0 {
        return format!("rev:{file_revision} eol:NONE lines:0-0/0");
    }
    let idx = usize::try_from(target_line.saturating_sub(1))
        .unwrap_or(0)
        .min(total - 1);
    let start = idx.saturating_sub(radius);
    let end = (idx + radius + 1).min(total);
    format_hashline(
        file_revision,
        analyzed.eol,
        total as u64,
        &analyzed.lines[start..end],
    )
}

fn self_healing_conflict(
    original_bytes: &[u8],
    target_line: u64,
    message: String,
    hint_prefix: &str,
) -> RuntimeError {
    let rev = blake3_hex(original_bytes);
    if let Ok(analyzed) = analyze_text(original_bytes, false) {
        let region = format_hashline_region(&analyzed, &rev, target_line, 7);
        let details = serde_json::json!({
            "fileRevision": rev,
            "targetLine": target_line,
            "region": region,
        });
        RuntimeError::conflict_with_details(message, format!("{hint_prefix}\n{region}"), details)
    } else {
        RuntimeError::conflict_with_details(
            message,
            hint_prefix.to_string(),
            serde_json::json!({ "fileRevision": rev }),
        )
    }
}

fn line_for_offset(analyzed: &AnalyzedText, offset: u64) -> u64 {
    for l in &analyzed.lines {
        if offset >= l.start_byte && offset <= l.end_byte {
            return l.line_number;
        }
    }
    analyzed.lines.last().map_or(1, |l| l.line_number)
}

/// Resolves multi-mode `EditSpec`s (`Line`, `Text`, `Byte`) into byte-range `TextEdit`s
/// and computes the atomic patch.
pub fn resolve_and_compute_edit(
    original_bytes: &[u8],
    expected_revision: Option<&str>,
    specs: &[EditSpec],
) -> Result<ComputedPatch, RuntimeError> {
    let before_revision = blake3_hex(original_bytes);
    let first_target_line = specs
        .first()
        .and_then(|s| match s {
            EditSpec::Line { start_line, .. } => Some(*start_line),
            _ => None,
        })
        .unwrap_or(1);

    if let Some(exp_rev) = expected_revision
        && before_revision != exp_rev
    {
        return Err(self_healing_conflict(
            original_bytes,
            first_target_line,
            format!("stale expectedRevision: expected {exp_rev}, actual {before_revision}"),
            "Use the current fileRevision and hashline region below:",
        ));
    }

    let analyzed = analyze_text(original_bytes, true)?;
    let text = std::str::from_utf8(original_bytes)
        .map_err(|e| RuntimeError::InvalidRequest(format!("file is not valid UTF-8: {e}")))?;
    let total_lines = analyzed.lines.len() as u64;

    let mut resolved: Vec<TextEdit> = Vec::with_capacity(specs.len());
    for (idx, spec) in specs.iter().enumerate() {
        match spec {
            EditSpec::Line {
                start_line,
                end_line,
                start_tag,
                end_tag,
                replacement,
            } => {
                if *start_line == 0 || *end_line < *start_line || *end_line > total_lines {
                    return Err(RuntimeError::InvalidRequest(format!(
                        "edit[{idx}] line range [{start_line}, {end_line}] out of bounds (1..={total_lines})"
                    )));
                }
                if replacement.contains('\r') {
                    return Err(RuntimeError::InvalidRequest(format!(
                        "edit[{idx}] replacement must use LF ('\\n'), not CR ('\\r')"
                    )));
                }
                let s_line = &analyzed.lines[(*start_line - 1) as usize];
                let e_line = &analyzed.lines[(*end_line - 1) as usize];

                if let Some(exp_s) = start_tag
                    && s_line.line_tag != *exp_s
                {
                    return Err(self_healing_conflict(
                        original_bytes,
                        *start_line,
                        format!(
                            "edit[{idx}] startTag mismatch at line {start_line}: expected '{exp_s}', actual '{}'",
                            s_line.line_tag
                        ),
                        "Line content changed; current region:",
                    ));
                }
                if let Some(exp_e) = end_tag
                    && e_line.line_tag != *exp_e
                {
                    return Err(self_healing_conflict(
                        original_bytes,
                        *end_line,
                        format!(
                            "edit[{idx}] endTag mismatch at line {end_line}: expected '{exp_e}', actual '{}'",
                            e_line.line_tag
                        ),
                        "Line content changed; current region:",
                    ));
                }

                resolved.push(TextEdit {
                    start_byte: s_line.start_byte,
                    end_byte: e_line.end_byte,
                    expected_text: None,
                    expected_tag: None,
                    replacement: replacement.clone(),
                });
            }
            EditSpec::Text { old_text, new_text } => {
                if old_text.is_empty() {
                    return Err(RuntimeError::InvalidRequest(format!(
                        "edit[{idx}] oldText cannot be empty"
                    )));
                }
                let norm_old = normalize_crlf_to_lf(old_text);
                let norm_new = normalize_crlf_to_lf(new_text);

                // Build LF-normalized view with offset mapping back to original_bytes.
                let (lf_text, lf_to_orig) = build_lf_map(text);
                let matches: Vec<usize> = lf_text
                    .match_indices(&norm_old)
                    .map(|(pos, _)| pos)
                    .collect();

                if matches.is_empty() {
                    return Err(self_healing_conflict(
                        original_bytes,
                        1,
                        format!("edit[{idx}] oldText not found in file"),
                        "oldText did not match; current file snippet:",
                    ));
                }
                if matches.len() > 1 {
                    let first_orig = lf_to_orig[matches[0]];
                    let first_line = line_for_offset(&analyzed, first_orig as u64);
                    return Err(self_healing_conflict(
                        original_bytes,
                        first_line,
                        format!(
                            "edit[{idx}] oldText matched {} times (must be unique)",
                            matches.len()
                        ),
                        "Provide more surrounding context or use line-range+tag edit:",
                    ));
                }

                let lf_start = matches[0];
                let lf_end = lf_start + norm_old.len();
                let orig_start = lf_to_orig[lf_start] as u64;
                let orig_end = lf_to_orig[lf_end] as u64;

                resolved.push(TextEdit {
                    start_byte: orig_start,
                    end_byte: orig_end,
                    expected_text: None,
                    expected_tag: None,
                    replacement: norm_new,
                });
            }
            EditSpec::Byte(te) => {
                resolved.push(te.clone());
            }
        }
    }

    compute_patch(original_bytes, &before_revision, &resolved)
}

/// Maps each byte offset in LF-normalized `lf_text` (including `lf_text.len()`)
/// to its corresponding byte offset in `orig_text`.
fn build_lf_map(orig_text: &str) -> (String, Vec<usize>) {
    let bytes = orig_text.as_bytes();
    let mut lf = String::with_capacity(orig_text.len());
    let mut map = Vec::with_capacity(orig_text.len() + 1);
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\r' && i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
            lf.push('\n');
            map.push(i);
            i += 2;
        } else {
            let ch_len = orig_text[i..].chars().next().map_or(1, char::len_utf8);
            let s = &orig_text[i..i + ch_len];
            lf.push_str(s);
            for offset in 0..ch_len {
                map.push(i + offset);
            }
            i += ch_len;
        }
    }
    map.push(bytes.len());
    (lf, map)
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
        let first_offset = edits.first().map_or(0, |e| e.start_byte);
        let target_line = analyze_text(original_bytes, false)
            .map(|a| line_for_offset(&a, first_offset))
            .unwrap_or(1);
        return Err(self_healing_conflict(
            original_bytes,
            target_line,
            format!(
                "stale expectedRevision: expected {expected_revision}, actual {before_revision}"
            ),
            "Use the current fileRevision and hashline region below:",
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
                let target_line = line_for_offset(&analyzed, edit.start_byte);
                return Err(self_healing_conflict(
                    original_bytes,
                    target_line,
                    format!("edit[{idx}] expectedText mismatch at [{start}, {end})"),
                    "Content changed; current region:",
                ));
            }
        }

        if let Some(exp_tag) = &edit.expected_tag {
            let actual_tag = find_line_tag_at(&analyzed, start as u64);
            if actual_tag != *exp_tag {
                let target_line = line_for_offset(&analyzed, edit.start_byte);
                return Err(self_healing_conflict(
                    original_bytes,
                    target_line,
                    format!(
                        "edit[{idx}] expectedTag mismatch at offset {start}: expected '{exp_tag}', actual '{actual_tag}'"
                    ),
                    "Line tag changed; current region:",
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
