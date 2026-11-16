use std::collections::{BTreeSet, HashSet};
use std::ffi::OsString;
use std::os::unix::process::CommandExt;
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

const LOG_RETENTION_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const LOG_RETENTION_MAX_FILES: usize = 200;
/// Bound on how often the retention sweep may scan the log directory. It used to run on every `ms exec`,
/// costing a full `readdir` + 200 `stat` calls per command; the TTL is 24h, so every 5 minutes is plenty.
const LOG_GC_INTERVAL: Duration = Duration::from_secs(5 * 60);

pub fn log_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("MS_LOG_DIR")
        && !dir.is_empty()
    {
        return PathBuf::from(dir);
    }
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
    let stamp = dir.join(".last-gc");
    let due = std::fs::metadata(&stamp)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_none_or(|age| age >= LOG_GC_INTERVAL);
    if due {
        let _ = gc_log_dir(&dir, LOG_RETENTION_MAX_AGE, LOG_RETENTION_MAX_FILES);
        let _ = std::fs::write(&stamp, b"");
    }
    Ok(path)
}

/// Removes `.log` files older than `max_age` and caps retained `.log` files to `max_files` newest.
pub fn gc_log_dir(dir: &Path, max_age: Duration, max_files: usize) -> std::io::Result<usize> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(0);
    };
    let now = SystemTime::now();
    let mut kept: Vec<(SystemTime, PathBuf)> = Vec::new();
    let mut removed = 0usize;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("log") {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let mtime = meta.modified().unwrap_or(UNIX_EPOCH);
        if now
            .duration_since(mtime)
            .ok()
            .is_some_and(|age| age > max_age)
        {
            if std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
            continue;
        }
        kept.push((mtime, path));
    }

    if kept.len() > max_files {
        // Sort newest first; break ties deterministically by path descending.
        kept.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
        for (_, old_path) in kept.into_iter().skip(max_files) {
            if std::fs::remove_file(&old_path).is_ok() {
                removed += 1;
            }
        }
    }

    Ok(removed)
}

