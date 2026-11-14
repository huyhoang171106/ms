use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use ms_runtime::text::{analyze_text, blake3_hex, format_hashline_region};
use ms_runtime::workspace_fs::WorkspaceFs;
use regex::{Regex, RegexBuilder};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

static LOG_SEQ: AtomicU64 = AtomicU64::new(1);

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

    let started = Instant::now();
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn '{}': {e}", command_args[0]))?;

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
                let _ = child.kill().await;
                let _ = child.wait().await;
                124
            }
        };

    let duration_ms = started.elapsed().as_millis() as u64;
    let out_bytes = stdout_task.await.unwrap_or_default();
    let err_bytes = stderr_task.await.unwrap_or_default();

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
    let body = distill_by_kind(kind, exit_code == 0 && !timed_out, &cleaned_lines);

    let mut header = if timed_out {
        format!(
            "[TIMED OUT after {duration_ms}ms | exit:{exit_code} | log:{log_id} | raw:{raw_lines}L/{raw_bytes}B]"
        )
    } else if exit_code == 0 {
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

    if exit_code != 0 || timed_out {
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
    let ansi_re =
        Regex::new(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")
            .unwrap();
    let stripped = ansi_re.replace_all(raw, "");

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

fn distill_by_kind(kind: CmdKind, passed: bool, lines: &[String]) -> String {
    match kind {
        CmdKind::CargoTest => distill_cargo_test(passed, lines),
        CmdKind::CargoCheckOrBuild => distill_cargo_check(passed, lines),
        CmdKind::Pytest => distill_pytest(passed, lines),
        CmdKind::JsTest => distill_js_test(passed, lines),
        CmdKind::TscOrEslint => distill_tsc_eslint(passed, lines),
        CmdKind::GitStatus => distill_git_status(lines),
        CmdKind::GitDiff => distill_git_diff(lines),
        CmdKind::GitLog => distill_git_log(lines),
        CmdKind::Generic => distill_generic(passed, lines),
    }
}

fn distill_cargo_test(passed: bool, lines: &[String]) -> String {
    if passed {
        let mut total_passed = 0u64;
        let mut total_ignored = 0u64;
        let mut suites = 0u64;
        let mut warnings = 0u64;
        for l in lines {
            if l.starts_with("test result: ok.") {
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
    if passed {
        let summary = lines
            .iter()
            .rev()
            .find(|l| l.contains(" passed") && (l.starts_with('=') || l.contains(" in ")))
            .map(|s| s.trim().trim_matches('=').trim())
            .unwrap_or("pytest passed");
        return summary.to_string();
    }
    let mut kept = Vec::new();
    let mut capture = false;
    for l in lines {
        if l.starts_with("==== FAILURES ====")
            || l.starts_with("==== ERRORS ====")
            || l.starts_with("==== short test summary info ====")
        {
            capture = true;
            kept.push(l.clone());
        } else if capture
            || l.starts_with("E   ")
            || l.starts_with("FAILED ")
            || l.contains("Error:")
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
    if passed {
        let summary: Vec<String> = lines
            .iter()
            .filter(|l| {
                let t = l.trim();
                t.starts_with("Test Suites:")
                    || t.starts_with("Tests:")
                    || t.starts_with("Test Files")
                    || t.starts_with("Duration")
                    || t.contains(" pass")
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
    let loc_re = Regex::new(
        r#"(?:-->\s*|at\s+[^\n]*?\(|File\s+")?([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)(?:[:\(]|",\s*line\s*)(\d+)"#,
    )
    .unwrap();

    let mut seen: HashSet<(String, u64)> = HashSet::new();
    let mut snippets = Vec::new();

    for l in lines {
        for cap in loc_re.captures_iter(l) {
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
    let trimmed = raw.trim().trim_start_matches("./");
    if trimmed.is_empty() || trimmed.contains("..") {
        return None;
    }
    let p = Path::new(trimmed);
    let rel = if p.is_absolute() {
        p.strip_prefix(workspace_root).ok()?.to_str()?.to_string()
    } else {
        trimmed.to_string()
    };
    if ms_protocol::validate_relative_path(&rel).is_err() {
        return None;
    }
    Some(rel)
}
