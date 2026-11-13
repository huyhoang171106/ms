use std::fs::File;
use std::os::fd::{AsFd, OwnedFd};
use std::path::{Path, PathBuf};

use ms_protocol::validate_relative_path;
use rustix::fs::{
    AtFlags, FileType, Mode, OFlags, ResolveFlags, Stat, fchmod, fstat, fsync, openat2, renameat,
    unlinkat,
};
use rustix::io::Errno;

use crate::error::RuntimeError;

/// Metadata snapshot of an existing regular file targeted for an atomic write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WriteTargetMeta {
    pub dev: u64,
    pub ino: u64,
    pub mode: u32,
    pub uid: u32,
}

/// Capability-confined Linux filesystem access rooted at a single directory FD.
///
/// Uses `openat2` with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS` for every path
/// resolution and fails closed if `openat2` is unsupported by the kernel.
#[derive(Debug)]
pub struct WorkspaceFs {
    root_path: PathBuf,
    root_fd: OwnedFd,
    root_dev: u64,
    root_ino: u64,
}

impl WorkspaceFs {
    /// Opens the workspace root directory and probes `openat2` support.
    pub fn open_root(root_path: &Path) -> Result<Self, RuntimeError> {
        let root_fd = rustix::fs::open(
            root_path,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|e| map_errno("open workspace root", e))?;

        let st = fstat(&root_fd).map_err(|e| map_errno("fstat workspace root", e))?;
        if FileType::from_raw_mode(st.st_mode) != FileType::Directory {
            return Err(RuntimeError::InvalidRequest(
                "workspace root is not a directory".to_string(),
            ));
        }

        // Probe openat2 with RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS; fail closed if unsupported.
        let probe = openat2(
            &root_fd,
            ".",
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
            ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS,
        );
        match probe {
            Ok(_) => {}
            Err(Errno::NOSYS | Errno::OPNOTSUPP) => {
                return Err(RuntimeError::Unsupported(
                    "Linux openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS) is unsupported on this kernel; refusing silent fallback".to_string(),
                ));
            }
            Err(e) => return Err(map_errno("probe openat2", e)),
        }

        Ok(Self {
            root_path: root_path.to_path_buf(),
            root_fd,
            root_dev: st.st_dev,
            root_ino: st.st_ino,
        })
    }

    #[must_use]
    pub fn root_path(&self) -> &Path {
        &self.root_path
    }

    /// Returns `(st_dev, st_ino)` of the workspace root directory.
    #[must_use]
    pub const fn root_identity(&self) -> (u64, u64) {
        (self.root_dev, self.root_ino)
    }

    /// Opens an existing regular file for reading, enforcing `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS`
    /// and rejecting symlinks, directories, FIFOs, sockets, and device nodes.
    pub fn open_file_read(&self, rel_path: &str) -> Result<(OwnedFd, Stat), RuntimeError> {
        validate_relative_path(rel_path)?;
        let fd = openat2(
            &self.root_fd,
            rel_path,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
            ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS,
        )
        .map_err(|e| map_open_errno(rel_path, e))?;

        let st = fstat(&fd).map_err(|e| map_errno("fstat target", e))?;
        let ft = FileType::from_raw_mode(st.st_mode);
        if ft != FileType::RegularFile {
            return Err(RuntimeError::policy_denied(format!(
                "path '{rel_path}' is not a regular file (found {ft:?})"
            )));
        }
        Ok((fd, st))
    }

    /// Opens a directory under the workspace root with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS`.
    pub fn open_dir(&self, rel_path: &str) -> Result<OwnedFd, RuntimeError> {
        let target = if rel_path.is_empty() || rel_path == "." {
            "."
        } else {
            validate_relative_path(rel_path)?;
            rel_path
        };
        let fd = openat2(
            &self.root_fd,
            target,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
            ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS,
        )
        .map_err(|e| map_open_errno(target, e))?;

        let st = fstat(&fd).map_err(|e| map_errno("fstat dir", e))?;
        if FileType::from_raw_mode(st.st_mode) != FileType::Directory {
            return Err(RuntimeError::InvalidRequest(format!(
                "path '{target}' is not a directory"
            )));
        }
        Ok(fd)
    }

