use std::path::PathBuf;

use ms_protocol::{HardLimits, SessionCapabilities, normalize_relative_path};

use crate::error::RuntimeError;

/// Default maximum state directory size (64 MiB).
pub const DEFAULT_MAX_STATE_BYTES: u64 = 64 * 1024 * 1024;

/// Default secret filename/directory patterns denied across list, search, read, and patch.
pub fn default_secret_patterns() -> Vec<String> {
    vec![
        ".env".to_string(),
        ".env.*".to_string(),
        "*.pem".to_string(),
        "*.key".to_string(),
        "*.p12".to_string(),
        "*.pfx".to_string(),
        "id_rsa".to_string(),
        "id_rsa.*".to_string(),
        "id_ed25519".to_string(),
        "id_ed25519.*".to_string(),
        ".npmrc".to_string(),
        ".netrc".to_string(),
        ".aws".to_string(),
        ".ssh".to_string(),
        "secrets".to_string(),
        "secrets.*".to_string(),
    ]
}

/// Host-provided runtime configuration. Clients cannot widen these capabilities.
#[derive(Debug, Clone)]
pub struct HostConfig {
    pub workspace_root: PathBuf,
    pub state_dir: PathBuf,
    pub allow_write: bool,
    pub read_subpaths: Option<Vec<String>>,
    pub write_subpaths: Option<Vec<String>>,
    pub secret_patterns: Vec<String>,
    pub limits: HardLimits,
    pub max_state_bytes: u64,
}

impl HostConfig {
    /// Creates a new `HostConfig` with safe defaults (read-only by default).
    #[must_use]
    pub fn new(workspace_root: impl Into<PathBuf>, state_dir: impl Into<PathBuf>) -> Self {
        Self {
            workspace_root: workspace_root.into(),
            state_dir: state_dir.into(),
            allow_write: false,
            read_subpaths: None,
            write_subpaths: None,
            secret_patterns: default_secret_patterns(),
            limits: HardLimits::default(),
            max_state_bytes: DEFAULT_MAX_STATE_BYTES,
        }
    }

    #[must_use]
    pub fn with_allow_write(mut self, allow_write: bool) -> Self {
        self.allow_write = allow_write;
        self
    }

    #[must_use]
    pub fn with_read_subpaths(mut self, subpaths: Option<Vec<String>>) -> Self {
        self.read_subpaths = subpaths;
        self
    }

    #[must_use]
    pub fn with_write_subpaths(mut self, subpaths: Option<Vec<String>>) -> Self {
        self.write_subpaths = subpaths;
        self
    }

    #[must_use]
    pub fn with_limits(mut self, limits: HardLimits) -> Self {
        self.limits = limits;
        self
    }

    #[must_use]
    pub fn with_max_state_bytes(mut self, max_state_bytes: u64) -> Self {
        self.max_state_bytes = max_state_bytes;
        self
    }
}

/// Effective capability policy for a session (host policy narrowed by session request).
#[derive(Debug, Clone)]
pub struct EffectivePolicy {
    pub allow_write: bool,
    pub read_subpaths: Option<Vec<String>>,
    pub write_subpaths: Option<Vec<String>>,
    pub secret_patterns: Vec<String>,
    pub state_rel_prefix: Option<String>,
    pub limits: HardLimits,
}

impl EffectivePolicy {
    /// Builds the host-level baseline policy, validating configured subpaths.
    pub fn from_host(
        config: &HostConfig,
        state_rel_prefix: Option<String>,
    ) -> Result<Self, RuntimeError> {
        let read_subpaths = normalize_subpaths(config.read_subpaths.as_deref())?;
        let write_subpaths = normalize_subpaths(config.write_subpaths.as_deref())?;
        Ok(Self {
            allow_write: config.allow_write,
            read_subpaths,
            write_subpaths,
            secret_patterns: config.secret_patterns.clone(),
            state_rel_prefix,
            limits: config.limits.clone(),
        })
    }