/// Reads a persisted raw log by `log_id`, optionally filtering with `grep` and taking last `tail` lines.
pub fn read_log(log_id: &str, tail: Option<usize>, grep: Option<&str>) -> Result<String, String> {
    let log_id = log_id.strip_prefix("log:").unwrap_or(log_id);
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

/// Env var names that are never passed on to a child, mirroring the harness-side scrub: `printenv` or
/// `echo $X_API_KEY` inside the command must not be able to read the agent's own credentials.
/// A substring test rather than a regex so `ms exec` pays no regex compile on its hot path.
const SECRET_ENV_MARKERS: [&str; 8] = [
    "KEY",
    "SECRET",
    "TOKEN",
    "PASSWORD",
    "PASS",
    "AUTH",
    "CREDENTIAL",
    "PRIVATE",
];
/// Variables that would break ordinary commands if scrubbed.
const ENV_ALWAYS_KEPT: [&str; 4] = ["PATH", "HOME", "LANG", "TERM"];

fn scrubbed_env() -> Vec<(OsString, OsString)> {
    std::env::vars_os()
        .filter(|(k, _)| {
            let name = k.to_string_lossy().to_ascii_uppercase();
            ENV_ALWAYS_KEPT.contains(&name.as_str())
                || !SECRET_ENV_MARKERS.iter().any(|m| name.contains(m))
        })
        .collect()
}

/// Strips quote characters so `rm -rf "/"` and `rm -rf /` compare equal. Quoted text that only prints
/// (`echo "rm -rf /"`) is dropped by the segment filter below instead.
fn unquoted(token: &str) -> String {
    token.replace(['"', '\''], "")
}

/// Collapses `//`, `/./` and `/../` so `/tmp/../../etc` is seen as the `/etc` the kernel would open.
fn canonical_path(token: &str) -> String {
    if !token.starts_with('/') {
        return token.to_string();
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in token.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    format!("/{}", parts.join("/"))
}

/// A shell-text guard, not a security boundary (the workspace sandbox is): it refuses the handful of
/// commands an agent never means, which have no other recovery than a lost machine.
fn destructive_reason(command: &str) -> Option<&'static str> {
    let flattened = command
        .replace(['"', '\''], "")
        .replace("\\/", "/")
        .replace("${HOME}", "~")
        .replace("$HOME", "~");
    let whole = flattened.split_whitespace().collect::<Vec<_>>().join(" ");

    // `d=~; rm -rf $d` hides the target behind a variable: treat a recursive rm next to a home-ish
    // assignment as aimed at the home tree.
    let home_assignment = whole.split_whitespace().any(|t| {
        t.split_once('=')
            .is_some_and(|(_, v)| v.contains('~') || v.contains("/home/") || v.contains("/Users/"))
    });

    for segment in command.split(['&', '|', ';', '\n']) {
        let segment = segment.trim();
        if segment.is_empty() {
            continue;
        }
        if segment.starts_with("echo ") || segment.starts_with("printf ") {
            continue;
        }
        let tokens: Vec<String> = segment.split_whitespace().map(unquoted).collect();
        let bin = |t: &str| -> String {
            Path::new(&canonical_path(t))
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
                .to_ascii_lowercase()
        };

        for token in &tokens {
            if token == ">" || token == ">>" {
                continue;
            }
            if let Some(target) = token.strip_prefix(">>").or_else(|| token.strip_prefix('>')) {
                let target = canonical_path(target);
                if target.starts_with("/dev/") && !is_safe_device(&target) {
                    return Some("raw write to a block device");
                }
            }
        }

        for (i, token) in tokens.iter().enumerate() {
            let base = bin(token);
            match base.as_str() {
                "shutdown" | "reboot" | "poweroff" | "halt" => {
                    return Some("system shutdown/reboot command");
                }
                "init" | "telinit" => {
                    if tokens.get(i + 1).is_some_and(|a| a == "0" || a == "6") {
                        return Some("system shutdown/reboot command");
                    }
                }
                "systemctl" => {
                    if tokens
                        .get(i + 1)
                        .is_some_and(|a| matches!(a.as_str(), "reboot" | "poweroff" | "halt"))
                    {
                        return Some("system shutdown/reboot command");
                    }
                }
                "killall5" => return Some("kills every process the user owns"),
                "kill" => {
                    if tokens.get(i + 1).is_some_and(|a| a == "-1" || a == "0") {
                        return Some("kills every process the user owns");
                    }
                }
                "rm" => {
                    let mut recursive = false;
                    for operand in tokens.iter().skip(i + 1) {
                        if operand.starts_with('-') && !operand.starts_with("--") {
                            recursive |= operand.contains(['r', 'R']);
                            continue;
                        }
                        if operand == "--recursive" {
                            recursive = true;
                            continue;
                        }
                        if !recursive {
                            continue;
                        }
                        let target = canonical_path(
                            &operand
                                .replace("${HOME}", "~")
                                .replace("$HOME", "~")
                                .replace('~', "/home/~"),
                        );
                        if target == "/" || target.starts_with("/*") {
                            return Some("recursive delete of the root directory");
                        }
                        if target.starts_with("/home/~")
                            || operand.contains("HOME")
                            || home_assignment
                        {
                            return Some("recursive delete of the home directory");
                        }
                    }
                }
                "dd" | "cp" | "tee" | "install" | "truncate" | "shred" | "blkdiscard"
                | "wipefs" | "fdisk" | "sfdisk" | "parted" | "sgdisk" => {
                    if let Some(target) = tokens
                        .iter()
                        .rev()
                        .map(|t| canonical_path(t.trim_start_matches("of=")))
                        .find(|t| t.starts_with("/dev/"))
                        && !is_safe_device(&target)
                    {
                        return Some("raw write to a block device");
                    }
                }
                _ => {}
            }
        }
    }

    // `:(){ :|:& };:` has to be matched before segment splitting, which would cut the function body apart.
    let compact: String = flattened.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.contains("(){") && compact.contains('|') && compact.contains("};") {
        return Some("fork bomb");
    }
    None
}

fn is_safe_device(path: &str) -> bool {
    [
        "/dev/null",
        "/dev/zero",
        "/dev/stdout",
        "/dev/stderr",
        "/dev/stdin",
        "/dev/random",
        "/dev/urandom",
        "/dev/full",
        "/dev/tty",
        "/dev/shm/",
        "/dev/pts/",
        "/dev/fd/",
    ]
    .iter()
    .any(|safe| path.starts_with(safe))
}

const SHELL_BUILTINS: &[&str] = &[
    "cd", "echo", "printf", "export", "source", ".", "test", "[", "true", "false", "exec", "eval",
    "exit", "read", "set", "unset", "shift", "wait", "kill", "type", "hash", "alias", "umask",
    "pwd", "trap", "local", "return", "let", "jobs", "fg", "bg", "times", "ulimit", "readonly",
    "declare", "getopts", "time", "command", "builtin",
];

fn path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default()
}

