use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use ms_runtime::text::{analyze_text, blake3_hex, format_hashline_region};
use ms_runtime::workspace_fs::WorkspaceFs;
use regex::{Regex, RegexBuilder};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

static LOG_SEQ: AtomicU64 = AtomicU64::new(1);
static ANSI_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\x1b\[[0-9;:?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]").unwrap()
});
static LOC_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?:-->\s*|at\s+[^\n]*?\(|File\s+")?([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)(?:[:\(]|",\s*line\s*)(\d+)"#,
    )
    .unwrap()
});
static NONZERO_FAIL_COUNT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b[1-9]\d*\s+(?:failed|errors?)\b").unwrap());

#[derive(Debug, Clone)]
pub struct ExecDistillResult {
    pub exit_code: i32,
    pub timed_out: bool,
    pub duration_ms: u64,
    pub log_id: String,
    pub raw_bytes: usize,
    pub raw_lines: usize,
    pub distilled: String,
}

pub fn log_dir() -> PathBuf {
    std::env::temp_dir().join("ms-logs")
}

fn next_log_id() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let seq = LOG_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("log-{ms}-{}-{seq}", std::process::id())
}

fn persist_raw_log(log_id: &str, cmd_display: &str, raw: &str) -> Result<PathBuf, std::io::Error> {
    let dir = log_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{log_id}.log"));
    let content = format!("# cmd: {cmd_display}\n{raw}");
    std::fs::write(&path, content)?;
    Ok(path)
}

/// Reads a persisted raw log by `log_id`, optionally filtering with `grep` and taking last `tail` lines.
pub fn read_log(log_id: &str, tail: Option<usize>, grep: Option<&str>) -> Result<String, String> {
    if log_id.is_empty()
        || !log_id
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'z' | b'A'..=b'Z' | b'-' | b'_'))
    {
        return Err(format!("invalid log_id '{log_id}'"));
    }
    let path = log_dir().join(format!("{log_id}.log"));
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("failed to read log '{log_id}': {e}"))?;

    let mut lines: Vec<(usize, &str)> = raw.lines().enumerate().map(|(i, l)| (i + 1, l)).collect();

    if let Some(pat) = grep
        && !pat.is_empty()
    {
        let re = RegexBuilder::new(pat)
            .case_insensitive(false)
            .build()
            .or_else(|_| Regex::new(&regex::escape(pat)))
            .map_err(|e| format!("invalid grep pattern: {e}"))?;
        lines.retain(|(_, l)| re.is_match(l));
    }

    let limit = tail.unwrap_or(200);
    let total = lines.len();
    let start = total.saturating_sub(limit);
    let slice = &lines[start..];

    let mut out = format!("log:{log_id} showing:{}/{} lines", slice.len(), total);
    for (num, line) in slice {
        out.push('\n');
        out.push_str(&format!("{num}: {line}"));
    }
    Ok(out)
}