    /// Narrows the host policy with optional session capabilities.
    /// Rejects any attempt to widen `allow_write`, `read_subpaths`, or `write_subpaths`.
    pub fn narrow(&self, req: Option<&SessionCapabilities>) -> Result<Self, RuntimeError> {
        let Some(req) = req else {
            return Ok(self.clone());
        };

        let allow_write = match req.allow_write {
            Some(true) if !self.allow_write => {
                return Err(RuntimeError::policy_denied_with_hint(
                    "session requested allowWrite=true, but host policy forbids writes",
                    "Host must grant write capability; clients cannot escalate privileges.",
                ));
            }
            Some(v) => v && self.allow_write,
            None => self.allow_write,
        };

        let read_subpaths = match &req.read_subpaths {
            Some(req_paths) => {
                let norm = normalize_subpaths(Some(req_paths))?.unwrap_or_default();
                if let Some(host_paths) = &self.read_subpaths {
                    for p in &norm {
                        if !is_covered_by(p, host_paths) {
                            return Err(RuntimeError::policy_denied(format!(
                                "requested read subpath '{p}' widens host read policy"
                            )));
                        }
                    }
                }
                Some(norm)
            }
            None => self.read_subpaths.clone(),
        };

        let write_subpaths = match &req.write_subpaths {
            Some(req_paths) => {
                let norm = normalize_subpaths(Some(req_paths))?.unwrap_or_default();
                if let Some(host_paths) = &self.write_subpaths {
                    for p in &norm {
                        if !is_covered_by(p, host_paths) {
                            return Err(RuntimeError::policy_denied(format!(
                                "requested write subpath '{p}' widens host write policy"
                            )));
                        }
                    }
                }
                Some(norm)
            }
            None => self.write_subpaths.clone(),
        };

        let limits = match &req.limits {
            Some(client_limits) => self.limits.narrow(client_limits),
            None => self.limits.clone(),
        };

        Ok(Self {
            allow_write,
            read_subpaths,
            write_subpaths,
            secret_patterns: self.secret_patterns.clone(),
            state_rel_prefix: self.state_rel_prefix.clone(),
            limits,
        })
    }

    /// Returns true if the relative path is unconditionally denied (`.git`, state dir, or secret).
    #[must_use]
    pub fn is_denied_path(&self, rel_path: &str) -> bool {
        let Ok(norm) = normalize_for_policy(rel_path) else {
            return true;
        };
        if norm.is_empty() {
            return false;
        }
        // Deny .git anywhere in path components
        if norm.split('/').any(|seg| seg == ".git") {
            return true;
        }
        // Deny state_dir if it resides inside workspace_root
        if let Some(prefix) = &self.state_rel_prefix
            && is_under_prefix(&norm, prefix)
        {
            return true;
        }
        // Deny secret patterns against any path segment
        for seg in norm.split('/') {
            if matches_any_pattern(seg, &self.secret_patterns) {
                return true;
            }
        }
        false
    }

    /// Checks whether a relative path (or `.` for root) is authorized for reading.
    pub fn check_read(&self, rel_path: &str) -> Result<(), RuntimeError> {
        let norm = normalize_for_policy(rel_path)?;
        if self.is_denied_path(&norm) {
            return Err(RuntimeError::policy_denied(format!(
                "read access denied for protected path '{rel_path}'"
            )));
        }
        if let Some(allowed) = &self.read_subpaths {
            if norm.is_empty() {
                // Listing/searching root is allowed; individual entries will be filtered by read_subpaths.
                return Ok(());
            }
            if !is_covered_by(&norm, allowed) {
                return Err(RuntimeError::policy_denied(format!(
                    "read access denied for '{rel_path}': outside allowed read subpaths"
                )));
            }
        }
        Ok(())
    }