fn is_executable_file(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_file()) && is_exec_mode(path)
}

fn is_exec_mode(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        true
    }
}

fn resolves_on_path(name: &str) -> bool {
    path_dirs()
        .iter()
        .any(|dir| is_executable_file(&dir.join(name)))
}

/// True when `a` and `b` differ by exactly one insertion, deletion, substitution or adjacent transposition.
fn within_one_edit(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a == b || a.len().abs_diff(b.len()) > 1 {
        return false;
    }
    let (long, short) = if a.len() >= b.len() { (a, b) } else { (b, a) };
    if long.len() == short.len() {
        let diffs: Vec<usize> = (0..long.len()).filter(|&i| long[i] != short[i]).collect();
        return diffs.len() == 1
            || (diffs.len() == 2
                && diffs[1] == diffs[0] + 1
                && long[diffs[0]] == short[diffs[1]]
                && long[diffs[1]] == short[diffs[0]]);
    }
    let mut i = 0;
    let mut skipped = false;
    while i < short.len() {
        if long[i + usize::from(skipped)] == short[i] {
            i += 1;
        } else if skipped {
            return false;
        } else {
            skipped = true;
        }
    }
    true
}

/// Every executable on `PATH` within one edit of `name`, deduplicated across directories.
fn typo_candidates(name: &str, dirs: &[PathBuf]) -> Vec<String> {
    let mut found = BTreeSet::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(fname) = entry.file_name().into_string() else {
                continue;
            };
            if !within_one_edit(name, &fname) || !is_executable_file(&entry.path()) {
                continue;
            }
            found.insert(fname);
        }
    }
    found.into_iter().collect()
}

/// Rewrites `command_args[0]` when its binary name is one typo away from a real command, so
/// `ms exec -- carog test` runs `cargo test` instead of failing with a bare "not found". Returns the
/// rewritten argument vector plus `(from, to)` for the report line.
fn autocorrect_args(command_args: &[String]) -> (Vec<String>, Option<(String, String)>) {
    let mut args = command_args.to_vec();
    let head = args[0].clone();
    let (name, tail) = match head.split_once(char::is_whitespace) {
        Some((name, tail)) => (name.to_string(), tail.to_string()),
        None => (head.clone(), String::new()),
    };
    let (name, tail) = (name.as_str(), tail.as_str());
    // An explicit path, an assignment, or a shell builtin is intentional: never rewrite it.
    if name.is_empty()
        || name.contains('/')
        || name.contains('=')
        || SHELL_BUILTINS.contains(&name)
        || resolves_on_path(name)
    {
        return (args, None);
    }
    let candidates = typo_candidates(name, &path_dirs());
    let [only] = candidates.as_slice() else {
        return (args, None);
    };
    let corrected = if tail.is_empty() {
        only.clone()
    } else {
        format!("{only} {tail}")
    };
    args[0] = corrected;
    (args, Some((name.to_string(), only.clone())))
}

/// Identity of a pid that survives pid reuse: field 22 (`starttime`) of `/proc/<pid>/stat`.
/// Without it, `kill -9 -<pgid>` on a stale handle can take down an unrelated process group.
fn process_start_id(pid: u32) -> Option<String> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // `comm` (field 2) is parenthesised and may contain spaces, so count from the last ')'.
    let rest = stat.rsplit_once(')')?.1;
    rest.split_whitespace().nth(19).map(str::to_string)
}