/// Executes `command_args` in `workspace_root`, captures stdout+stderr, strips ANSI/CR noise,
/// persists raw output, and distills into a token-efficient summary (plus hashline snippets on failure).
pub async fn exec_and_distill(
    workspace_root: &Path,
    command_args: &[String],
    timeout_ms: u64,
) -> Result<ExecDistillResult, String> {
    if command_args.is_empty() {
        return Err("command cannot be empty".to_string());
    }

    let cmd_display = command_args.join(" ");
    let use_shell = command_args.len() == 1
        && (command_args[0].contains(' ')
            || command_args[0].contains('|')
            || command_args[0].contains('&')
            || command_args[0].contains(';')
            || command_args[0].contains('>')
            || command_args[0].contains('<'));

    let mut cmd = if use_shell {
        let mut c = Command::new("sh");
        c.arg("-c").arg(&command_args[0]);
        c
    } else {
        let mut c = Command::new(&command_args[0]);
        c.args(&command_args[1..]);
        c
    };

    cmd.current_dir(workspace_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    cmd.process_group(0);

    let started = Instant::now();
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn '{}': {e}", command_args[0]))?;
    let child_pid = child.id();

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();

    let stdout_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(ref mut s) = stdout_pipe {
            let _ = s.read_to_end(&mut buf).await;
        }
        buf
    });

    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        if let Some(ref mut s) = stderr_pipe {
            let _ = s.read_to_end(&mut buf).await;
        }
        buf
    });

    let mut timed_out = false;
    let exit_code =
        match tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait()).await {
            Ok(Ok(status)) => status.code().unwrap_or(1),
            Ok(Err(e)) => return Err(format!("wait failed: {e}")),
            Err(_) => {
                timed_out = true;
                #[cfg(unix)]
                if let Some(pid) = child_pid {
                    let _ = std::process::Command::new("kill")
                        .args(["-9", &format!("-{pid}")])
                        .output();
                }
                let _ = child.kill().await;
                let _ = child.wait().await;
                124
            }
        };

    let duration_ms = started.elapsed().as_millis() as u64;
    let drain_timeout = Duration::from_millis(if timed_out { 200 } else { 5_000 });
    let out_bytes = tokio::time::timeout(drain_timeout, stdout_task)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();
    let err_bytes = tokio::time::timeout(drain_timeout, stderr_task)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();

    let mut combined = String::from_utf8_lossy(&out_bytes).into_owned();
    if !err_bytes.is_empty() {
        if !combined.is_empty() && !combined.ends_with('\n') {
            combined.push('\n');
        }
        combined.push_str(&String::from_utf8_lossy(&err_bytes));
    }

    let raw_bytes = combined.len();
    let raw_lines = combined.lines().count();
    let log_id = next_log_id();
    let _ = persist_raw_log(&log_id, &cmd_display, &combined);

    let cleaned_lines = clean_and_collapse_lines(&combined);
    let kind = detect_command_kind(command_args, &cmd_display);
    let is_git_inspection = matches!(
        kind,
        CmdKind::GitStatus | CmdKind::GitDiff | CmdKind::GitLog
    );
    let failure_markers = !is_git_inspection && has_failure_markers(&cleaned_lines);
    let effective_passed = exit_code == 0 && !timed_out && !failure_markers;
    let body = if effective_passed && cleaned_lines.len() <= 15 && raw_bytes <= 800 {
        cleaned_lines
            .iter()
            .filter(|l| !l.trim().is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        distill_by_kind(kind, effective_passed, &cleaned_lines)
    };

    let mut header = if timed_out {
        format!(
            "[TIMED OUT after {duration_ms}ms | exit:{exit_code} | log:{log_id} | raw:{raw_lines}L/{raw_bytes}B]"
        )
    } else if effective_passed {
        format!("[OK | exit:0 | {duration_ms}ms | log:{log_id} | raw:{raw_lines}L/{raw_bytes}B]")
    } else {
        format!(
            "[FAILED | exit:{exit_code} | {duration_ms}ms | log:{log_id} | raw:{raw_lines}L/{raw_bytes}B]"
        )
    };

    if !body.is_empty() {
        header.push('\n');
        header.push_str(&body);
    }

    if !effective_passed {
        let snippets = attach_failure_snippets(workspace_root, &cleaned_lines, 3);
        if !snippets.is_empty() {
            header.push_str("\n--- context snippets ---");
            for snip in snippets {
                header.push('\n');
                header.push_str(&snip);
            }
        }
    }

    Ok(ExecDistillResult {
        exit_code,
        timed_out,
        duration_ms,
        log_id,
        raw_bytes,
        raw_lines,
        distilled: header,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CmdKind {
    CargoTest,
    CargoCheckOrBuild,
    Pytest,
    JsTest,
    TscOrEslint,
    GitStatus,
    GitDiff,
    GitLog,
    Generic,
}

fn detect_command_kind(args: &[String], display: &str) -> CmdKind {
    let lower = display.to_ascii_lowercase();
    let first = args
        .first()
        .map(|s| {
            Path::new(s)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(s)
        })
        .unwrap_or("")
        .to_ascii_lowercase();

    if first == "cargo"
        || lower.contains("cargo test")
        || lower.contains("cargo clippy")
        || lower.contains("cargo check")
        || lower.contains("cargo build")
    {
        if lower.contains(" test") || lower.starts_with("cargo test") {
            return CmdKind::CargoTest;
        }
        return CmdKind::CargoCheckOrBuild;
    }
    if first == "pytest" || lower.contains("pytest") {
        return CmdKind::Pytest;
    }
    if first == "jest"
        || first == "vitest"
        || lower.contains("npm test")
        || lower.contains("pnpm test")
        || lower.contains("yarn test")
        || lower.contains("bun test")
        || lower.contains("npx jest")
        || lower.contains("npx vitest")
    {
        return CmdKind::JsTest;
    }
    if first == "tsc"
        || first == "eslint"
        || lower.contains("npx tsc")
        || lower.contains("npx eslint")
    {
        return CmdKind::TscOrEslint;
    }
    if first == "git" || lower.starts_with("git ") {
        if lower.contains(" status") {
            return CmdKind::GitStatus;
        }
        if lower.contains(" diff") {
            return CmdKind::GitDiff;
        }
        if lower.contains(" log") {
            return CmdKind::GitLog;
        }
    }
    CmdKind::Generic
}

/// Strips ANSI CSI/OSC escape sequences, handles `\r` spinner overwrites,
/// and collapses consecutive duplicate lines.
pub fn clean_and_collapse_lines(raw: &str) -> Vec<String> {
    let stripped = ANSI_RE.replace_all(raw, "");

    let mut collapsed: Vec<(String, usize)> = Vec::new();
    for raw_line in stripped.split('\n') {
        let line = if raw_line.contains('\r') {
            raw_line
                .split('\r')
                .rfind(|seg| !seg.is_empty())
                .unwrap_or("")
                .trim_end()
                .to_string()
        } else {
            raw_line.trim_end().to_string()
        };

        if let Some((prev, count)) = collapsed.last_mut()
            && *prev == line
        {
            *count += 1;
            continue;
        }
        collapsed.push((line, 1));
    }

    collapsed
        .into_iter()
        .map(|(l, count)| {
            if count > 1 && !l.is_empty() {
                format!("{l} (x{count})")
            } else {
                l
            }
        })
        .collect()
}

fn has_failure_markers(lines: &[String]) -> bool {
    lines.iter().any(|l| {
        let t = l.trim_start();
        l.contains("FAILED")
            || l.contains("ERRORS")
            || l.contains("=== FAILURES ===")
            || l.contains("=== ERRORS ===")
            || l.contains("Traceback (most recent call last):")
            || l.contains("ModuleNotFoundError")
            || l.contains("ImportError")
            || l.contains("SyntaxError")
            || l.contains("AssertionError")
            || l.contains("panicked at")
            || l.contains("test result: FAILED")
            || l.contains("ERROR collecting")
            || l.contains("error TS")
            || t.starts_with("ERROR ")
            || t.starts_with("ERROR:")
            || NONZERO_FAIL_COUNT_RE.is_match(l)
    })
}

fn distill_by_kind(kind: CmdKind, passed: bool, lines: &[String]) -> String {
    let effective_passed = passed && !has_failure_markers(lines);
    match kind {
        CmdKind::CargoTest => distill_cargo_test(effective_passed, lines),
        CmdKind::CargoCheckOrBuild => distill_cargo_check(effective_passed, lines),
        CmdKind::Pytest => distill_pytest(effective_passed, lines),
        CmdKind::JsTest => distill_js_test(effective_passed, lines),
        CmdKind::TscOrEslint => distill_tsc_eslint(effective_passed, lines),
        CmdKind::GitStatus => distill_git_status(lines),
        CmdKind::GitDiff => distill_git_diff(lines),
        CmdKind::GitLog => distill_git_log(lines),
        CmdKind::Generic => distill_generic(effective_passed, lines),
    }
}

fn distill_cargo_test(passed: bool, lines: &[String]) -> String {
    if passed {
        let mut total_passed = 0u64;
        let mut total_ignored = 0u64;
        let mut suites = 0u64;
        let mut warnings = 0u64;
        for l in lines {
            if l.starts_with("test result: ok.") && !NONZERO_FAIL_COUNT_RE.is_match(l) {
                suites += 1;
                total_passed += extract_count_before(l, " passed;");
                total_ignored += extract_count_before(l, " ignored;");
            } else if l.starts_with("warning:") {
                warnings += 1;
            }
        }
        if suites > 0 {
            return format!(
                "cargo test: {total_passed} passed, {total_ignored} ignored across {suites} suite(s), {warnings} warning(s)"
            );
        }
        return distill_generic(true, lines);
    }

    let mut kept = Vec::new();
    let mut in_failure_block = false;
    for l in lines {
        let t = l.trim();
        if t.starts_with("error")
            || t.starts_with("--> ")
            || t.starts_with("panicked at")
            || t.starts_with("assertion")
            || t.starts_with("left:")
            || t.starts_with("right:")
            || t.starts_with("test result: FAILED")
            || t.starts_with("failures:")
            || (t.starts_with("test ") && t.ends_with("FAILED"))
        {
            kept.push(l.clone());
            in_failure_block = t.starts_with("failures:") || t.starts_with("---- ");
        } else if t.starts_with("---- ") && t.ends_with(" stdout ----") {
            in_failure_block = true;
            kept.push(l.clone());
        } else if in_failure_block {
            if t.is_empty() {
                in_failure_block = false;
            } else {
                kept.push(l.clone());
            }
        }
    }
    if kept.is_empty() {
        return distill_generic(false, lines);
    }
    truncate_lines(&kept, 60)
}

fn distill_cargo_check(passed: bool, lines: &[String]) -> String {
    if passed {
        let warnings = lines.iter().filter(|l| l.starts_with("warning:")).count();
        let finished = lines
            .iter()
            .rev()
            .find(|l| l.trim_start().starts_with("Finished "))
            .map(|s| s.trim())
            .unwrap_or("Finished");
        return format!("{finished} ({warnings} warning(s))");
    }
    let kept: Vec<String> = lines
        .iter()
        .filter(|l| {
            let t = l.trim();
            t.starts_with("error")
                || t.starts_with("--> ")
                || t.starts_with('|')
                || t.starts_with("= note:")
                || t.starts_with("= help:")
        })
        .cloned()
        .collect();
    if kept.is_empty() {
        return distill_generic(false, lines);
    }
    truncate_lines(&kept, 60)
}

fn distill_pytest(passed: bool, lines: &[String]) -> String {
    if passed && !has_failure_markers(lines) {
        if let Some(summary) = lines
            .iter()
            .rev()
            .find(|l| {
                let low = l.to_ascii_lowercase();
                low.contains(" passed")
                    && (l.starts_with('=') || l.contains(" in "))
                    && !low.contains("failed")
                    && !low.contains("error")
            })
            .map(|s| s.trim().trim_matches('=').trim())
        {
            return summary.to_string();
        }
        return distill_generic(true, lines);
    }
    let mut kept = Vec::new();
    let mut capture = false;
    for l in lines {
        let t = l.trim_start();
        if l.contains("=== FAILURES ===")
            || l.contains("=== ERRORS ===")
            || l.contains("=== short test summary info ===")
            || l.contains("Traceback (most recent call last):")
        {
            capture = true;
            kept.push(l.clone());
        } else if capture
            || l.starts_with("E   ")
            || l.starts_with("FAILED ")
            || l.contains("FAILED")
            || l.contains("ERROR collecting")
            || t.starts_with("ERROR ")
            || t.starts_with("ERROR:")
            || t.starts_with("File \"")
            || t.starts_with("> ")
            || l.contains("ModuleNotFoundError")
            || l.contains("ImportError")
            || l.contains("SyntaxError")
            || l.contains("AssertionError")
            || l.contains("panicked at")
            || l.contains("Error:")
            || NONZERO_FAIL_COUNT_RE.is_match(l)
        {
            kept.push(l.clone());
        }
    }
    if kept.is_empty() {
        return distill_generic(false, lines);
    }
    truncate_lines(&kept, 60)
}

fn distill_js_test(passed: bool, lines: &[String]) -> String {
    if passed && !has_failure_markers(lines) {
        let summary: Vec<String> = lines
            .iter()
            .filter(|l| {
                let t = l.trim();
                let low = t.to_ascii_lowercase();
                (t.starts_with("Test Suites:")
                    || t.starts_with("Tests:")
                    || t.starts_with("Test Files")
                    || t.starts_with("Duration")
                    || low.contains(" pass"))
                    && !low.contains("fail")
                    && !low.contains("error")
            })
            .cloned()
            .collect();
        if !summary.is_empty() {
            return truncate_lines(&summary, 8);
        }
        return distill_generic(true, lines);
    }
    let kept: Vec<String> = lines
        .iter()
        .filter(|l| {
            let t = l.trim();
            t.starts_with("FAIL ")
                || t.starts_with("● ")
                || t.starts_with("Expected")
                || t.starts_with("Received")
                || t.starts_with("at ")
                || t.starts_with("Error:")
                || t.starts_with("AssertionError")
                || t.starts_with("Test Suites:")
                || t.starts_with("Tests:")
        })
        .cloned()
        .collect();
    if kept.is_empty() {
        return distill_generic(false, lines);
    }
    truncate_lines(&kept, 60)
}

fn distill_tsc_eslint(passed: bool, lines: &[String]) -> String {
    if passed {
        return "0 errors".to_string();
    }
    let kept: Vec<String> = lines
        .iter()
        .filter(|l| {
            let t = l.trim();
            t.contains("error TS")
                || t.contains(" error ")
                || t.contains(" problems (")
                || t.ends_with(".ts")
                || t.ends_with(".tsx")
                || t.ends_with(".js")
        })
        .cloned()
        .collect();
    if kept.is_empty() {
        return distill_generic(false, lines);
    }
    truncate_lines(&kept, 60)
}

fn distill_git_status(lines: &[String]) -> String {
    truncate_lines(
        &lines
            .iter()
            .filter(|l| !l.trim().is_empty())
            .cloned()
            .collect::<Vec<_>>(),
        40,
    )
}

fn distill_git_diff(lines: &[String]) -> String {
    let mut files = 0usize;
    let mut added = 0usize;
    let mut removed = 0usize;
    let mut kept = Vec::new();
    for l in lines {
        if l.starts_with("diff --git ") {
            files += 1;
            kept.push(l.clone());
        } else if l.starts_with("@@ ") {
            kept.push(l.clone());
        } else if l.starts_with('+') && !l.starts_with("+++") {
            added += 1;
            if kept.len() < 80 {
                kept.push(l.clone());
            }
        } else if l.starts_with('-') && !l.starts_with("---") {
            removed += 1;
            if kept.len() < 80 {
                kept.push(l.clone());
            }
        }
    }
    let summary = format!("git diff: {files} file(s), +{added} -{removed} lines");
    if kept.is_empty() {
        summary
    } else {
        format!("{summary}\n{}", truncate_lines(&kept, 80))
    }
}

fn distill_git_log(lines: &[String]) -> String {
    truncate_lines(
        &lines
            .iter()
            .filter(|l| !l.trim().is_empty())
            .cloned()
            .collect::<Vec<_>>(),
        30,
    )
}

fn distill_generic(passed: bool, lines: &[String]) -> String {
    let non_empty: Vec<String> = lines
        .iter()
        .filter(|l| !l.trim().is_empty())
        .cloned()
        .collect();
    if passed {
        let n = non_empty.len();
        let tail = &non_empty[n.saturating_sub(5)..];
        return tail.join("\n");
    }
    let errs: Vec<String> = non_empty
        .iter()
        .filter(|l| {
            let low = l.to_ascii_lowercase();
            low.contains("error")
                || low.contains("fail")
                || low.contains("panic")
                || low.contains("exception")
                || low.contains("traceback")
        })
        .cloned()
        .collect();
    if !errs.is_empty() {
        return truncate_lines(&errs, 40);
    }
    let n = non_empty.len();
    non_empty[n.saturating_sub(25)..].join("\n")
}

fn truncate_lines(lines: &[String], max_lines: usize) -> String {
    if lines.len() <= max_lines {
        lines.join("\n")
    } else {
        let mut out = lines[..max_lines].join("\n");
        out.push_str(&format!(
            "\n... ({} more lines in log)",
            lines.len() - max_lines
        ));
        out
    }
}

fn extract_count_before(line: &str, suffix: &str) -> u64 {
    let Some(idx) = line.find(suffix) else {
        return 0;
    };
    line[..idx]
        .split_whitespace()
        .last()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0)
}

/// Extracts up to `max_snippets` unique in-workspace `file:line` references from failure output
/// and attaches a compact 5-7 line hashline snippet for each.
fn attach_failure_snippets(
    workspace_root: &Path,
    lines: &[String],
    max_snippets: usize,
) -> Vec<String> {
    let Ok(fs) = WorkspaceFs::open_root(workspace_root) else {
        return Vec::new();
    };

    let mut seen: HashSet<(String, u64)> = HashSet::new();
    let mut snippets = Vec::new();

    for l in lines {
        for cap in LOC_RE.captures_iter(l) {
            let raw_path = &cap[1];
            let Ok(line_num) = cap[2].parse::<u64>() else {
                continue;
            };
            if line_num == 0 {
                continue;
            }
            let rel = normalize_rel_path(workspace_root, raw_path);
            let Some(rel_path) = rel else {
                continue;
            };
            if seen.contains(&(rel_path.clone(), line_num)) {
                continue;
            }
            let Ok((bytes, _)) = fs.read_file_bytes(&rel_path, 2 * 1024 * 1024) else {
                continue;
            };
            let Ok(analyzed) = analyze_text(&bytes, false) else {
                continue;
            };
            let rev = blake3_hex(&bytes);
            let region = format_hashline_region(&analyzed, &rev, line_num, 2);
            snippets.push(format!("@ {rel_path}:{line_num}\n{region}"));
            seen.insert((rel_path, line_num));
            if snippets.len() >= max_snippets {
                return snippets;
            }
        }
    }
    snippets
}

fn normalize_rel_path(workspace_root: &Path, raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let p = Path::new(trimmed);
    let rel = if p.is_absolute() {
        p.strip_prefix(workspace_root).ok()?.to_str()?.to_string()
    } else {
        trimmed.to_string()
    };
    ms_protocol::normalize_relative_path(&rel).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_strips_ansi_cr_and_collapses_duplicates() {
        let raw = "\x1b[32mOK\x1b[0m\nstep 1\rstep 2\nrepeat\nrepeat\nrepeat\n\x1b[38:2:255:0:0mred\x1b[0m";
        let lines = clean_and_collapse_lines(raw);
        assert_eq!(lines, vec!["OK", "step 2", "repeat (x3)", "red"]);
    }

    #[test]
    fn distillers_cover_pytest_jest_tsc_eslint() {
        let pytest_fail = clean_and_collapse_lines(
            "==== test session starts ====\n\
             collected 3 items\n\
             test_app.py ..F\n\
             ==== FAILURES ====\n\
             ____ test_math ____\n\
             E   AssertionError: 1 != 2\n\
             ==== short test summary info ====\n\
             FAILED test_app.py::test_math - AssertionError",
        );
        let out = distill_by_kind(CmdKind::Pytest, false, &pytest_fail);
        assert!(out.contains("==== FAILURES ===="));
        assert!(out.contains("FAILED test_app.py::test_math"));

        let pytest_pass = clean_and_collapse_lines("collected 3 items\n=== 3 passed in 0.12s ===");
        assert_eq!(
            distill_by_kind(CmdKind::Pytest, true, &pytest_pass),
            "3 passed in 0.12s"
        );

        let jest_fail = clean_and_collapse_lines(
            "FAIL src/sum.test.ts\n\
             ● adds 1 + 2\n\
             Expected: 3\n\
             Received: 4\n\
             at Object.<anonymous> (src/sum.test.ts:5:12)\n\
             Test Suites: 1 failed, 1 total",
        );
        let j_out = distill_by_kind(CmdKind::JsTest, false, &jest_fail);
        assert!(j_out.contains("FAIL src/sum.test.ts"));
        assert!(j_out.contains("Expected: 3"));

        let tsc_fail = clean_and_collapse_lines(
            "src/index.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.",
        );
        let t_out = distill_by_kind(CmdKind::TscOrEslint, false, &tsc_fail);
        assert!(t_out.contains("error TS2322"));
    }

    #[test]
    fn read_log_rejects_traversal() {
        assert!(read_log("../etc/passwd", None, None).is_err());
        assert!(read_log("", None, None).is_err());
    }

    #[tokio::test]
    async fn exec_preserves_short_passing_output_intact() {
        let dir = tempfile::tempdir().unwrap();
        let res = exec_and_distill(
            dir.path(),
            &[
                "python3".to_string(),
                "-c".to_string(),
                "for i in range(1, 9): print(f'line-{i}')".to_string(),
            ],
            5_000,
        )
        .await
        .unwrap();
        assert_eq!(res.exit_code, 0);
        for i in 1..=8 {
            assert!(
                res.distilled.contains(&format!("line-{i}")),
                "missing line-{i} in: {}",
                res.distilled
            );
        }
    }

    #[tokio::test]
    async fn exec_timeout_kills_shell_grandchild_promptly() {
        let dir = tempfile::tempdir().unwrap();
        let started = Instant::now();
        let res = exec_and_distill(dir.path(), &["sleep 5".to_string()], 150)
            .await
            .unwrap();
        assert!(res.timed_out);
        assert_eq!(res.exit_code, 124);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "timeout took too long: {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn piped_pytest_with_exit_zero_and_failure_markers_never_emits_pytest_passed() {
        let mut raw_lines = vec![
            "==== test session starts ====".to_string(),
            "platform linux -- Python 3.12".to_string(),
        ];
        for i in 1..=16 {
            raw_lines.push(format!("collecting ... item {i}"));
        }
        raw_lines.extend([
            "Traceback (most recent call last):".to_string(),
            "  File \"tests/test_app.py\", line 4, in <module>".to_string(),
            "    import nonexistent_dep".to_string(),
            "ModuleNotFoundError: No module named 'nonexistent_dep'".to_string(),
            "FAILED tests/test_app.py::test_import".to_string(),
        ]);
        let out = distill_by_kind(CmdKind::Pytest, true, &raw_lines);
        assert!(
            !out.contains("pytest passed"),
            "must not emit 'pytest passed' on failure output: {out}"
        );
        assert!(out.contains("Traceback (most recent call last):"));
        assert!(out.contains("ModuleNotFoundError: No module named 'nonexistent_dep'"));
        assert!(out.contains("FAILED tests/test_app.py::test_import"));
    }

    #[test]
    fn pytest_without_summary_line_does_not_fabricate_pytest_passed() {
        let truncated_head: Vec<String> = (1..=20)
            .map(|i| format!("tests/test_suite.py::test_case_{i} PASSED"))
            .collect();
        let out = distill_by_kind(CmdKind::Pytest, true, &truncated_head);
        assert!(
            !out.contains("pytest passed"),
            "must not fabricate 'pytest passed' without summary line: {out}"
        );
        assert!(out.contains("test_case_20 PASSED"));
    }

    #[tokio::test]
    async fn exec_piped_pytest_exit_zero_failure_preserves_errors_and_snippets() {
        let dir = tempfile::tempdir().unwrap();
        let test_dir = dir.path().join("tests");
        std::fs::create_dir_all(&test_dir).unwrap();
        std::fs::write(
            test_dir.join("test_mod.py"),
            "import missing_pkg\n\ndef test_ok():\n    assert True\n",
        )
        .unwrap();

        let script = [
            "for i in range(1, 18): print(f'collecting ... {i}')",
            "print('Traceback (most recent call last):')",
            "print('  File \"tests/test_mod.py\", line 1, in <module>')",
            "print('    import missing_pkg')",
            "print(\"ModuleNotFoundError: No module named 'missing_pkg'\")",
            "print('FAILED tests/test_mod.py::test_ok')",
        ]
        .join("\n");
        std::fs::write(dir.path().join("emit.py"), script).unwrap();
        let res = exec_and_distill(
            dir.path(),
            &["python3 emit.py | tail -30 # pytest".to_string()],
            5_000,
        )
        .await
        .unwrap();
        assert_eq!(res.exit_code, 0);
        assert!(
            !res.distilled.contains("pytest passed"),
            "must not emit 'pytest passed': {}",
            res.distilled
        );
        assert!(res.distilled.contains("[FAILED | exit:0"));
        assert!(res.distilled.contains("ModuleNotFoundError"));
        assert!(res.distilled.contains("--- context snippets ---"));
        assert!(res.distilled.contains("import missing_pkg"));
    }

    #[test]
    fn piped_tsc_and_truncated_pytest_summary_are_not_misclassified() {
        let tsc_lines = vec![
            "src/index.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'."
                .to_string(),
        ];
        let tsc_out = distill_by_kind(CmdKind::TscOrEslint, true, &tsc_lines);
        assert_ne!(tsc_out, "0 errors");
        assert!(tsc_out.contains("error TS2322"));

        let tail_pytest_lines = vec![
            ">       assert actual == expected".to_string(),
            "E       AssertionError: assert 1 == 2".to_string(),
            "=== 1 failed, 2 passed in 0.12s ===".to_string(),
        ];
        let pytest_out = distill_by_kind(CmdKind::Pytest, true, &tail_pytest_lines);
        assert!(!pytest_out.contains("pytest passed"));
        assert!(pytest_out.contains("assert actual == expected"));
        assert!(pytest_out.contains("1 failed, 2 passed"));
    }

    #[tokio::test]
    async fn exec_git_diff_with_test_keywords_stays_ok() {
        let dir = tempfile::tempdir().unwrap();
        let run_git = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(dir.path())
                .status()
                .unwrap();
            assert!(status.success(), "git {args:?} failed");
        };
        run_git(&["init"]);
        run_git(&["config", "user.email", "test@example.com"]);
        run_git(&["config", "user.name", "Test"]);
        std::fs::write(dir.path().join("t.py"), "def test_x():\n    pass\n").unwrap();
        run_git(&["add", "t.py"]);
        run_git(&["commit", "-m", "init"]);
        std::fs::write(
            dir.path().join("t.py"),
            "def test_x():\n    raise AssertionError()\n",
        )
        .unwrap();

        let res = exec_and_distill(dir.path(), &["git diff".to_string()], 5_000)
            .await
            .unwrap();
        assert_eq!(res.exit_code, 0);
        assert!(
            res.distilled.starts_with("[OK | exit:0"),
            "git diff should stay OK: {}",
            res.distilled
        );
        assert!(!res.distilled.contains("--- context snippets ---"));
    }
}