    /// Reads an opened regular file up to `max_bytes`, returning `EResourceLimit` if exceeded.
    pub fn read_bounded(&self, fd: &OwnedFd, max_bytes: usize) -> Result<Vec<u8>, RuntimeError> {
        let st = fstat(fd).map_err(|e| map_errno("fstat read", e))?;
        if st.st_size < 0 {
            return Err(RuntimeError::Io("negative file size".to_string()));
        }
        if (st.st_size as u64) > (max_bytes as u64) {
            return Err(RuntimeError::ResourceLimit(format!(
                "file size ({} bytes) exceeds limit ({max_bytes} bytes)",
                st.st_size
            )));
        }

        let cap = (st.st_size as usize).min(max_bytes);
        let mut buf = Vec::with_capacity(cap);
        let mut chunk = [0u8; 64 * 1024];
        loop {
            match rustix::io::read(fd, &mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    if buf.len().saturating_add(n) > max_bytes {
                        return Err(RuntimeError::ResourceLimit(format!(
                            "file size exceeds limit ({max_bytes} bytes)"
                        )));
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                Err(Errno::INTR) => continue,
                Err(e) => return Err(map_errno("read file", e)),
            }
        }
        Ok(buf)
    }

    /// Opens and reads a regular file safely, returning `(bytes, stat)`.
    pub fn read_file_bytes(
        &self,
        rel_path: &str,
        max_bytes: usize,
    ) -> Result<(Vec<u8>, Stat), RuntimeError> {
        let (fd, st) = self.open_file_read(rel_path)?;
        let bytes = self.read_bounded(&fd, max_bytes)?;
        Ok((bytes, st))
    }

    /// Validates that `rel_path` is a writable regular file (single link, owned by current UID,
    /// no setuid/setgid bits) and returns its identity/mode snapshot.
    pub fn validate_write_target(&self, rel_path: &str) -> Result<WriteTargetMeta, RuntimeError> {
        let (_fd, st) = self.open_file_read(rel_path)?;
        check_writable_stat(rel_path, &st)
    }

    /// Stages `new_bytes` into a temporary file in the target's parent directory, fsyncs it,
    /// revalidates the target's `(dev, ino)` and metadata, atomically renames, and fsyncs the directory.
    pub fn atomic_stage_and_replace(
        &self,
        rel_path: &str,
        expected_meta: &WriteTargetMeta,
        new_bytes: &[u8],
        temp_name: &str,
    ) -> Result<(), RuntimeError> {
        let (parent_fd, leaf_name) = self.open_parent_dir(rel_path)?;
        let mode = Mode::from_raw_mode(expected_meta.mode);

        let tmp_fd = openat2(
            &parent_fd,
            temp_name,
            OFlags::CREATE | OFlags::EXCL | OFlags::WRONLY | OFlags::CLOEXEC,
            mode,
            ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS,
        )
        .map_err(|e| map_open_errno(temp_name, e))?;

        let stage_res = (|| -> Result<(), RuntimeError> {
            // Ensure exact mode regardless of process umask.
            fchmod(&tmp_fd, mode).map_err(|e| map_errno("fchmod temp file", e))?;
            write_all_fd(tmp_fd.as_fd(), new_bytes)?;
            fsync(&tmp_fd).map_err(|e| map_errno("fsync temp file", e))?;
            Ok(())
        })();

        drop(tmp_fd);

        if let Err(e) = stage_res {
            let _ = unlinkat(&parent_fd, temp_name, AtFlags::empty());
            return Err(e);
        }

        // Revalidate target before atomic rename.
        let reval = self.open_file_read(rel_path);
        match reval {
            Ok((_tfd, st)) => {
                let current_meta = match check_writable_stat(rel_path, &st) {
                    Ok(m) => m,
                    Err(e) => {
                        let _ = unlinkat(&parent_fd, temp_name, AtFlags::empty());
                        return Err(e);
                    }
                };
                if current_meta.dev != expected_meta.dev || current_meta.ino != expected_meta.ino {
                    let _ = unlinkat(&parent_fd, temp_name, AtFlags::empty());
                    return Err(RuntimeError::conflict(
                        "target file was replaced externally during staging",
                        "Re-read the file and retry.",
                    ));
                }
            }
            Err(e) => {
                let _ = unlinkat(&parent_fd, temp_name, AtFlags::empty());
                return Err(RuntimeError::conflict(
                    format!("target file could not be revalidated before rename: {e}"),
                    "Re-read the file and retry.",
                ));
            }
        }

        if let Err(e) = renameat(&parent_fd, temp_name, &parent_fd, leaf_name.as_str()) {
            let _ = unlinkat(&parent_fd, temp_name, AtFlags::empty());
            return Err(map_errno("rename temp file over target", e));
        }

        fsync(&parent_fd).map_err(|e| map_errno("fsync parent directory", e))?;
        Ok(())
    }

    /// Best-effort cleanup of an orphaned temp file in `rel_path`'s parent directory.
    pub fn cleanup_temp_file(&self, rel_path: &str, temp_name: &str) {
        if let Ok((parent_fd, _)) = self.open_parent_dir(rel_path) {
            let _ = unlinkat(&parent_fd, temp_name, AtFlags::empty());
        }
    }

    fn open_parent_dir(&self, rel_path: &str) -> Result<(OwnedFd, String), RuntimeError> {
        validate_relative_path(rel_path)?;
        match rel_path.rsplit_once('/') {
            Some((parent, leaf)) => {
                if leaf.is_empty() || leaf == "." || leaf == ".." {
                    return Err(RuntimeError::InvalidRequest(format!(
                        "invalid target filename in '{rel_path}'"
                    )));
                }
                let pfd = self.open_dir(parent)?;
                Ok((pfd, leaf.to_string()))
            }
            None => {
                if rel_path == "." || rel_path == ".." {
                    return Err(RuntimeError::InvalidRequest(format!(
                        "invalid target filename '{rel_path}'"
                    )));
                }
                let pfd = self.open_dir(".")?;
                Ok((pfd, rel_path.to_string()))
            }
        }
    }
}

fn check_writable_stat(rel_path: &str, st: &Stat) -> Result<WriteTargetMeta, RuntimeError> {
    if FileType::from_raw_mode(st.st_mode) != FileType::RegularFile {
        return Err(RuntimeError::policy_denied(format!(
            "target '{rel_path}' is not a regular file"
        )));
    }
    if st.st_nlink > 1 {
        return Err(RuntimeError::policy_denied_with_hint(
            format!(
                "refusing to patch '{rel_path}': file has {} hardlinks (nlink > 1)",
                st.st_nlink
            ),
            "Multi-link hardlinks are rejected to prevent unintended mutations to aliased paths.",
        ));
    }
    let my_uid = rustix::process::getuid().as_raw();
    if st.st_uid != my_uid {
        return Err(RuntimeError::policy_denied(format!(
            "refusing to patch '{rel_path}': file owner (uid {}) differs from runtime uid ({my_uid})",
            st.st_uid
        )));
    }
    if (st.st_mode & 0o6000) != 0 {
        return Err(RuntimeError::policy_denied(format!(
            "refusing to patch '{rel_path}': setuid/setgid files are not permitted"
        )));
    }
    Ok(WriteTargetMeta {
        dev: st.st_dev,
        ino: st.st_ino,
        mode: st.st_mode & 0o777,
        uid: st.st_uid,
    })
}

pub fn write_all_fd(fd: rustix::fd::BorrowedFd<'_>, mut data: &[u8]) -> Result<(), RuntimeError> {
    while !data.is_empty() {
        match rustix::io::write(fd, data) {
            Ok(0) => {
                return Err(RuntimeError::Io(
                    "short write (0 bytes written)".to_string(),
                ));
            }
            Ok(n) => data = &data[n..],
            Err(Errno::INTR) => continue,
            Err(e) => return Err(map_errno("write", e)),
        }
    }
    Ok(())
}

/// Writes a `File` completely and fsyncs it (used for state/journal files).
pub fn write_and_sync_file(file: &mut File, data: &[u8]) -> Result<(), RuntimeError> {
    use std::io::Write;
    file.write_all(data)
        .map_err(|e| RuntimeError::Io(format!("write state file: {e}")))?;
    file.sync_all()
        .map_err(|e| RuntimeError::Io(format!("fsync state file: {e}")))?;
    Ok(())
}

fn map_open_errno(path: &str, e: Errno) -> RuntimeError {
    match e {
        Errno::NOENT => RuntimeError::NotFound(format!("path not found: '{path}'")),
        Errno::NOTDIR => RuntimeError::NotFound(format!("parent is not a directory: '{path}'")),
        Errno::LOOP | Errno::XDEV => RuntimeError::policy_denied_with_hint(
            format!("access denied for '{path}': symlink or workspace escape blocked"),
            "Symlinks and '..' traversal are forbidden.",
        ),
        Errno::ACCESS | Errno::PERM => {
            RuntimeError::policy_denied(format!("permission denied for '{path}'"))
        }
        Errno::NOSYS | Errno::OPNOTSUPP => RuntimeError::Unsupported(
            "openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS) is unsupported".to_string(),
        ),
        other => RuntimeError::Io(format!("open '{path}': {other}")),
    }
}

fn map_errno(op: &str, e: Errno) -> RuntimeError {
    match e {
        Errno::ACCESS | Errno::PERM => RuntimeError::policy_denied(format!("{op}: {e}")),
        Errno::NOENT => RuntimeError::NotFound(format!("{op}: {e}")),
        Errno::NOSPC | Errno::DQUOT => {
            RuntimeError::ResourceLimit(format!("{op}: disk/quota exhausted ({e})"))
        }
        other => RuntimeError::Io(format!("{op}: {other}")),
    }
}
