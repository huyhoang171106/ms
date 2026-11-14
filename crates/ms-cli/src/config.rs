use std::path::PathBuf;

use ms_protocol::HardLimits;
use serde::Deserialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("invalid arguments: {0}")]
    InvalidArgs(String),
    #[error("failed to read config file: {0}")]
    ReadConfig(#[from] std::io::Error),
    #[error("invalid JSON config: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("invalid configuration: {0}")]
    Validation(String),
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonLimits {
    pub max_frame_bytes: Option<usize>,
    pub max_edit_file_bytes: Option<usize>,
    pub max_batch_records: Option<usize>,
    pub max_output_bytes_per_request: Option<usize>,
    pub default_deadline_ms: Option<u64>,
    pub max_deadline_ms: Option<u64>,
    pub max_concurrent_reads_per_connection: Option<usize>,
    pub max_concurrent_mutations_per_workspace: Option<usize>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonHostConfig {
    pub root: Option<PathBuf>,
    pub state_dir: Option<PathBuf>,
    pub allow_write: Option<bool>,
    pub read_subpaths: Option<Vec<String>>,
    pub write_subpaths: Option<Vec<String>>,
    pub secret_patterns: Option<Vec<String>>,
    pub max_state_bytes: Option<u64>,
    pub limits: Option<JsonLimits>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CliMode {
    #[default]
    Serve,
    Mcp,
    Exec,
    Log,
}

/// Parsed and validated CLI + JSON host configuration for `ms`.
#[derive(Debug, Clone)]
pub struct CliConfig {
    pub mode: CliMode,
    pub root: PathBuf,
    pub state_dir: Option<PathBuf>,
    pub allow_write: bool,
    pub read_subpaths: Option<Vec<String>>,
    pub write_subpaths: Option<Vec<String>>,
    pub extra_secret_patterns: Vec<String>,
    pub replace_secret_patterns: Option<Vec<String>>,
    pub max_state_bytes: Option<u64>,
    pub limits: HardLimits,
    pub exec_command: Vec<String>,
    pub exec_timeout_ms: u64,
    pub log_id: Option<String>,
    pub log_tail: Option<usize>,
    pub log_grep: Option<String>,
    pub show_help: bool,
    pub show_version: bool,
}

impl Default for CliConfig {
    fn default() -> Self {
        Self {
            mode: CliMode::Serve,
            root: PathBuf::from("."),
            state_dir: None,
            allow_write: false,
            read_subpaths: None,
            write_subpaths: None,
            extra_secret_patterns: Vec::new(),
            replace_secret_patterns: None,
            max_state_bytes: None,
            limits: HardLimits::default(),
            exec_command: Vec::new(),
            exec_timeout_ms: 60_000,
            log_id: None,
            log_tail: None,
            log_grep: None,
            show_help: false,
            show_version: false,
        }
    }
}

pub fn help_text() -> &'static str {
    "\
ms - Managed Workspace NDJSON RPC & MCP Server + Smart Command Distiller

USAGE:
  ms [serve] [OPTIONS]
  ms mcp [OPTIONS]
  ms exec [--root <DIR>] [--timeout <MS>] [--] <CMD...>
  ms log --id <ID> [--tail <N>] [--grep <PATTERN>]

OPTIONS:
  --config <PATH>                  Load base host configuration from JSON file
  --root <DIR>                     Workspace root directory (default: .)
  --state-dir <DIR>                State/journal directory outside writable root
  --allow-write                    Enable write operations (patch, edit, write_file, delete_file, rename_file, tx.undo)
  --read-only                      Disable write operations (default)
  --read-subpath <PATH>            Restrict reads to subpath (repeatable)
  --write-subpath <PATH>           Restrict writes to subpath (repeatable)
  --deny-path <PATTERN>            Additional secret/deny pattern (repeatable)
  --max-frame-bytes <BYTES>        Max NDJSON input frame bytes (default: 1048576)
  --max-edit-file-bytes <BYTES>    Max editable file bytes (default: 8388608)
  --max-batch-records <COUNT>      Max records per records event (default: 256)
  --max-output-bytes <BYTES>       Max output bytes per request (default: 1048576)
  --default-deadline-ms <MS>       Default call deadline in ms (default: 30000)
  --max-deadline-ms <MS>           Max call deadline in ms (default: 300000)
  --max-concurrent-reads <COUNT>   Max concurrent read calls per connection (default: 4)
  --max-state-bytes <BYTES>        Max state/journal directory quota in bytes
  -h, --help                       Print help and exit
  -V, --version                    Print version and exit
"
}

pub fn parse_args<I>(args: I) -> Result<CliConfig, ConfigError>
where
    I: IntoIterator<Item = String>,
{
    let raw: Vec<String> = args.into_iter().collect();
    let mut config_path: Option<PathBuf> = None;

    // First pass: find --help, --version, or --config
    let mut i = 0;
    while i < raw.len() {
        match raw[i].as_str() {
            "-h" | "--help" => {
                return Ok(CliConfig {
                    show_help: true,
                    ..CliConfig::default()
                });
            }
            "-V" | "--version" => {
                return Ok(CliConfig {
                    show_version: true,
                    ..CliConfig::default()
                });
            }
            "--config" => {
                i += 1;
                let val = raw
                    .get(i)
                    .ok_or_else(|| ConfigError::InvalidArgs("--config requires a path".into()))?;
                config_path = Some(PathBuf::from(val));
            }
            _ => {}
        }
        i += 1;
    }

    let mut cfg = CliConfig::default();
    if let Some(path) = config_path {
        let text = std::fs::read_to_string(path)?;
        let json_cfg: JsonHostConfig = serde_json::from_str(&text)?;
        apply_json_config(&mut cfg, json_cfg);
    }

    let mut cli_read_subpaths: Vec<String> = Vec::new();
    let mut cli_write_subpaths: Vec<String> = Vec::new();

    i = 0;
    if let Some(first) = raw.first().map(String::as_str) {
        match first {
            "serve" => {
                cfg.mode = CliMode::Serve;
                i = 1;
            }
            "mcp" => {
                cfg.mode = CliMode::Mcp;
                i = 1;
            }
            "exec" => {
                cfg.mode = CliMode::Exec;
                i = 1;
            }
            "log" => {
                cfg.mode = CliMode::Log;
                i = 1;
            }
            _ => {}
        }
    }

    while i < raw.len() {
        let arg = raw[i].as_str();
        if cfg.mode == CliMode::Exec {
            if arg == "--" {
                cfg.exec_command = raw[i + 1..].to_vec();
                break;
            } else if arg == "--root" {
                cfg.root = PathBuf::from(next_val(&raw, &mut i, "--root")?);
                i += 1;
                continue;
            } else if arg == "--timeout" {
                cfg.exec_timeout_ms = parse_u64(&raw, &mut i, "--timeout")?;
                i += 1;
                continue;
            } else if !arg.starts_with('-') {
                cfg.exec_command = raw[i..].to_vec();
                break;
            }
        }
        match arg {
            "--config" => {
                i += 1; // already processed
            }
            "--id" if cfg.mode == CliMode::Log => {
                cfg.log_id = Some(next_val(&raw, &mut i, "--id")?);
            }
            "--tail" if cfg.mode == CliMode::Log => {
                cfg.log_tail = Some(parse_usize(&raw, &mut i, "--tail")?);
            }
            "--grep" if cfg.mode == CliMode::Log => {
                cfg.log_grep = Some(next_val(&raw, &mut i, "--grep")?);
            }
            "--root" => {
                cfg.root = PathBuf::from(next_val(&raw, &mut i, "--root")?);
            }
            "--state-dir" => {
                cfg.state_dir = Some(PathBuf::from(next_val(&raw, &mut i, "--state-dir")?));
            }
            "--allow-write" => {
                cfg.allow_write = true;
            }
            "--read-only" => {
                cfg.allow_write = false;
            }
            "--read-subpath" => {
                cli_read_subpaths.push(next_val(&raw, &mut i, "--read-subpath")?);
            }
            "--write-subpath" => {
                cli_write_subpaths.push(next_val(&raw, &mut i, "--write-subpath")?);
            }
            "--deny-path" => {
                cfg.extra_secret_patterns
                    .push(next_val(&raw, &mut i, "--deny-path")?);
            }
            "--max-frame-bytes" => {
                cfg.limits.max_frame_bytes = parse_usize(&raw, &mut i, "--max-frame-bytes")?;
            }
            "--max-edit-file-bytes" => {
                cfg.limits.max_edit_file_bytes =
                    parse_usize(&raw, &mut i, "--max-edit-file-bytes")?;
            }
            "--max-batch-records" => {
                cfg.limits.max_batch_records = parse_usize(&raw, &mut i, "--max-batch-records")?;
            }
            "--max-output-bytes" => {
                cfg.limits.max_output_bytes_per_request =
                    parse_usize(&raw, &mut i, "--max-output-bytes")?;
            }
            "--default-deadline-ms" => {
                cfg.limits.default_deadline_ms = parse_u64(&raw, &mut i, "--default-deadline-ms")?;
            }
            "--max-deadline-ms" => {
                cfg.limits.max_deadline_ms = parse_u64(&raw, &mut i, "--max-deadline-ms")?;
            }
            "--max-concurrent-reads" => {
                cfg.limits.max_concurrent_reads_per_connection =
                    parse_usize(&raw, &mut i, "--max-concurrent-reads")?;
            }
            "--max-state-bytes" => {
                cfg.max_state_bytes = Some(parse_u64(&raw, &mut i, "--max-state-bytes")?);
            }
            other => {
                return Err(ConfigError::InvalidArgs(format!(
                    "unknown argument: {other}"
                )));
            }
        }
        i += 1;
    }

    if !cli_read_subpaths.is_empty() {
        cfg.read_subpaths = Some(cli_read_subpaths);
    }
    if !cli_write_subpaths.is_empty() {
        cfg.write_subpaths = Some(cli_write_subpaths);
    }

    if cfg.mode == CliMode::Mcp && cfg.allow_write && cfg.state_dir.is_none() {
        let base = std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
            .unwrap_or_else(std::env::temp_dir);
        cfg.state_dir = Some(base.join("ms").join("state"));
    }

    validate_config(&cfg)?;
    Ok(cfg)
}

fn apply_json_config(cfg: &mut CliConfig, json_cfg: JsonHostConfig) {
    if let Some(root) = json_cfg.root {
        cfg.root = root;
    }
    if json_cfg.state_dir.is_some() {
        cfg.state_dir = json_cfg.state_dir;
    }
    if let Some(aw) = json_cfg.allow_write {
        cfg.allow_write = aw;
    }
    if json_cfg.read_subpaths.is_some() {
        cfg.read_subpaths = json_cfg.read_subpaths;
    }
    if json_cfg.write_subpaths.is_some() {
        cfg.write_subpaths = json_cfg.write_subpaths;
    }
    if json_cfg.secret_patterns.is_some() {
        cfg.replace_secret_patterns = json_cfg.secret_patterns;
    }
    if json_cfg.max_state_bytes.is_some() {
        cfg.max_state_bytes = json_cfg.max_state_bytes;
    }
    if let Some(lim) = json_cfg.limits {
        if let Some(v) = lim.max_frame_bytes {
            cfg.limits.max_frame_bytes = v;
        }
        if let Some(v) = lim.max_edit_file_bytes {
            cfg.limits.max_edit_file_bytes = v;
        }
        if let Some(v) = lim.max_batch_records {
            cfg.limits.max_batch_records = v;
        }
        if let Some(v) = lim.max_output_bytes_per_request {
            cfg.limits.max_output_bytes_per_request = v;
        }
        if let Some(v) = lim.default_deadline_ms {
            cfg.limits.default_deadline_ms = v;
        }
        if let Some(v) = lim.max_deadline_ms {
            cfg.limits.max_deadline_ms = v;
        }
        if let Some(v) = lim.max_concurrent_reads_per_connection {
            cfg.limits.max_concurrent_reads_per_connection = v;
        }
        if let Some(v) = lim.max_concurrent_mutations_per_workspace {
            cfg.limits.max_concurrent_mutations_per_workspace = v;
        }
    }
}

fn validate_config(cfg: &CliConfig) -> Result<(), ConfigError> {
    if cfg.mode == CliMode::Exec {
        if cfg.exec_command.is_empty() {
            return Err(ConfigError::InvalidArgs(
                "ms exec requires a command after '--'".into(),
            ));
        }
        if !cfg.root.exists() || !cfg.root.is_dir() {
            return Err(ConfigError::Validation(format!(
                "workspace root does not exist or is not a directory: {}",
                cfg.root.display()
            )));
        }
        return Ok(());
    }
    if cfg.mode == CliMode::Log {
        if cfg.log_id.as_deref().is_none_or(str::is_empty) {
            return Err(ConfigError::InvalidArgs("ms log requires --id <ID>".into()));
        }
        return Ok(());
    }
    if !cfg.root.exists() || !cfg.root.is_dir() {
        return Err(ConfigError::Validation(format!(
            "workspace root does not exist or is not a directory: {}",
            cfg.root.display()
        )));
    }
    if cfg.allow_write && cfg.state_dir.is_none() {
        return Err(ConfigError::Validation(
            "--state-dir is required when --allow-write is enabled".into(),
        ));
    }
    if cfg.limits.max_frame_bytes == 0
        || cfg.limits.max_batch_records == 0
        || cfg.limits.max_output_bytes_per_request == 0
        || cfg.limits.default_deadline_ms == 0
        || cfg.limits.max_deadline_ms == 0
        || cfg.limits.max_concurrent_reads_per_connection == 0
    {
        return Err(ConfigError::Validation(
            "limits must be greater than zero".into(),
        ));
    }
    if cfg.limits.default_deadline_ms > cfg.limits.max_deadline_ms {
        return Err(ConfigError::Validation(
            "defaultDeadlineMs cannot exceed maxDeadlineMs".into(),
        ));
    }
    Ok(())
}

fn next_val(raw: &[String], i: &mut usize, flag: &str) -> Result<String, ConfigError> {
    *i += 1;
    raw.get(*i)
        .cloned()
        .ok_or_else(|| ConfigError::InvalidArgs(format!("{flag} requires a value")))
}

fn parse_usize(raw: &[String], i: &mut usize, flag: &str) -> Result<usize, ConfigError> {
    let val = next_val(raw, i, flag)?;
    val.parse::<usize>()
        .map_err(|_| ConfigError::InvalidArgs(format!("{flag} expects a positive integer")))
}

fn parse_u64(raw: &[String], i: &mut usize, flag: &str) -> Result<u64, ConfigError> {
    let val = next_val(raw, i, flag)?;
    val.parse::<u64>()
        .map_err(|_| ConfigError::InvalidArgs(format!("{flag} expects a positive integer")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ms-cli-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rejects_allow_write_without_state_dir() {
        let dir = make_temp_dir("no-state");
        let res = parse_args([
            "--root".to_string(),
            dir.to_string_lossy().into_owned(),
            "--allow-write".to_string(),
        ]);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(res.is_err());
    }

    #[test]
    fn parses_json_config_and_cli_overrides() {
        let dir = make_temp_dir("json-cfg");
        let state = make_temp_dir("json-state");
        let cfg_file = dir.join("ms.json");
        std::fs::write(
            &cfg_file,
            serde_json::json!({
                "root": dir,
                "stateDir": state,
                "allowWrite": false,
                "limits": {
                    "maxBatchRecords": 64
                }
            })
            .to_string(),
        )
        .unwrap();

        let cfg = parse_args([
            "--config".to_string(),
            cfg_file.to_string_lossy().into_owned(),
            "--allow-write".to_string(),
            "--max-output-bytes".to_string(),
            "4096".to_string(),
        ])
        .unwrap();

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&state);

        assert!(cfg.allow_write);
        assert_eq!(cfg.limits.max_batch_records, 64);
        assert_eq!(cfg.limits.max_output_bytes_per_request, 4096);
    }

    #[test]
    fn rejects_nonexistent_root() {
        let res = parse_args([
            "--root".to_string(),
            "/nonexistent/path/that/does/not/exist".to_string(),
        ]);
        assert!(res.is_err());
    }
}