    /// Returns true if a directory at `rel_path` might contain or be an allowed read subpath
    /// (used during directory traversal to prune disallowed subtrees without leaking them).
    #[must_use]
    pub fn may_traverse_dir(&self, rel_path: &str) -> bool {
        let Ok(norm) = normalize_for_policy(rel_path) else {
            return false;
        };
        if self.is_denied_path(&norm) {
            return false;
        }
        let Some(allowed) = &self.read_subpaths else {
            return true;
        };
        if norm.is_empty() {
            return true;
        }
        // Either norm is under an allowed prefix, OR an allowed prefix is under norm.
        allowed
            .iter()
            .any(|a| is_under_prefix(&norm, a) || is_under_prefix(a, &norm))
    }

    /// Checks whether a relative path is authorized for writing.
    pub fn check_write(&self, rel_path: &str) -> Result<(), RuntimeError> {
        if !self.allow_write {
            return Err(RuntimeError::policy_denied_with_hint(
                "write operation denied: session/host is read-only",
                "Open a write-enabled session if the host allows writes.",
            ));
        }
        let norm = normalize_for_policy(rel_path)?;
        if norm.is_empty() {
            return Err(RuntimeError::policy_denied(
                "cannot write to workspace root directory",
            ));
        }
        if self.is_denied_path(&norm) {
            return Err(RuntimeError::policy_denied(format!(
                "write access denied for protected path '{rel_path}'"
            )));
        }
        if let Some(allowed_read) = &self.read_subpaths
            && !is_covered_by(&norm, allowed_read)
        {
            return Err(RuntimeError::policy_denied(format!(
                "write access denied for '{rel_path}': outside allowed read subpaths"
            )));
        }
        if let Some(allowed_write) = &self.write_subpaths
            && !is_covered_by(&norm, allowed_write)
        {
            return Err(RuntimeError::policy_denied(format!(
                "write access denied for '{rel_path}': outside allowed write subpaths"
            )));
        }
        Ok(())
    }
}

fn normalize_for_policy(rel_path: &str) -> Result<String, RuntimeError> {
    if rel_path.is_empty() || rel_path == "." {
        return Ok(String::new());
    }
    let norm = normalize_relative_path(rel_path)?;
    if norm == "." {
        Ok(String::new())
    } else {
        Ok(norm)
    }
}

fn normalize_subpaths(paths: Option<&[String]>) -> Result<Option<Vec<String>>, RuntimeError> {
    let Some(paths) = paths else {
        return Ok(None);
    };
    let mut out = Vec::with_capacity(paths.len());
    for raw in paths {
        if raw == "." {
            out.push(String::new());
            continue;
        }
        let norm = normalize_relative_path(raw)?;
        out.push(if norm == "." { String::new() } else { norm });
    }
    Ok(Some(out))
}

fn is_under_prefix(path: &str, prefix: &str) -> bool {
    if prefix.is_empty() {
        return true;
    }
    path == prefix
        || (path.len() > prefix.len()
            && path.starts_with(prefix)
            && path.as_bytes()[prefix.len()] == b'/')
}

fn is_covered_by(path: &str, allowed: &[String]) -> bool {
    allowed.iter().any(|prefix| is_under_prefix(path, prefix))
}

fn matches_any_pattern(segment: &str, patterns: &[String]) -> bool {
    patterns.iter().any(|pat| glob_match_simple(pat, segment))
}

/// Simple glob matcher supporting `*` wildcards (e.g. `.env.*`, `*.pem`, `id_rsa.*`).
fn glob_match_simple(pattern: &str, text: &str) -> bool {
    if !pattern.contains('*') {
        return pattern == text;
    }
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 2 {
        let (prefix, suffix) = (parts[0], parts[1]);
        return text.len() >= prefix.len() + suffix.len()
            && text.starts_with(prefix)
            && text.ends_with(suffix);
    }
    // General multi-star match
    let mut rest = text;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        if i == 0 {
            if !rest.starts_with(part) {
                return false;
            }
            rest = &rest[part.len()..];
        } else if i == parts.len() - 1 {
            return rest.ends_with(part);
        } else if let Some(idx) = rest.find(part) {
            rest = &rest[idx + part.len()..];
        } else {
            return false;
        }
    }
    true
}