fn pid_alive(pid: u32, start_id: Option<&String>) -> bool {
    match (process_start_id(pid), start_id) {
        (None, _) => false,
        (Some(_), None) => true,
        (Some(current), Some(expected)) => &current == expected,
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct RunRecord {
    cmd: String,
    supervisor_pid: u32,
    supervisor_start: Option<String>,
    started_at_ms: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct DoneRecord {
    exit_code: i32,
    timed_out: bool,
    duration_ms: u64,
}

fn run_path(log_id: &str) -> PathBuf {
    log_dir().join(format!("{log_id}.run"))
}

fn done_path(log_id: &str) -> PathBuf {
    log_dir().join(format!("{log_id}.done"))
}

fn pgid_path(log_id: &str) -> PathBuf {
    log_dir().join(format!("{log_id}.pgid"))
}

fn log_path(log_id: &str) -> PathBuf {
    log_dir().join(format!("{log_id}.log"))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn kill_group(pgid: u32) {
    let _ = std::process::Command::new("kill")
        .args(["-9", &format!("-{pgid}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Starts `command_args` in the background and returns at once with a handle.
///
/// The child is owned by a detached `ms __supervise` process rather than by this one, so the caller can
/// exit (or be killed) without the run dying, and the exit status still has an owner that can record it.
pub fn exec_background(
    workspace_root: &Path,
    command_args: &[String],
    timeout_ms: u64,
    keep_env: bool,
) -> Result<String, String> {
    if command_args.is_empty() {
        return Err("command cannot be empty".to_string());
    }
    guard(command_args)?;
    let (command_args, autocorrect) = autocorrect_args(command_args);
    reap_orphans();

    let log_id = next_log_id();
    let exe = std::env::current_exe().map_err(|e| format!("cannot locate ms binary: {e}"))?;
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("__supervise")
        .arg("--root")
        .arg(workspace_root)
        .arg("--log")
        .arg(&log_id)
        .arg("--timeout")
        .arg(timeout_ms.to_string());
    if keep_env {
        cmd.arg("--keep-env");
    }
    cmd.arg("--").args(&command_args);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    cmd.process_group(0);

    let supervisor_pid = cmd
        .spawn()
        .map_err(|e| format!("failed to start supervisor: {e}"))?
        .id();
    let record = RunRecord {
        cmd: command_args.join(" "),
        supervisor_pid,
        supervisor_start: process_start_id(supervisor_pid),
        started_at_ms: now_ms(),
    };
    let text = serde_json::to_string(&record).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(log_dir()).map_err(|e| e.to_string())?;
    std::fs::write(run_path(&log_id), text).map_err(|e| e.to_string())?;

    let mut out = format!(
        "[STARTED | pid:{supervisor_pid} | log:{log_id} | raw:{}/{}]\nrun: ms wait {log_id}\ntail: ms log --id {log_id} --tail 40",
        log_path(&log_id).display(),
        workspace_root.display()
    );
    if let Some((from, to)) = &autocorrect {
        out.push_str(&format!("\n[autocorrect] {from} -> {to}"));
    }
    Ok(out)
}

/// The detached owner of one background run: starts the command, journals its process group, enforces the
/// deadline, and records the exit status. Runs as `ms __supervise`, so the caller never blocks.
pub fn supervise(
    workspace_root: &Path,
    log_id: &str,
    timeout_ms: u64,
    keep_env: bool,
    command_args: &[String],
) -> Result<(), String> {
    if command_args.is_empty() {
        return Err("command cannot be empty".to_string());
    }
    guard(command_args)?;
    let cmd_display = command_args.join(" ");
    let use_shell = command_args.len() == 1
        && command_args[0]
            .chars()
            .any(|c| " |&;<>".contains(c) || c == '$');
    let mut cmd = if use_shell {
        let mut c = std::process::Command::new("sh");
        c.arg("-c").arg(&command_args[0]);
        c
    } else {
        let mut c = std::process::Command::new(&command_args[0]);
        c.args(&command_args[1..]);
        c
    };

    std::fs::create_dir_all(log_dir()).map_err(|e| e.to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path(log_id))
        .map_err(|e| e.to_string())?;
    use std::io::Write as _;
    let _ = writeln!(file, "# cmd: {cmd_display}");
    let log_handle = file.try_clone().map_err(|e| e.to_string())?;

    cmd.current_dir(workspace_root)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_handle.try_clone().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(log_handle));
    if !keep_env {
        cmd.env_clear();
        cmd.envs(scrubbed_env());
    }
    #[cfg(unix)]
    cmd.process_group(0);

    let started = Instant::now();
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn '{}': {e}", command_args[0]))?;
    let pgid = child.id();
    // Journal the group before waiting: if this supervisor is killed, `reap_orphans` still knows what to kill.
    let _ = std::fs::write(pgid_path(log_id), pgid.to_string());

    let deadline = Duration::from_millis(timeout_ms);
    let mut timed_out = false;
    let exit_code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(1),
            Ok(None) => {}
            Err(e) => return Err(format!("wait failed: {e}")),
        }
        if started.elapsed() >= deadline {
            timed_out = true;
            kill_group(pgid);
            let _ = child.wait();
            break 124;
        }
        std::thread::sleep(Duration::from_millis(20));
    };

    let done = DoneRecord {
        exit_code,
        timed_out,
        duration_ms: started.elapsed().as_millis() as u64,
    };
    let _ = std::fs::write(
        done_path(log_id),
        serde_json::to_string(&done).unwrap_or_default(),
    );
    let _ = std::fs::remove_file(pgid_path(log_id));
    Ok(())
}

/// Waits for a background run to finish, then prints the same distilled report a blocking run would.
pub fn wait_run(workspace_root: &Path, log_id: &str, timeout_ms: u64) -> Result<String, String> {
    let log_id = log_id.strip_prefix("log:").unwrap_or(log_id);
    let run: RunRecord = serde_json::from_str(
        &std::fs::read_to_string(run_path(log_id))
            .map_err(|_| format!("unknown run '{log_id}' (no active handle)"))?,
    )
    .map_err(|e| format!("corrupt run record '{log_id}': {e}"))?;

    let started = Instant::now();
    let deadline = Duration::from_millis(timeout_ms);
    let done: DoneRecord = loop {
        if let Ok(text) = std::fs::read_to_string(done_path(log_id))
            && let Ok(done) = serde_json::from_str(&text)
        {
            break done;
        }
        if !pid_alive(run.supervisor_pid, run.supervisor_start.as_ref()) {
            return Err(format!(
                "run '{log_id}' ended without a status (supervisor pid {} was killed); raw log: ms log --id {log_id}",
                run.supervisor_pid
            ));
        }
        if started.elapsed() >= deadline {
            return Err(format!(
                "run '{log_id}' still running; tail: ms log --id {log_id} --tail 40"
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    };

    let raw = std::fs::read_to_string(log_path(log_id)).unwrap_or_default();
    // Drop the `# cmd:` line this module writes so the report counts only the command's own output.
    let body = raw
        .split_once('\n')
        .filter(|(first, _)| first.starts_with("# cmd: "))
        .map(|(_, rest)| rest)
        .unwrap_or(&raw);
    let report = build_report(
        workspace_root,
        &run.cmd.split_whitespace().map(str::to_string).collect::<Vec<_>>(),
        &run.cmd,
        done.exit_code,
        done.timed_out,
        done.duration_ms,
        body,
        log_id.to_string(),
        None,
    );
    let _ = std::fs::remove_file(run_path(log_id));
    Ok(report.distilled)
}

/// Kills process groups whose supervisor died without recording a status, then drops the stale handles.
/// A run whose supervisor is still alive is left alone.
fn reap_orphans() {
    let Ok(entries) = std::fs::read_dir(log_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("run") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(run) = serde_json::from_str::<RunRecord>(&text) else {
            let _ = std::fs::remove_file(&path);
            continue;
        };
        if pid_alive(run.supervisor_pid, run.supervisor_start.as_ref()) {
            continue;
        }
        let log_id = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        if done_path(&log_id).exists() {
            continue;
        }
        // The supervisor is gone and never recorded a status: kill whatever it left behind.
        if let Ok(text) = std::fs::read_to_string(pgid_path(&log_id))
            && let Ok(pgid) = text.trim().parse::<u32>()
            && pgid > 0
        {
            kill_group(pgid);
            let _ = std::fs::remove_file(pgid_path(&log_id));
        }
        let _ = std::fs::remove_file(&path);
    }
}

/// The refusal decision, split out so it can be checked without spawning anything.
fn guard(command_args: &[String]) -> Result<(), String> {
    match destructive_reason(&command_args.join(" ")) {
        Some(reason) => Err(format!("refused ({reason}): {}", command_args.join(" "))),
        None => Ok(()),
    }
}

/// Executes `command_args` in `workspace_root`, captures stdout+stderr, strips ANSI/CR noise,
/// persists raw output, and distills into a token-efficient summary (plus hashline snippets on failure).
pub async fn exec_and_distill(
    workspace_root: &Path,
    command_args: &[String],
    timeout_ms: u64,
    keep_env: bool,
) -> Result<ExecDistillResult, String> {
    if command_args.is_empty() {
        return Err("command cannot be empty".to_string());
    }
    guard(command_args)?;

    let (command_args, autocorrect) = autocorrect_args(command_args);
    let command_args = &command_args[..];
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
    if !keep_env {
        cmd.env_clear();
        cmd.envs(scrubbed_env());
    }
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

    let log_id = next_log_id();
    let _ = persist_raw_log(&log_id, &cmd_display, &combined);
    Ok(build_report(
        workspace_root,
        command_args,
        &cmd_display,
        exit_code,
        timed_out,
        duration_ms,
        &combined,
        log_id,
        autocorrect.as_ref(),
    ))
}

/// Turns raw output plus an exit status into the token-efficient report. Shared by the blocking
/// `exec` path and the `wait` path that reads a background run's log.
#[allow(clippy::too_many_arguments)]
fn build_report(
    workspace_root: &Path,
    command_args: &[String],
    cmd_display: &str,
    exit_code: i32,
    timed_out: bool,
    duration_ms: u64,
    combined: &str,
    log_id: String,
    autocorrect: Option<&(String, String)>,
) -> ExecDistillResult {
    let raw_bytes = combined.len();
    let raw_lines = combined.lines().count();
    let cleaned_lines = clean_and_collapse_lines(combined);
    let kind = detect_command_kind(command_args, cmd_display);
    let is_inspection = is_inspection_kind(kind);
    let failure_markers = !is_inspection && has_failure_markers(&cleaned_lines);
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

    if let Some((from, to)) = &autocorrect {
        header.push_str(&format!("\n[autocorrect] {from} -> {to}"));
    }

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

    ExecDistillResult {
        exit_code,
        timed_out,
        duration_ms,
        log_id,
        raw_bytes,
        raw_lines,
        distilled: header,
    }
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
    ReadOnlyInspection,
    Generic,
}

const fn is_inspection_kind(kind: CmdKind) -> bool {
    matches!(
        kind,
        CmdKind::GitStatus | CmdKind::GitDiff | CmdKind::GitLog | CmdKind::ReadOnlyInspection
    )
}

fn is_readonly_inspection_bin(bin: &str) -> bool {
    matches!(
        bin,
        "cat"
            | "head"
            | "tail"
            | "rg"
            | "ripgrep"
            | "grep"
            | "fd"
            | "find"
            | "ls"
            | "echo"
            | "printf"
            | "sed"
            | "awk"
            | "wc"
            | "sort"
            | "uniq"
    )
}

fn has_unquoted_shell_control(cmd: &str) -> bool {
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;
    let bytes = cmd.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if escaped {
            escaped = false;
            i += 1;
            continue;
        }
        if b == b'\\' && !in_single {
            escaped = true;
            i += 1;
            continue;
        }
        if b == b'\'' && !in_double {
            in_single = !in_single;
            i += 1;
            continue;
        }
        if b == b'"' && !in_single {
            in_double = !in_double;
            i += 1;
            continue;
        }
        if !in_single {
            if b == b'`' || (b == b'$' && i + 1 < bytes.len() && bytes[i + 1] == b'(') {
                return true;
            }
            if !in_double && matches!(b, b'|' | b';' | b'&' | b'\n') {
                return true;
            }
        }
        i += 1;
    }
    false
}

fn extract_first_shell_bin(cmd: &str) -> Option<&str> {
    for tok in cmd.split_whitespace() {
        // Skip leading KEY=VAL env assignments
        if tok.contains('=') && !tok.starts_with('-') && !tok.starts_with('/') {
            continue;
        }
        let clean = tok.trim_matches(|c| c == '\'' || c == '"');
        let base = Path::new(clean)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(clean);
        return Some(base);
    }
    None
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

    if args.len() > 1 {
        if is_readonly_inspection_bin(&first) {
            return CmdKind::ReadOnlyInspection;
        }
    } else if args.len() == 1
        && !has_unquoted_shell_control(&args[0])
        && let Some(bin) = extract_first_shell_bin(&args[0])
        && is_readonly_inspection_bin(&bin.to_ascii_lowercase())
    {
        return CmdKind::ReadOnlyInspection;
    }

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
    let effective_passed = passed && (is_inspection_kind(kind) || !has_failure_markers(lines));
    match kind {
        CmdKind::CargoTest => distill_cargo_test(effective_passed, lines),
        CmdKind::CargoCheckOrBuild => distill_cargo_check(effective_passed, lines),
        CmdKind::Pytest => distill_pytest(effective_passed, lines),
        CmdKind::JsTest => distill_js_test(effective_passed, lines),
        CmdKind::TscOrEslint => distill_tsc_eslint(effective_passed, lines),
        CmdKind::GitStatus => distill_git_status(lines),
        CmdKind::GitDiff => distill_git_diff(lines),
        CmdKind::GitLog => distill_git_log(lines),
        CmdKind::ReadOnlyInspection | CmdKind::Generic => distill_generic(effective_passed, lines),
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
            false,
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
        let res = exec_and_distill(dir.path(), &["sleep 5".to_string()], 150, false)
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
            false,
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

        let res = exec_and_distill(dir.path(), &["git diff".to_string()], 5_000, false)
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

    #[tokio::test]
    async fn readonly_inspection_commands_with_failure_words_stay_ok() {
        let dir = tempfile::tempdir().unwrap();
        let test_dir = dir.path().join("tests");
        std::fs::create_dir_all(&test_dir).unwrap();
        std::fs::write(
            test_dir.join("test_sample.py"),
            "def test_err():\n    # pytest FAILED ERROR Traceback\n    raise AssertionError('boom')\n",
        )
        .unwrap();

        // `rg "AssertionError" tests/` (both single-string shell and argv forms) must stay [OK | exit:0 ...]
        for cmd in [
            vec!["rg \"AssertionError\" tests/".to_string()],
            vec![
                "rg".to_string(),
                "AssertionError".to_string(),
                "tests/".to_string(),
            ],
            vec!["rg \"pytest\" tests/".to_string()],
            vec!["rg".to_string(), "pytest".to_string(), "tests/".to_string()],
            vec!["rg \"FAILED|AssertionError\" tests/".to_string()],
            vec!["cat tests/test_sample.py".to_string()],
        ] {
            let res = exec_and_distill(dir.path(), &cmd, 5_000, false)
                .await
                .unwrap();
            assert_eq!(res.exit_code, 0, "cmd={cmd:?} failed: {}", res.distilled);
            assert!(
                res.distilled.starts_with("[OK | exit:0"),
                "read-only inspection cmd={cmd:?} should stay OK, got: {}",
                res.distilled
            );
            assert!(!res.distilled.contains("--- context snippets ---"));
        }

        // Command substitution inside double quotes must NOT be treated as plain read-only inspection
        let sub_res = exec_and_distill(
            dir.path(),
            &["echo \"$(printf 'FAILED: boom\\n')\"".to_string()],
            5_000,
            false,
        )
        .await
        .unwrap();
        assert!(
            sub_res.distilled.starts_with("[FAILED | exit:0"),
            "command substitution inside double quotes should still detect failure markers, got: {}",
            sub_res.distilled
        );

        // read_log accepts both `<id>` and `log:<id>`
        let prefixed = read_log(&format!("log:{}", sub_res.log_id), Some(5), None).unwrap();
        assert!(prefixed.contains("FAILED: boom"));
    }

    #[test]
    fn gc_log_dir_removes_expired_and_excess_files() {
        let dir = tempfile::tempdir().unwrap();
        let now = SystemTime::now();

        // 2 expired (> 24h)
        for i in 0..2 {
            let p = dir.path().join(format!("old-{i}.log"));
            let f = std::fs::File::create(&p).unwrap();
            f.set_modified(now - Duration::from_secs(25 * 3600))
                .unwrap();
        }
        // 5 fresh files with distinct mtimes
        for i in 0..5 {
            let p = dir.path().join(format!("fresh-{i}.log"));
            let f = std::fs::File::create(&p).unwrap();
            f.set_modified(now - Duration::from_secs((5 - i) * 60))
                .unwrap();
        }
        // Non-.log file should be ignored by GC
        std::fs::write(dir.path().join("keep.txt"), "keep").unwrap();

        let removed = gc_log_dir(dir.path(), Duration::from_secs(24 * 3600), 3).unwrap();
        assert_eq!(removed, 4); // 2 expired + 2 oldest fresh
        assert!(!dir.path().join("old-0.log").exists());
        assert!(!dir.path().join("old-1.log").exists());
        assert!(!dir.path().join("fresh-0.log").exists());
        assert!(!dir.path().join("fresh-1.log").exists());
        assert!(dir.path().join("fresh-2.log").exists());
        assert!(dir.path().join("fresh-3.log").exists());
        assert!(dir.path().join("fresh-4.log").exists());
        assert!(dir.path().join("keep.txt").exists());
    }

    #[test]
    fn destructive_guard_refuses_catastrophes_but_allows_normal_commands() {
        for refused in [
            "rm -rf /",
            "rm -rf /*",
            "sudo rm -rf --no-preserve-root /",
            "rm -rf \"/\"",
            "rm -rf ~/",
            "rm -rf $HOME",
            "d=$HOME; rm -rf $d",
            "shutdown -h now",
            "systemctl reboot",
            "kill -1",
            "dd if=/dev/zero of=/dev/sda",
            ":(){ :|:& };:",
        ] {
            assert!(
                destructive_reason(refused).is_some(),
                "should refuse: {refused}"
            );
        }
        for allowed in [
            "rm -rf target",
            "rm -rf ./build",
            "rm file.txt",
            "git status && cargo test",
            "echo \"rm -rf /\"",
            "dd if=/dev/urandom of=/tmp/blob bs=1k count=1",
            "cargo test -- --nocapture",
            "cd / && ls",
        ] {
            assert_eq!(destructive_reason(allowed), None, "should allow: {allowed}");
        }
    }

    #[test]
    fn within_one_edit_only_accepts_a_single_typo() {
        for (a, b) in [
            ("gti", "git"),
            ("carog", "cargo"),
            ("pytest", "pyest"),
            ("python", "python3"),
            ("grep", "gerp"),
        ] {
            assert!(within_one_edit(a, b), "{a} vs {b}");
            assert!(within_one_edit(b, a), "{b} vs {a}");
        }
        assert!(!within_one_edit("git", "git"), "equal is not a typo");
        assert!(!within_one_edit("git", "gritty"));
        assert!(!within_one_edit("cargo", "tar"));
    }

    #[test]
    fn typo_candidates_returns_only_near_miss_executables() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("git");
        std::fs::write(&bin, b"#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let not_exec = dir.path().join("gti");
        std::fs::write(&not_exec, b"data").unwrap();

        let found = typo_candidates("gti", &[dir.path().to_path_buf()]);
        assert_eq!(found, vec!["git".to_string()], "got {found:?}");
        assert!(typo_candidates("totally-different", &[dir.path().to_path_buf()]).is_empty());
    }

    #[test]
    fn guard_wiring_refuses_before_anything_is_spawned() {
        // Pure decision check: the refusal path must be reachable through the same function
        // `exec_and_distill` calls, and it must never depend on spawning the command to find out.
        let err = guard(&["rm -rf /".to_string()]).unwrap_err();
        assert!(err.contains("refused"), "got: {err}");
        assert!(err.contains("root directory"), "got: {err}");
        assert!(guard(&["cargo test".to_string()]).is_ok());
    }

    #[tokio::test]
    async fn exec_scrubs_credential_env_unless_keep_env_is_set() {
        let dir = tempfile::tempdir().unwrap();
        let cmd = vec![
            "sh".to_string(),
            "-c".to_string(),
            "printf '%s|' \"$MS_TEST_API_KEY\" \"$HOME\"".to_string(),
        ];
        unsafe { std::env::set_var("MS_TEST_API_KEY", "super-secret-value") };
        let scrubbed = exec_and_distill(dir.path(), &cmd, 5_000, false)
            .await
            .unwrap();
        assert!(!scrubbed.distilled.contains("super-secret-value"));
        let kept = exec_and_distill(dir.path(), &cmd, 5_000, true)
            .await
            .unwrap();
        assert!(kept.distilled.contains("super-secret-value"));
        unsafe { std::env::remove_var("MS_TEST_API_KEY") };
    }
}
