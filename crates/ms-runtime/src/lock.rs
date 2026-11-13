use std::fs::{self, File, OpenOptions};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;

use rustix::fs::{FlockOperation, flock};
use rustix::io::Errno;

use crate::error::RuntimeError;

/// Cooperative single-writer workspace lease keyed by root `(dev, ino)`.
///
/// Uses `flock(LOCK_EX | LOCK_NB)` on `<state_dir>/locks/<dev>_<ino>.lock` (mode 0600),
/// so two `Runtime` instances targeting the same workspace (even via symlink aliases)
/// cannot hold concurrent write authority.
#[derive(Debug)]
pub struct WorkspaceLease {
    _lock_file: File,
}

impl WorkspaceLease {
    /// Ensures `dir` exists with mode `0700`.
    pub fn ensure_private_dir(dir: &Path) -> Result<(), RuntimeError> {
        if !dir.exists() {
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(dir)
                .map_err(|e| {
                    RuntimeError::Io(format!("create state dir '{}': {e}", dir.display()))
                })?;
        }
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(|e| {
            RuntimeError::Io(format!("set 0700 permissions on '{}': {e}", dir.display()))
        })?;
        Ok(())
    }

    /// Acquires the exclusive non-blocking cooperative write lease for `(root_dev, root_ino)`.
    pub fn acquire(state_dir: &Path, root_dev: u64, root_ino: u64) -> Result<Self, RuntimeError> {
        Self::ensure_private_dir(state_dir)?;
        let locks_dir = state_dir.join("locks");
        Self::ensure_private_dir(&locks_dir)?;

        let lock_path = locks_dir.join(format!("{root_dev}_{root_ino}.lock"));
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .mode(0o600)
            .open(&lock_path)
            .map_err(|e| RuntimeError::Io(format!("open workspace lock file: {e}")))?;

        fs::set_permissions(&lock_path, fs::Permissions::from_mode(0o600))
            .map_err(|e| RuntimeError::Io(format!("chmod workspace lock file: {e}")))?;

        match flock(&file, FlockOperation::NonBlockingLockExclusive) {
            Ok(()) => Ok(Self { _lock_file: file }),
            Err(Errno::WOULDBLOCK) => Err(RuntimeError::WorkspaceLocked(format!(
                "another runtime instance holds the write lease for workspace ({root_dev}:{root_ino})"
            ))),
            Err(e) => Err(RuntimeError::Io(format!("flock workspace lock: {e}"))),
        }
    }
}
