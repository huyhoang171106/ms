use ms_protocol::*;

#[test]
fn request_initialize_omitted_params_and_roundtrip() {
    let raw = r#"{"id":"r1","method":"initialize"}"#;
    let req: Request = serde_json::from_str(raw).expect("parse initialize without params");
    assert_eq!(req.id, "r1");
    assert_eq!(
        req.body,
        RequestBody::Initialize(InitializeParams::default())
    );
    validate_request(&req).expect("valid initialize");

    let serialized = serde_json::to_string(&req).expect("serialize");
    let reparsed: Request = serde_json::from_str(&serialized).expect("reparse");
    assert_eq!(req, reparsed);
}

#[test]
fn request_call_all_operations_roundtrip() {
    let samples = [
        r#"{"id":"1","method":"call","params":{"sessionId":"s1","operation":{"kind":"list","path":"src","recursive":true}}}"#,
        r#"{"id":"2","method":"call","params":{"sessionId":"s1","operation":{"kind":"search","query":"fn main","regex":false}}}"#,
        r#"{"id":"3","method":"call","params":{"sessionId":"s1","operation":{"kind":"read","path":"src/main.rs","startLine":1,"lineCount":40}}}"#,
        &format!(
            r#"{{"id":"4","method":"call","params":{{"sessionId":"s1","operationId":"op-1","deadlineMs":5000,"operation":{{"kind":"patch","path":"src/main.rs","expectedRevision":"{}","edits":[{{"startByte":0,"endByte":5,"expectedText":"hello","replacement":"world"}}]}}}}}}"#,
            "a".repeat(64)
        ),
        r#"{"id":"5","method":"call","params":{"sessionId":"s1","operation":{"kind":"tx.list","limit":10}}}"#,
        r#"{"id":"6","method":"call","params":{"sessionId":"s1","operationId":"op-2","operation":{"kind":"tx.undo"}}}"#,
        r#"{"id":"7","method":"call","params":{"sessionId":"s1","operation":{"kind":"schema","operation":"patch"}}}"#,
    ];

    for raw in samples {
        let req: Request = serde_json::from_str(raw).expect("parse call");
        validate_request(&req).expect("valid call");
        let rt = serde_json::to_string(&req).expect("serialize");
        let reparsed: Request = serde_json::from_str(&rt).expect("reparse");
        assert_eq!(req, reparsed);
    }
}

#[test]
fn request_session_and_cancel_roundtrip() {
    let open = r#"{"id":"r2","method":"session.open","params":{"capabilities":{"allowWrite":false,"readSubpaths":["src"]}}}"#;
    let req: Request = serde_json::from_str(open).expect("parse session.open");
    validate_request(&req).expect("valid session.open");

    let close = r#"{"id":"r3","method":"session.close","params":{"sessionId":"s1"}}"#;
    let req: Request = serde_json::from_str(close).expect("parse session.close");
    validate_request(&req).expect("valid session.close");

    let cancel = r#"{"id":"r4","method":"cancel","params":{"requestId":"r1"}}"#;
    let req: Request = serde_json::from_str(cancel).expect("parse cancel");
    validate_request(&req).expect("valid cancel");
}

