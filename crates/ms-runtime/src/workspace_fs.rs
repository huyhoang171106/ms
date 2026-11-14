use std::fs::File;
use std::os::fd::{AsFd, OwnedFd};
use std::path::{Path, PathBuf};

use ms_protocol::normalize_relative_path;
use rustix::fs::{
    AtFlags, FileType, Mode, OFlags, ResolveFlags, Stat, fchmod, fstat, fsync, mkdirat, openat2,
    renameat, unlinkat,
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
        let norm = normalize_relative_path(rel_path)?;
        let fd = openat2(
            &self.root_fd,
            &norm,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
            ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS,
        )
        .map_err(|e| map_open_errno(&norm, e))?;

        let st = fstat(&fd).map_err(|e| map_errno("fstat target", e))?;
        let ft = FileType::from_raw_mode(st.st_mode);
        if ft != FileType::RegularFile {
            return Err(RuntimeError::policy_denied(format!(
                "path '{norm}' is not a regular file (found {ft:?})"
            )));
        }
        Ok((fd, st))
    }

    /// Opens a directory under the workspace root with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS`.
    pub fn open_dir(&self, rel_path: &str) -> Result<OwnedFd, RuntimeError> {
        let target = if rel_path.is_empty() || rel_path == "." {
            ".".to_string()
        } else {
            normalize_relative_path(rel_path)?
        };
        let fd = openat2(
            &self.root_fd,
            &target,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
            ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS,
        )
        .map_err(|e| map_open_errno(&target, e))?;

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

    /// Creates missing parent directories for `rel_path` safely under `root_fd` using `openat2(BENEATH | NO_SYMLINKS)`.
    pub fn ensure_parent_dirs(&self, rel_path: &str) -> Result<(), RuntimeError> {
        let norm = normalize_relative_path(rel_path)?;
        let Some((parent, _)) = norm.rsplit_once('/') else {
            return Ok(());
        };
        let mut cur_fd = self.open_dir(".")?;
        for seg in parent.split('/') {
            if seg.is_empty() || seg == "." {
                continue;
            }
            match openat2(
                &cur_fd,
                seg,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
                ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS,
            ) {
                Ok(next_fd) => {
                    cur_fd = next_fd;
                }
                Err(Errno::NOENT) => {
                    mkdirat(&cur_fd, seg, Mode::from_raw_mode(0o755))
                        .map_err(|e| map_errno("mkdirat parent dir", e))?;
                    fsync(&cur_fd).map_err(|e| map_errno("fsync parent dir after mkdir", e))?;
                    cur_fd = openat2(
                        &cur_fd,
                        seg,
                        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                        Mode::empty(),
                        ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS,
                    )
                    .map_err(|e| map_open_errno(seg, e))?;
                }
                Err(e) => return Err(map_open_errno(seg, e)),
            }
        }
        Ok(())
    }

    /// Atomically creates a new regular file at `rel_path` (which must not already exist).
    pub fn atomic_create_new(
        &self,
        rel_path: &str,
        new_bytes: &[u8],
        temp_name: &str,
    ) -> Result<WriteTargetMeta, RuntimeError> {
        self.ensure_parent_dirs(rel_path)?;
        let (parent_fd, leaf_name) = self.open_parent_dir(rel_path)?;
        let mode = Mode::from_raw_mode(0o644);

        let tmp_fd = openat2(
            &parent_fd,
            temp_name,
            OFlags::CREATE | OFlags::EXCL | OFlags::WRONLY | OFlags::CLOEXEC,
            mode,
            ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS,
        )
        .map_err(|e| map_open_errno(temp_name, e))?;

        let stage_res = (|| -> Result<(), RuntimeError> {
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

        // Ensure target still does not exist before rename.
        match openat2(
            &parent_fd,
            leaf_name.as_str(),
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
            ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS,
        ) {
            Err(Errno::NOENT) => {}
            Ok(_) => {
                let _ = unlinkat(&parent_fd, temp_name, AtFlags::empty());
                return Err(RuntimeError::conflict(
                    format!("target '{rel_path}' already exists"),
                    "Set overwrite=true or pass expectedRevision.",
                ));
            }
            Err(e) => {
                let _ = unlinkat(&parent_fd, temp_name, AtFlags::empty());
                return Err(map_open_errno(rel_path, e));
            }
        }

        if let Err(e) = renameat(&parent_fd, temp_name, &parent_fd, leaf_name.as_str()) {
            let _ = unlinkat(&parent_fd, temp_name, AtFlags::empty());
            return Err(map_errno("rename temp file to new target", e));
        }
        fsync(&parent_fd).map_err(|e| map_errno("fsync parent directory", e))?;

        self.validate_write_target(rel_path)
    }

    /// Atomically deletes an existing regular file after revalidating `(dev, ino)`.
    pub fn atomic_delete(
        &self,
        rel_path: &str,
        expected_meta: &WriteTargetMeta,
    ) -> Result<(), RuntimeError> {
        let (parent_fd, leaf_name) = self.open_parent_dir(rel_path)?;
        let (_fd, st) = self.open_file_read(rel_path)?;
        let current_meta = check_writable_stat(rel_path, &st)?;
        if current_meta.dev != expected_meta.dev || current_meta.ino != expected_meta.ino {
            return Err(RuntimeError::conflict(
                "target file was replaced externally before delete",
                "Re-read the file and retry.",
            ));
        }
        unlinkat(&parent_fd, leaf_name.as_str(), AtFlags::empty())
            .map_err(|e| map_errno("unlink target file", e))?;
        fsync(&parent_fd).map_err(|e| map_errno("fsync parent directory", e))?;
        Ok(())
    }

    /// Atomically renames `from_rel` to `to_rel` after revalidating `(dev, ino)`.
    pub fn atomic_rename(
        &self,
        from_rel: &str,
        to_rel: &str,
        expected_meta: &WriteTargetMeta,
        overwrite: bool,
    ) -> Result<(), RuntimeError> {
        self.ensure_parent_dirs(to_rel)?;
        let (from_parent, from_leaf) = self.open_parent_dir(from_rel)?;
        let (to_parent, to_leaf) = self.open_parent_dir(to_rel)?;

        let (_fd, st) = self.open_file_read(from_rel)?;
        let current_meta = check_writable_stat(from_rel, &st)?;
        if current_meta.dev != expected_meta.dev || current_meta.ino != expected_meta.ino {
            return Err(RuntimeError::conflict(
                "source file was replaced externally before rename",
                "Re-read the file and retry.",
            ));
        }

        if !overwrite {
            match openat2(
                &to_parent,
                to_leaf.as_str(),
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
                Mode::empty(),
                ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS,
            ) {
                Err(Errno::NOENT) => {}
                Ok(_) => {
                    return Err(RuntimeError::conflict(
                        format!("destination '{to_rel}' already exists"),
                        "Set overwrite=true to replace the destination file.",
                    ));
                }
                Err(e) => return Err(map_open_errno(to_rel, e)),
            }
        }

        renameat(
            &from_parent,
            from_leaf.as_str(),
            &to_parent,
            to_leaf.as_str(),
        )
        .map_err(|e| map_errno("rename file", e))?;
        fsync(&from_parent).map_err(|e| map_errno("fsync source parent directory", e))?;
        fsync(&to_parent).map_err(|e| map_errno("fsync destination parent directory", e))?;
        Ok(())
    }

    fn open_parent_dir(&self, rel_path: &str) -> Result<(OwnedFd, String), RuntimeError> {
        let norm = normalize_relative_path(rel_path)?;
        match norm.rsplit_once('/') {
            Some((parent, leaf)) => {
                if leaf.is_empty() || leaf == "." || leaf == ".." {
                    return Err(RuntimeError::InvalidRequest(format!(
                        "invalid target filename in '{norm}'"
                    )));
                }
                let pfd = self.open_dir(parent)?;
                Ok((pfd, leaf.to_string()))
            }
            None => {
                if norm == "." || norm == ".." {
                    return Err(RuntimeError::InvalidRequest(format!(
                        "invalid target filename '{norm}'"
                    )));
                }
                let pfd = self.open_dir(".")?;
                Ok((pfd, norm))
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
