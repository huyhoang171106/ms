use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::Path;

use ms_protocol::{
    CallParams, ErrorCode, HardLimits, ListParams, Operation, PatchParams, ReadParams,
    SearchParams, SessionCapabilities, SessionOpenParams, TextEdit, TxListParams, TxState,
    TxUndoParams,
};
use ms_runtime::journal::{JournalEntry, WorkspaceJournal, now_ms};
use ms_runtime::text::blake3_hex;
use ms_runtime::workspace_fs::WorkspaceFs;
use ms_runtime::{CancelToken, HostConfig, Runtime};
use tempfile::TempDir;

fn setup_workspace() -> (TempDir, TempDir) {
    let ws = TempDir::new().expect("ws tempdir");
    let state = TempDir::new().expect("state tempdir");
    (ws, state)
}

fn write_file(dir: &Path, rel: &str, bytes: &[u8]) {
    let p = dir.join(rel);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(&p, bytes).unwrap();
}

fn make_call(session_id: &str, op: Operation, op_id: Option<&str>) -> CallParams {
    CallParams {
        session_id: session_id.to_string(),
        operation: op,
        operation_id: op_id.map(str::to_string),
        deadline_ms: None,
    }
}

#[tokio::test]
async fn t01_path_traversal_and_symlinks_denied() {
    let (ws, state) = setup_workspace();
    let outside = TempDir::new().unwrap();
    write_file(outside.path(), "secret.txt", b"outside secret\n");
    write_file(ws.path(), "real.txt", b"hello\n");
    symlink(
        outside.path().join("secret.txt"),
        ws.path().join("link.txt"),
    )
    .unwrap();
    symlink(outside.path(), ws.path().join("linkdir")).unwrap();

    let cfg = HostConfig::new(ws.path(), state.path()).with_allow_write(true);
    let rt = Runtime::new(cfg).unwrap();
    let sess = rt.open_session(&SessionOpenParams::default()).unwrap();

    // Traversal '..'
    let err = rt
        .execute_call(
            &make_call(
                &sess.session_id,
                Operation::Read(ReadParams {
                    path: "../secret.txt".into(),
                    start_line: None,
                    line_count: None,
                    format: None,
                }),
                None,
            ),
            CancelToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(err.error_code(), ErrorCode::EPolicyDenied);

    // Absolute path
    let err = rt
        .execute_call(
            &make_call(
                &sess.session_id,
                Operation::Read(ReadParams {
                    path: "/etc/passwd".into(),
                    start_line: None,
                    line_count: None,
                    format: None,
                }),
                None,
            ),
            CancelToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(err.error_code(), ErrorCode::EPolicyDenied);

    // Symlink leaf
    let err = rt
        .execute_call(
            &make_call(
                &sess.session_id,
                Operation::Read(ReadParams {
                    path: "link.txt".into(),
                    start_line: None,
                    line_count: None,
                    format: None,
                }),
                None,
            ),
            CancelToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(err.error_code(), ErrorCode::EPolicyDenied);

    // Symlink parent directory
    let err = rt
        .execute_call(
            &make_call(
                &sess.session_id,
                Operation::Read(ReadParams {
                    path: "linkdir/secret.txt".into(),
                    start_line: None,
                    line_count: None,
                    format: None,
                }),
                None,
            ),
            CancelToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(err.error_code(), ErrorCode::EPolicyDenied);

    // In-workspace '..' normalization succeeds for read while root-escaping '..' is rejected
    write_file(ws.path(), "tests/t.py", b"pass\n");
    write_file(
        ws.path(),
        "tinydb_demo/store.py",
        b"def ok():\n    return 1\n",
    );
    let ok_read = rt
        .execute_call(
            &make_call(
                &sess.session_id,
                Operation::Read(ReadParams {
                    path: "tests/../tinydb_demo/store.py".into(),
                    start_line: None,
                    line_count: None,
                    format: None,
                }),
                None,
            ),
            CancelToken::new(),
        )
        .await
        .unwrap();
    assert!(!ok_read.records.is_empty());

    let err_escape = rt
        .execute_call(
            &make_call(
                &sess.session_id,
                Operation::Read(ReadParams {
                    path: "a/../../outside".into(),
                    start_line: None,
                    line_count: None,
                    format: None,
                }),
                None,
            ),
            CancelToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(err_escape.error_code(), ErrorCode::EPolicyDenied);

    // In-workspace '..' targeting a denied secret path (.env) is still rejected
    write_file(ws.path(), ".env", b"SECRET=1\n");
    let err_secret = rt
        .execute_call(
            &make_call(
                &sess.session_id,
                Operation::Read(ReadParams {
                    path: "tests/../.env".into(),
                    start_line: None,
                    line_count: None,
                    format: None,
                }),
                None,
            ),
            CancelToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(err_secret.error_code(), ErrorCode::EPolicyDenied);
}

#[tokio::test]
async fn t02_secret_paths_fifo_and_oversized_file() {
    let (ws, state) = setup_workspace();
    write_file(ws.path(), ".env", b"API_KEY=supersecret\n");
    write_file(ws.path(), ".git/config", b"[core]\n");
    write_file(ws.path(), "certs/server.key", b"PRIVATE KEY\n");
    write_file(ws.path(), "src/main.rs", b"fn main() {}\n");

    // Create a FIFO
    let fifo_path = ws.path().join("my_fifo");
    rustix::fs::mkfifoat(
        rustix::fs::CWD,
        &fifo_path,
        rustix::fs::Mode::from_raw_mode(0o600),
    )
    .unwrap();

    // Oversized file (> 128 bytes limit)
    write_file(ws.path(), "big.txt", &vec![b'a'; 256]);

    let limits = HardLimits {
        max_edit_file_bytes: 128,
        ..Default::default()
    };
    let cfg = HostConfig::new(ws.path(), state.path()).with_limits(limits);
    let rt = Runtime::new(cfg).unwrap();
    let sess = rt.open_session(&SessionOpenParams::default()).unwrap();

    // List must not expose .env, .git, server.key, or my_fifo
    let list_out = rt
        .execute_call(
            &make_call(
                &sess.session_id,
                Operation::List(ListParams::default()),
                None,
            ),
            CancelToken::new(),
        )
        .await
        .unwrap();
    let paths: Vec<String> = list_out
        .records
        .iter()
        .map(|v| v["path"].as_str().unwrap().to_string())
        .collect();
    assert!(paths.contains(&"src/main.rs".to_string()));
    assert!(!paths.iter().any(|p| p.contains(".env")
        || p.contains(".git")
        || p.contains("server.key")
        || p.contains("my_fifo")));

    // Direct read of .env denied
    let err = rt
        .execute_call(
            &make_call(
                &sess.session_id,
                Operation::Read(ReadParams {
                    path: ".env".into(),
                    start_line: None,
                    line_count: None,
                    format: None,
                }),
                None,
            ),
            CancelToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(err.error_code(), ErrorCode::EPolicyDenied);

    // Direct read of FIFO must not hang and must return EPolicyDenied
    let err = rt
        .execute_call(
            &make_call(
                &sess.session_id,
                Operation::Read(ReadParams {
                    path: "my_fifo".into(),
                    start_line: None,
                    line_count: None,
                    format: None,
                }),
                None,
            ),
            CancelToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(err.error_code(), ErrorCode::EPolicyDenied);

    // Direct read of oversized file returns EResourceLimit
    let err = rt
        .execute_call(
            &make_call(
                &sess.session_id,
                Operation::Read(ReadParams {
                    path: "big.txt".into(),
                    start_line: None,
                    line_count: None,
                    format: None,
                }),
                None,
            ),
            CancelToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(err.error_code(), ErrorCode::EResourceLimit);
}

#[tokio::test]
async fn policy_narrowing_cannot_widen() {
    let (ws, state) = setup_workspace();
    write_file(ws.path(), "src/a.rs", b"pub fn a() {}\n");
    write_file(ws.path(), "docs/b.md", b"# doc\n");

    let cfg = HostConfig::new(ws.path(), state.path())
        .with_allow_write(false)
        .with_read_subpaths(Some(vec!["src".into()]));
    let rt = Runtime::new(cfg).unwrap();

    // Requesting allowWrite=true on read-only host fails
    let err = rt
        .open_session(&SessionOpenParams {
            capabilities: Some(SessionCapabilities {
                allow_write: Some(true),
                ..Default::default()
            }),
        })
        .unwrap_err();
    assert_eq!(err.error_code(), ErrorCode::EPolicyDenied);

    // Requesting read_subpaths outside host's "src" fails
    let err = rt
        .open_session(&SessionOpenParams {
            capabilities: Some(SessionCapabilities {
                read_subpaths: Some(vec!["docs".into()]),
                ..Default::default()
            }),
        })
        .unwrap_err();
    assert_eq!(err.error_code(), ErrorCode::EPolicyDenied);

    // Valid session cannot read docs/b.md
    let sess = rt.open_session(&SessionOpenParams::default()).unwrap();
    let err = rt
        .execute_call(
            &make_call(
                &sess.session_id,
                Operation::Read(ReadParams {
                    path: "docs/b.md".into(),
                    start_line: None,
                    line_count: None,
                    format: None,
                }),
                None,
            ),
            CancelToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(err.error_code(), ErrorCode::EPolicyDenied);
}

#[tokio::test]
async fn t05_t06_stale_revision_and_collision_rejected() {
    let (ws, state) = setup_workspace();
    write_file(ws.path(), "f.txt", b"alpha\nbeta\n");

    let cfg = HostConfig::new(ws.path(), state.path()).with_allow_write(true);
    let rt = Runtime::new(cfg).unwrap();
    let sess = rt.open_session(&SessionOpenParams::default()).unwrap();

    let read_out = rt
        .execute_call(
            &make_call(
                &sess.session_id,
                Operation::Read(ReadParams {
                    path: "f.txt".into(),
                    start_line: None,
                    line_count: None,
                    format: None,
                }),
                None,
            ),
            CancelToken::new(),
        )
        .await
        .unwrap();
    let rev = read_out.result.unwrap()["fileRevision"]
        .as_str()
        .unwrap()
        .to_string();

    // External modification
    write_file(ws.path(), "f.txt", b"ALPHA\nbeta\n");

    // Patch with stale revision fails with EConflict and preserves external bytes
    let err = rt
        .execute_call(
            &make_call(
                &sess.session_id,
                Operation::Patch(PatchParams {
                    path: "f.txt".into(),
                    expected_revision: rev,
                    edits: vec![TextEdit {
                        start_byte: 0,
                        end_byte: 5,
                        expected_text: Some("alpha".into()),
                        expected_tag: None,
                        replacement: "gamma".into(),
                    }],
                    dry_run: None,
                }),
                None,
            ),
            CancelToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(err.error_code(), ErrorCode::EConflict);
    assert_eq!(fs::read(ws.path().join("f.txt")).unwrap(), b"ALPHA\nbeta\n");
}

#[tokio::test]
async fn t07_t08_eol_bom_unicode_empty_and_multi_edits() {
    let (ws, state) = setup_workspace();
    // UTF-8 BOM + CRLF + Unicode + no trailing newline
    let initial = b"\xEF\xBB\xBFxin ch\xC3\xA0o\r\n\r\nworld";
    write_file(ws.path(), "bom_crlf.txt", initial);
    write_file(ws.path(), "empty.txt", b"");
    write_file(ws.path(), "mixed.txt", b"a\r\nb\nc\n");

    let cfg = HostConfig::new(ws.path(), state.path()).with_allow_write(true);
    let rt = Runtime::new(cfg).unwrap();
    let sess = rt.open_session(&SessionOpenParams::default()).unwrap();

    // Read bom_crlf.txt
    let read_out = rt
        .execute_call(
            &make_call(
                &sess.session_id,
                Operation::Read(ReadParams {
                    path: "bom_crlf.txt".into(),
                    start_line: None,
                    line_count: None,
                    format: None,
                }),
                None,
            ),
            CancelToken::new(),
        )
        .await
        .unwrap();
    let res = read_out.result.unwrap();
    assert_eq!(res["hasBom"], true);
    assert_eq!(res["eol"], "crlf");
    assert_eq!(res["hasTrailingNewline"], false);
    assert_eq!(res["totalLines"], 3);
    let rev = res["fileRevision"].as_str().unwrap().to_string();

    let l1_start = read_out.records[0]["startByte"].as_u64().unwrap();
    let l1_end = read_out.records[0]["endByte"].as_u64().unwrap();
    let l3_start = read_out.records[2]["startByte"].as_u64().unwrap();
    let l3_end = read_out.records[2]["endByte"].as_u64().unwrap();

    // Multi-edit out of order + dryRun first
    let edits = vec![
        TextEdit {
            start_byte: l3_start,
            end_byte: l3_end,
            expected_text: Some("world".into()),
            expected_tag: None,
            replacement: "rust\nline4".into(),
        },
        TextEdit {
            start_byte: l1_start,
            end_byte: l1_end,
            expected_text: Some("xin chào".into()),
            expected_tag: None,
            replacement: "hello".into(),
        },
    ];

    let dry = rt
        .execute_call(
            &make_call(
                &sess.session_id,
                Operation::Patch(PatchParams {
                    path: "bom_crlf.txt".into(),
                    expected_revision: rev.clone(),
                    edits: edits.clone(),
                    dry_run: Some(true),
                }),
                None,
            ),
            CancelToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(dry.result.unwrap()["dryRun"], true);
    assert_eq!(fs::read(ws.path().join("bom_crlf.txt")).unwrap(), initial);

    // Real patch: preserves BOM, converts \n in replacement to \r\n, preserves no trailing newline
    rt.execute_call(
        &make_call(
            &sess.session_id,
            Operation::Patch(PatchParams {
                path: "bom_crlf.txt".into(),
                expected_revision: rev,
                edits,
                dry_run: Some(false),
            }),
            Some("op-bom-1"),
        ),
        CancelToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(
        fs::read(ws.path().join("bom_crlf.txt")).unwrap(),
        b"\xEF\xBB\xBFhello\r\n\r\nrust\r\nline4"
    );

    // Empty file insert at [0, 0)
    let empty_rev = blake3_hex(b"");
    rt.execute_call(
        &make_call(
            &sess.session_id,
            Operation::Patch(PatchParams {
                path: "empty.txt".into(),
                expected_revision: empty_rev,
                edits: vec![TextEdit {
                    start_byte: 0,
                    end_byte: 0,
                    expected_text: Some("".into()),
                    expected_tag: None,
                    replacement: "first".into(),
                }],
                dry_run: None,
            }),
            None,
        ),
        CancelToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(fs::read(ws.path().join("empty.txt")).unwrap(), b"first");

    // Mixed EOL rejected
    let mixed_rev = blake3_hex(b"a\r\nb\nc\n");
    let err = rt
        .execute_call(
            &make_call(
                &sess.session_id,
                Operation::Patch(PatchParams {
                    path: "mixed.txt".into(),
                    expected_revision: mixed_rev,
                    edits: vec![TextEdit {
                        start_byte: 0,
                        end_byte: 1,
                        expected_text: None,
                        expected_tag: None,
                        replacement: "z".into(),
                    }],
                    dry_run: None,
                }),
                None,
            ),
            CancelToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(err.error_code(), ErrorCode::EInvalidRequest);
}

#[tokio::test]
async fn t09_hardlink_and_state_quota_rejected() {
    let (ws, state) = setup_workspace();
    write_file(ws.path(), "orig.txt", b"hello\n");
    fs::hard_link(ws.path().join("orig.txt"), ws.path().join("hard.txt")).unwrap();

    let cfg = HostConfig::new(ws.path(), state.path()).with_allow_write(true);
    let rt = Runtime::new(cfg).unwrap();
    let sess = rt.open_session(&SessionOpenParams::default()).unwrap();

    let rev = blake3_hex(b"hello\n");
    let err = rt
        .execute_call(
            &make_call(
                &sess.session_id,
                Operation::Patch(PatchParams {
                    path: "orig.txt".into(),
                    expected_revision: rev,
                    edits: vec![TextEdit {
                        start_byte: 0,
                        end_byte: 5,
                        expected_text: None,
                        expected_tag: None,
                        replacement: "world".into(),
                    }],
                    dry_run: None,
                }),
                None,
            ),
            CancelToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(err.error_code(), ErrorCode::EPolicyDenied);
    assert_eq!(fs::read(ws.path().join("orig.txt")).unwrap(), b"hello\n");
    drop(rt);

    // State quota exceeded before touching file
    let (ws2, state2) = setup_workspace();
    write_file(ws2.path(), "q.txt", b"abcdef\n");
    let cfg2 = HostConfig::new(ws2.path(), state2.path())
        .with_allow_write(true)
        .with_max_state_bytes(10); // tiny quota
    let rt2 = Runtime::new(cfg2).unwrap();
    let sess2 = rt2.open_session(&SessionOpenParams::default()).unwrap();
    let err = rt2
        .execute_call(
            &make_call(
                &sess2.session_id,
                Operation::Patch(PatchParams {
                    path: "q.txt".into(),
                    expected_revision: blake3_hex(b"abcdef\n"),
                    edits: vec![TextEdit {
                        start_byte: 0,
                        end_byte: 6,
                        expected_text: None,
                        expected_tag: None,
                        replacement: "123456".into(),
                    }],
                    dry_run: None,
                }),
                None,
            ),
            CancelToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(err.error_code(), ErrorCode::EResourceLimit);
    assert_eq!(fs::read(ws2.path().join("q.txt")).unwrap(), b"abcdef\n");
}

#[tokio::test]
async fn t10_crash_recovery_before_after_conflict_and_tail_truncation() {
    let (ws, state) = setup_workspace();
    write_file(ws.path(), "a.txt", b"before\n");
    write_file(ws.path(), "b.txt", b"after\n");
    write_file(ws.path(), "c.txt", b"unexpected\n");

    let fs_handle = WorkspaceFs::open_root(ws.path()).unwrap();
    let mut j =
        WorkspaceJournal::open_and_recover(state.path(), &fs_handle, 1024 * 1024, 1024 * 1024)
            .unwrap();

    // 1. PREPARED with target == before -> should recover as Aborted
    j.write_preimage("tx1.pre", b"before\n").unwrap();
    j.append_entry(JournalEntry::Prepared {
        tx_id: "tx1".into(),
        operation_id: Some("op1".into()),
        payload_hash: Some("h1".into()),
        kind: ms_protocol::TxKind::Patch,
        path: "a.txt".into(),
        dest_path: None,
        existed_before: true,
        target_dev: 0,
        target_ino: 0,
        target_mode: 0o644,
        temp_name: ".ms_tmp_tx1".into(),
        before_revision: blake3_hex(b"before\n"),
        after_revision: blake3_hex(b"new_a\n"),
        preimage_file: "tx1.pre".into(),
        target_tx_id: None,
        epoch: 1,
        created_at_ms: now_ms(),
        bytes_delta: -1,
        edits_applied: 1,
    })
    .unwrap();

    // 2. PREPARED with target == after -> should recover as Committed
    j.write_preimage("tx2.pre", b"old_b\n").unwrap();
    j.append_entry(JournalEntry::Prepared {
        tx_id: "tx2".into(),
        operation_id: Some("op2".into()),
        payload_hash: Some("h2".into()),
        kind: ms_protocol::TxKind::Patch,
        path: "b.txt".into(),
        dest_path: None,
        existed_before: true,
        target_dev: 0,
        target_ino: 0,
        target_mode: 0o644,
        temp_name: ".ms_tmp_tx2".into(),
        before_revision: blake3_hex(b"old_b\n"),
        after_revision: blake3_hex(b"after\n"),
        preimage_file: "tx2.pre".into(),
        target_tx_id: None,
        epoch: 1,
        created_at_ms: now_ms(),
        bytes_delta: 0,
        edits_applied: 1,
    })
    .unwrap();

    // Append truncated corrupt tail to journal.jsonl
    let (dev, ino) = fs_handle.root_identity();
    let jpath = state
        .path()
        .join("workspaces")
        .join(format!("{dev}_{ino}"))
        .join("journal.jsonl");
    let mut jf = OpenOptions::new().append(true).open(&jpath).unwrap();
    jf.write_all(b"{\"version\":1,\"digest\":\"bad\",\"payload\":\"{truncated")
        .unwrap();
    drop(jf);
    drop(j);

    // Recover via Runtime::new
    let cfg = HostConfig::new(ws.path(), state.path()).with_allow_write(true);
    let rt = Runtime::new(cfg).unwrap();
    let sess = rt.open_session(&SessionOpenParams::default()).unwrap();

    let txs = rt
        .execute_call(
            &make_call(
                &sess.session_id,
                Operation::TxList(TxListParams::default()),
                None,
            ),
            CancelToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(txs.records.len(), 2);
    let tx2 = txs
        .records
        .iter()
        .find(|r| r["transactionId"] == "tx2")
        .unwrap();
    let tx1 = txs
        .records
        .iter()
        .find(|r| r["transactionId"] == "tx1")
        .unwrap();
    assert_eq!(
        tx2["state"],
        serde_json::to_value(TxState::Committed).unwrap()
    );
    assert_eq!(
        tx1["state"],
        serde_json::to_value(TxState::Aborted).unwrap()
    );
    drop(rt);

    // Verify 0700 / 0600 permissions
    let state_mode = fs::metadata(state.path()).unwrap().permissions().mode() & 0o777;
    let j_mode = fs::metadata(&jpath).unwrap().permissions().mode() & 0o777;
    assert_eq!(state_mode, 0o700);
    assert_eq!(j_mode, 0o600);

    // 3. PREPARED with target == neither -> Conflict locks mutations
    let mut j2 =
        WorkspaceJournal::open_and_recover(state.path(), &fs_handle, 1024 * 1024, 1024 * 1024)
            .unwrap();
    j2.write_preimage("tx3.pre", b"orig_c\n").unwrap();
    j2.append_entry(JournalEntry::Prepared {
        tx_id: "tx3".into(),
        operation_id: None,
        payload_hash: None,
        kind: ms_protocol::TxKind::Patch,
        path: "c.txt".into(),
        dest_path: None,
        existed_before: true,
        target_dev: 0,
        target_ino: 0,
        target_mode: 0o644,
        temp_name: ".ms_tmp_tx3".into(),
        before_revision: blake3_hex(b"orig_c\n"),
        after_revision: blake3_hex(b"new_c\n"),
        preimage_file: "tx3.pre".into(),
        target_tx_id: None,
        epoch: 1,
        created_at_ms: now_ms(),
        bytes_delta: 0,
        edits_applied: 1,
    })
    .unwrap();
    drop(j2);

    let cfg2 = HostConfig::new(ws.path(), state.path()).with_allow_write(true);
    let rt2 = Runtime::new(cfg2).unwrap();
    let sess2 = rt2.open_session(&SessionOpenParams::default()).unwrap();
    let err = rt2
        .execute_call(
            &make_call(
                &sess2.session_id,
                Operation::Patch(PatchParams {
                    path: "a.txt".into(),
                    expected_revision: blake3_hex(b"before\n"),
                    edits: vec![TextEdit {
                        start_byte: 0,
                        end_byte: 6,
                        expected_text: None,
                        expected_tag: None,
                        replacement: "changed".into(),
                    }],
                    dry_run: None,
                }),
                None,
            ),
            CancelToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(err.error_code(), ErrorCode::ERecoveryConflict);
}

#[tokio::test]
async fn t11_t12_t13b_patch_restart_undo_conflict_and_idempotency() {
    let (ws, state) = setup_workspace();
    write_file(ws.path(), "code.rs", b"fn x() -> i32 { 1 }\n");
    fs::set_permissions(ws.path().join("code.rs"), fs::Permissions::from_mode(0o640)).unwrap();

    let orig_rev = blake3_hex(b"fn x() -> i32 { 1 }\n");
    let patch_op = Operation::Patch(PatchParams {
        path: "code.rs".into(),
        expected_revision: orig_rev.clone(),
        edits: vec![TextEdit {
            start_byte: 16,
            end_byte: 17,
            expected_text: Some("1".into()),
            expected_tag: None,
            replacement: "42".into(),
        }],
        dry_run: None,
    });

    {
        let cfg = HostConfig::new(ws.path(), state.path()).with_allow_write(true);
        let rt = Runtime::new(cfg).unwrap();
        let sess = rt.open_session(&SessionOpenParams::default()).unwrap();

        let res = rt
            .execute_call(
                &make_call(&sess.session_id, patch_op.clone(), Some("op-patch-1")),
                CancelToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            fs::read(ws.path().join("code.rs")).unwrap(),
            b"fn x() -> i32 { 42 }\n"
        );
        // Mode preserved
        let mode = fs::metadata(ws.path().join("code.rs"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o640);
        assert!(res.result.unwrap()["transactionId"].is_string());
    }

    // Restart Runtime
    {
        let cfg = HostConfig::new(ws.path(), state.path()).with_allow_write(true);
        let rt = Runtime::new(cfg).unwrap();
        let sess = rt.open_session(&SessionOpenParams::default()).unwrap();

        // T13b: Retry same operationId + same payload -> replays stored result without re-applying
        let replay = rt
            .execute_call(
                &make_call(&sess.session_id, patch_op, Some("op-patch-1")),
                CancelToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            replay.result.unwrap()["afterRevision"].as_str().unwrap(),
            blake3_hex(b"fn x() -> i32 { 42 }\n")
        );

        // T13b: Retry same operationId + different payload -> EIdempotencyConflict
        let err = rt
            .execute_call(
                &make_call(
                    &sess.session_id,
                    Operation::Patch(PatchParams {
                        path: "code.rs".into(),
                        expected_revision: orig_rev.clone(),
                        edits: vec![TextEdit {
                            start_byte: 16,
                            end_byte: 17,
                            expected_text: None,
                            expected_tag: None,
                            replacement: "99".into(),
                        }],
                        dry_run: None,
                    }),
                    Some("op-patch-1"),
                ),
                CancelToken::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(err.error_code(), ErrorCode::EIdempotencyConflict);

        // T11: Undo after restart restores original bytes
        let undo_res = rt
            .execute_call(
                &make_call(
                    &sess.session_id,
                    Operation::TxUndo(TxUndoParams::default()),
                    Some("op-undo-1"),
                ),
                CancelToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            undo_res.result.unwrap()["restoredRevision"]
                .as_str()
                .unwrap(),
            orig_rev
        );
        assert_eq!(
            fs::read(ws.path().join("code.rs")).unwrap(),
            b"fn x() -> i32 { 1 }\n"
        );

        // Advance epoch -> old operationId returns EIdempotencyExpired
        rt.advance_epoch().unwrap();
        let err = rt
            .execute_call(
                &make_call(
                    &sess.session_id,
                    Operation::TxUndo(TxUndoParams::default()),
                    Some("op-undo-1"),
                ),
                CancelToken::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(err.error_code(), ErrorCode::EIdempotencyExpired);

        // T12: Patch again, then modify externally -> tx.undo returns EUndoConflict
        rt.execute_call(
            &make_call(
                &sess.session_id,
                Operation::Patch(PatchParams {
                    path: "code.rs".into(),
                    expected_revision: orig_rev,
                    edits: vec![TextEdit {
                        start_byte: 16,
                        end_byte: 17,
                        expected_text: None,
                        expected_tag: None,
                        replacement: "7".into(),
                    }],
                    dry_run: None,
                }),
                None,
            ),
            CancelToken::new(),
        )
        .await
        .unwrap();

        write_file(ws.path(), "code.rs", b"externally edited\n");
        let err = rt
            .execute_call(
                &make_call(
                    &sess.session_id,
                    Operation::TxUndo(TxUndoParams::default()),
                    None,
                ),
                CancelToken::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(err.error_code(), ErrorCode::EUndoConflict);
        assert_eq!(
            fs::read(ws.path().join("code.rs")).unwrap(),
            b"externally edited\n"
        );
    }
}

#[tokio::test]
async fn t13_single_writer_lease_blocks_second_runtime_even_via_symlink_alias() {
    let (ws, state) = setup_workspace();
    let alias_dir = TempDir::new().unwrap();
    let alias_ws = alias_dir.path().join("ws_alias");
    symlink(ws.path(), &alias_ws).unwrap();

    let cfg1 = HostConfig::new(ws.path(), state.path()).with_allow_write(true);
    let rt1 = Runtime::new(cfg1).unwrap();

    // Second runtime pointing to symlink alias of the same workspace must be rejected
    let cfg2 = HostConfig::new(&alias_ws, state.path()).with_allow_write(true);
    let err = Runtime::new(cfg2).unwrap_err();
    assert_eq!(err.error_code(), ErrorCode::EWorkspaceLocked);

    // Dropping rt1 releases the lease
    drop(rt1);
    let cfg3 = HostConfig::new(&alias_ws, state.path()).with_allow_write(true);
    assert!(Runtime::new(cfg3).is_ok());
}

#[tokio::test]
async fn search_and_cancel_work_properly() {
    let (ws, state) = setup_workspace();
    write_file(ws.path(), "a.rs", b"let foo = 1;\nlet bar = foo + 2;\n");

    let cfg = HostConfig::new(ws.path(), state.path());
    let rt = Runtime::new(cfg).unwrap();
    let sess = rt.open_session(&SessionOpenParams::default()).unwrap();

    let out = rt
        .execute_call(
            &make_call(
                &sess.session_id,
                Operation::Search(SearchParams {
                    query: "foo".into(),
                    path: None,
                    regex: Some(false),
                    case_sensitive: Some(true),
                    max_matches: None,
                    context_lines: None,
                }),
                None,
            ),
            CancelToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(out.records.len(), 2);
    assert_eq!(out.records[0]["lineNumber"], 1);
    assert_eq!(out.records[0]["startByte"], 4);
    assert_eq!(out.records[0]["endByte"], 7);
    assert_eq!(out.records[1]["lineNumber"], 2);

    // Pre-cancelled token returns ECancelled immediately
    let cancel = CancelToken::new();
    cancel.cancel();
    let err = rt
        .execute_call(
            &make_call(
                &sess.session_id,
                Operation::List(ListParams::default()),
                None,
            ),
            cancel,
        )
        .await
        .unwrap_err();
    assert_eq!(err.error_code(), ErrorCode::ECancelled);
}

#[tokio::test]
async fn hashline_edit_self_healing_and_file_mutations_undo() {
    let ws = TempDir::new().unwrap();
    let state = TempDir::new().unwrap();
    write_file(
        ws.path(),
        "src/lib.rs",
        b"use std::fmt;\n\npub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n",
    );
    write_file(
        ws.path(),
        "tests/lib_test.rs",
        b"#[test]\nfn test_add() {\n    assert_eq!(add(1, 2), 3);\n}\n",
    );

    let cfg = HostConfig::new(ws.path(), state.path()).with_allow_write(true);
    let rt = Runtime::new(cfg).unwrap();
    let sess = rt
        .open_session(&SessionOpenParams {
            capabilities: Some(SessionCapabilities {
                allow_write: Some(true),
                ..Default::default()
            }),
        })
        .unwrap();

    // 1. Hashline read
    let read_out = rt
        .execute_call(
            &make_call(
                &sess.session_id,
                Operation::Read(ReadParams {
                    path: "src/lib.rs".into(),
                    start_line: Some(1),
                    line_count: Some(10),
                    format: Some(ms_protocol::ReadFormat::Hashline),
                }),
                None,
            ),
            CancelToken::new(),
        )
        .await
        .unwrap();
    assert!(read_out.records.is_empty());
    let hl = read_out.result.as_ref().unwrap()["hashline"]
        .as_str()
        .unwrap();
    assert!(hl.starts_with("rev:"));
    assert!(hl.contains("3:"));

    // Extract line 4 tag
    let line4 = hl.lines().find(|l| l.starts_with("4:")).unwrap();
    let tag4 = line4.split(':').nth(1).unwrap().split('|').next().unwrap();

    // 2. Self-healing conflict on wrong tag
    let conflict_err = rt
        .execute_call(
            &make_call(
                &sess.session_id,
                Operation::Edit(ms_protocol::EditParams {
                    path: "src/lib.rs".into(),
                    expected_revision: None,
                    edits: vec![ms_protocol::EditSpec::Line {
                        start_line: 4,
                        end_line: 4,
                        start_tag: Some("0000".into()),
                        end_tag: None,
                        replacement: "    a + b + 1".into(),
                    }],
                    dry_run: None,
                }),
                None,
            ),
            CancelToken::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(conflict_err.error_code(), ErrorCode::EConflict);
    let info = conflict_err.to_error_info();
    assert!(info.details.is_some());
    assert!(
        info.details.unwrap()["region"]
            .as_str()
            .unwrap()
            .contains("4:")
    );

    // 3. Valid line-range + tag edit
    rt.execute_call(
        &make_call(
            &sess.session_id,
            Operation::Edit(ms_protocol::EditParams {
                path: "src/lib.rs".into(),
                expected_revision: None,
                edits: vec![ms_protocol::EditSpec::Line {
                    start_line: 4,
                    end_line: 4,
                    start_tag: Some(tag4.into()),
                    end_tag: None,
                    replacement: "    a.saturating_add(b)".into(),
                }],
                dry_run: None,
            }),
            Some("edit-line"),
        ),
        CancelToken::new(),
    )
    .await
    .unwrap();
    assert!(
        fs::read_to_string(ws.path().join("src/lib.rs"))
            .unwrap()
            .contains("saturating_add")
    );

    // 4. oldText/newText edit
    rt.execute_call(
        &make_call(
            &sess.session_id,
            Operation::Edit(ms_protocol::EditParams {
                path: "src/lib.rs".into(),
                expected_revision: None,
                edits: vec![ms_protocol::EditSpec::Text {
                    old_text: "a.saturating_add(b)".into(),
                    new_text: "a.wrapping_add(b)".into(),
                }],
                dry_run: None,
            }),
            Some("edit-text"),
        ),
        CancelToken::new(),
    )
    .await
    .unwrap();
    assert!(
        fs::read_to_string(ws.path().join("src/lib.rs"))
            .unwrap()
            .contains("wrapping_add")
    );

    // 5. write_file (create new in nested dir) + tx.undo
    rt.execute_call(
        &make_call(
            &sess.session_id,
            Operation::WriteFile(ms_protocol::WriteFileParams {
                path: "src/new/mod.rs".into(),
                content: "pub fn hi() {}\n".into(),
                create_if_missing: Some(true),
                overwrite: Some(false),
                expected_revision: None,
                dry_run: None,
            }),
            Some("write-new"),
        ),
        CancelToken::new(),
    )
    .await
    .unwrap();
    assert!(ws.path().join("src/new/mod.rs").exists());

    rt.execute_call(
        &make_call(
            &sess.session_id,
            Operation::TxUndo(ms_protocol::TxUndoParams::default()),
            Some("undo-create"),
        ),
        CancelToken::new(),
    )
    .await
    .unwrap();
    assert!(!ws.path().join("src/new/mod.rs").exists());

    // 6. rename_file + tx.undo
    rt.execute_call(
        &make_call(
            &sess.session_id,
            Operation::RenameFile(ms_protocol::RenameFileParams {
                from: "src/lib.rs".into(),
                to: "src/math.rs".into(),
                expected_revision: None,
                overwrite: Some(false),
                dry_run: None,
            }),
            Some("rename-1"),
        ),
        CancelToken::new(),
    )
    .await
    .unwrap();
    assert!(!ws.path().join("src/lib.rs").exists());
    assert!(ws.path().join("src/math.rs").exists());

    rt.execute_call(
        &make_call(
            &sess.session_id,
            Operation::TxUndo(ms_protocol::TxUndoParams::default()),
            Some("undo-rename"),
        ),
        CancelToken::new(),
    )
    .await
    .unwrap();
    assert!(ws.path().join("src/lib.rs").exists());

    // 7. delete_file + tx.undo
    rt.execute_call(
        &make_call(
            &sess.session_id,
            Operation::DeleteFile(ms_protocol::DeleteFileParams {
                path: "src/lib.rs".into(),
                expected_revision: None,
                dry_run: None,
            }),
            Some("del-1"),
        ),
        CancelToken::new(),
    )
    .await
    .unwrap();
    assert!(!ws.path().join("src/lib.rs").exists());

    rt.execute_call(
        &make_call(
            &sess.session_id,
            Operation::TxUndo(ms_protocol::TxUndoParams::default()),
            Some("undo-del"),
        ),
        CancelToken::new(),
    )
    .await
    .unwrap();
    assert!(ws.path().join("src/lib.rs").exists());

    // 8. outline + context_bundle
    let outline_out = rt
        .execute_call(
            &make_call(
                &sess.session_id,
                Operation::Outline(ms_protocol::OutlineParams::default()),
                None,
            ),
            CancelToken::new(),
        )
        .await
        .unwrap();
    assert!(outline_out.records.len() >= 2);

    let ctx_out = rt
        .execute_call(
            &make_call(
                &sess.session_id,
                Operation::ContextBundle(ms_protocol::ContextBundleParams {
                    path: "src/lib.rs".into(),
                    line: Some(3),
                    symbol: None,
                    radius: Some(5),
                }),
                None,
            ),
            CancelToken::new(),
        )
        .await
        .unwrap();
    let ctx_res = ctx_out.result.unwrap();
    assert_eq!(ctx_res["imports"][0], "use std::fmt;");
    assert_eq!(ctx_res["relatedTests"][0]["path"], "tests/lib_test.rs");
}

#[tokio::test]
async fn crash_recovery_write_delete_rename() {
    let ws = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    fs::write(ws.path().join("src_aborted.txt"), b"hello\n").unwrap();
    fs::write(ws.path().join("dst_committed.txt"), b"moved\n").unwrap();

    let fs_handle = WorkspaceFs::open_root(ws.path()).unwrap();
    let mut j =
        WorkspaceJournal::open_and_recover(state.path(), &fs_handle, 1024 * 1024, 1024 * 1024)
            .unwrap();

    // 1. Write new file that crashed before rename into place -> Aborted
    j.append_entry(JournalEntry::Prepared {
        tx_id: "tx_w".into(),
        operation_id: None,
        payload_hash: None,
        kind: ms_protocol::TxKind::Write,
        path: "never_created.txt".into(),
        dest_path: None,
        existed_before: false,
        target_dev: 0,
        target_ino: 0,
        target_mode: 0o644,
        temp_name: ".ms_tmp_tx_w".into(),
        before_revision: String::new(),
        after_revision: blake3_hex(b"new\n"),
        preimage_file: String::new(),
        target_tx_id: None,
        epoch: 1,
        created_at_ms: now_ms(),
        bytes_delta: 4,
        edits_applied: 1,
    })
    .unwrap();

    // 2. Delete that completed on disk before crash -> Committed
    j.write_preimage("tx_d.pre", b"gone\n").unwrap();
    j.append_entry(JournalEntry::Prepared {
        tx_id: "tx_d".into(),
        operation_id: None,
        payload_hash: None,
        kind: ms_protocol::TxKind::Delete,
        path: "already_deleted.txt".into(),
        dest_path: None,
        existed_before: true,
        target_dev: 0,
        target_ino: 0,
        target_mode: 0o644,
        temp_name: String::new(),
        before_revision: blake3_hex(b"gone\n"),
        after_revision: String::new(),
        preimage_file: "tx_d.pre".into(),
        target_tx_id: None,
        epoch: 1,
        created_at_ms: now_ms(),
        bytes_delta: -5,
        edits_applied: 1,
    })
    .unwrap();

    // 3. Rename that crashed before rename -> Aborted (not Conflict!)
    j.append_entry(JournalEntry::Prepared {
        tx_id: "tx_r_abort".into(),
        operation_id: None,
        payload_hash: None,
        kind: ms_protocol::TxKind::Rename,
        path: "src_aborted.txt".into(),
        dest_path: Some("dst_aborted.txt".into()),
        existed_before: true,
        target_dev: 0,
        target_ino: 0,
        target_mode: 0o644,
        temp_name: String::new(),
        before_revision: blake3_hex(b"hello\n"),
        after_revision: blake3_hex(b"hello\n"),
        preimage_file: String::new(),
        target_tx_id: None,
        epoch: 1,
        created_at_ms: now_ms(),
        bytes_delta: 0,
        edits_applied: 1,
    })
    .unwrap();

    // 4. Rename that completed on disk before crash -> Committed
    j.append_entry(JournalEntry::Prepared {
        tx_id: "tx_r_ok".into(),
        operation_id: None,
        payload_hash: None,
        kind: ms_protocol::TxKind::Rename,
        path: "src_committed.txt".into(),
        dest_path: Some("dst_committed.txt".into()),
        existed_before: true,
        target_dev: 0,
        target_ino: 0,
        target_mode: 0o644,
        temp_name: String::new(),
        before_revision: blake3_hex(b"moved\n"),
        after_revision: blake3_hex(b"moved\n"),
        preimage_file: String::new(),
        target_tx_id: None,
        epoch: 1,
        created_at_ms: now_ms(),
        bytes_delta: 0,
        edits_applied: 1,
    })
    .unwrap();
    drop(j);

    let cfg = HostConfig::new(ws.path(), state.path()).with_allow_write(true);
    let rt = Runtime::new(cfg).unwrap();
    let sess = rt.open_session(&SessionOpenParams::default()).unwrap();
    let txs = rt
        .execute_call(
            &make_call(
                &sess.session_id,
                Operation::TxList(TxListParams::default()),
                None,
            ),
            CancelToken::new(),
        )
        .await
        .unwrap();

    let state_of = |id: &str| {
        txs.records
            .iter()
            .find(|r| r["transactionId"] == id)
            .unwrap()["state"]
            .clone()
    };
    assert_eq!(
        state_of("tx_w"),
        serde_json::to_value(TxState::Aborted).unwrap()
    );
    assert_eq!(
        state_of("tx_d"),
        serde_json::to_value(TxState::Committed).unwrap()
    );
    assert_eq!(
        state_of("tx_r_abort"),
        serde_json::to_value(TxState::Aborted).unwrap()
    );
    assert_eq!(
        state_of("tx_r_ok"),
        serde_json::to_value(TxState::Committed).unwrap()
    );
}