#[test]
fn event_envelopes_roundtrip() {
    let ev_records = Event::records(
        "r1",
        1,
        vec![
            serde_json::to_value(ListEntry {
                path: "src/lib.rs".into(),
                kind: EntryKind::File,
                size_bytes: 128,
            })
            .unwrap(),
        ],
        Some("1.0".into()),
    );
    let json = serde_json::to_string(&ev_records).unwrap();
    assert!(json.contains(r#""type":"records""#));
    let back: Event = serde_json::from_str(&json).unwrap();
    assert_eq!(ev_records, back);

    let ev_ok = Event::completed_ok(
        "r1",
        2,
        false,
        CompletionCounters {
            records_emitted: 1,
            bytes_emitted: 64,
            duration_ms: 3,
        },
        None,
    );
    let json_ok = serde_json::to_string(&ev_ok).unwrap();
    assert!(json_ok.contains(r#""type":"completed""#));
    assert!(json_ok.contains(r#""status":"ok""#));

    let ev_err = Event::completed_err(
        "r1",
        1,
        CompletedStatus::Error,
        false,
        CompletionCounters::default(),
        ErrorInfo::new(ErrorCode::EConflict, "stale revision").with_hint("re-read file"),
    );
    let json_err = serde_json::to_string(&ev_err).unwrap();
    assert!(json_err.contains(r#""code":"E_CONFLICT""#));

    let ev_proto = Event::protocol_error(ErrorCode::EProtocol, "bad json", false);
    let json_proto = serde_json::to_string(&ev_proto).unwrap();
    assert!(json_proto.contains(r#""type":"protocol_error""#));
    assert_eq!(ev_proto.seq, 0);
    assert!(ev_proto.request_id.is_none());
}

#[test]
fn hard_limits_narrow_never_widens() {
    let host = HardLimits::default();
    let client = ClientLimits {
        max_batch_records: Some(999_999),
        max_output_bytes_per_request: Some(4096),
        default_deadline_ms: Some(999_999_999),
    };
    let narrowed = host.narrow(&client);
    assert_eq!(narrowed.max_batch_records, host.max_batch_records);
    assert_eq!(narrowed.max_output_bytes_per_request, 4096);
    assert_eq!(narrowed.default_deadline_ms, host.default_deadline_ms);
}

#[test]
fn path_validation_rejects_traversal_and_unsafe_paths() {
    assert!(validate_relative_path("src/main.rs").is_ok());
    assert!(validate_relative_path("a/b/c.txt").is_ok());
    assert!(validate_relative_path("").is_err());
    assert!(validate_relative_path("/etc/passwd").is_err());
    assert!(validate_relative_path("../secret").is_err());
    assert!(validate_relative_path("src/../../secret").is_err());
    assert!(validate_relative_path("src\\main.rs").is_err());
    assert!(validate_relative_path("src/\0main.rs").is_err());
    assert!(validate_relative_path("src/\nmain.rs").is_err());
}

#[test]
fn revision_and_edit_validation() {
    assert!(validate_revision_hex(&"0123456789abcdef".repeat(4)).is_ok());
    assert!(validate_revision_hex(&"A".repeat(64)).is_err());
    assert!(validate_revision_hex("abc").is_err());

    assert!(validate_patch_edits(&[]).is_err());
    assert!(
        validate_patch_edits(&[TextEdit {
            start_byte: 10,
            end_byte: 5,
            expected_text: None,
            expected_tag: None,
            replacement: "x".into(),
        }])
        .is_err()
    );
    // Overlapping ranges
    assert!(
        validate_patch_edits(&[
            TextEdit {
                start_byte: 0,
                end_byte: 5,
                expected_text: None,
                expected_tag: None,
                replacement: "a".into(),
            },
            TextEdit {
                start_byte: 4,
                end_byte: 8,
                expected_text: None,
                expected_tag: None,
                replacement: "b".into(),
            },
        ])
        .is_err()
    );
    // Duplicate point insert at same offset
    assert!(
        validate_patch_edits(&[
            TextEdit {
                start_byte: 5,
                end_byte: 5,
                expected_text: None,
                expected_tag: None,
                replacement: "a".into(),
            },
            TextEdit {
                start_byte: 5,
                end_byte: 5,
                expected_text: None,
                expected_tag: None,
                replacement: "b".into(),
            },
        ])
        .is_err()
    );
    // Disjoint out-of-order ranges are allowed
    assert!(
        validate_patch_edits(&[
            TextEdit {
                start_byte: 10,
                end_byte: 12,
                expected_text: None,
                expected_tag: None,
                replacement: "b".into(),
            },
            TextEdit {
                start_byte: 0,
                end_byte: 5,
                expected_text: None,
                expected_tag: None,
                replacement: "a".into(),
            },
        ])
        .is_ok()
    );
}

#[test]
fn builtin_schemas_cover_all_operations() {
    let schemas = builtin_operation_schemas();
    let names: Vec<&str> = schemas.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(
        names,
        vec![
            "list",
            "search",
            "read",
            "patch",
            "edit",
            "write_file",
            "delete_file",
            "rename_file",
            "outline",
            "context_bundle",
            "tx.list",
            "tx.undo",
            "schema"
        ]
    );
}
