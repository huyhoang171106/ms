use ms_protocol::{ErrorCode, Request};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt};

/// Outcome of reading a single NDJSON line from an async byte stream.
#[derive(Debug)]
pub enum FrameRead {
    /// A complete line (without trailing `\n` or `\r\n`) within `max_frame_bytes`.
    Line(Vec<u8>),
    /// Frame exceeded `max_frame_bytes`; connection must be closed with fatal `protocol_error`.
    Oversized,
    /// Clean end-of-stream.
    Eof,
}

/// Bounded incremental NDJSON reader that never allocates past `max_frame_bytes + read_chunk`.
pub struct NdjsonReader<R> {
    reader: R,
    max_frame_bytes: usize,
    buf: Vec<u8>,
    eof: bool,
}

impl<R: AsyncRead + Unpin> NdjsonReader<R> {
    #[must_use]
    pub fn new(reader: R, max_frame_bytes: usize) -> Self {
        Self {
            reader,
            max_frame_bytes: max_frame_bytes.max(1),
            buf: Vec::with_capacity(8192),
            eof: false,
        }
    }

    /// Reads the next NDJSON frame, returning `FrameRead::Oversized` as soon as
    /// a line exceeds `max_frame_bytes` (even before `\n` arrives).
    pub async fn next_frame(&mut self) -> std::io::Result<FrameRead> {
        loop {
            if let Some(nl_pos) = self.buf.iter().position(|&b| b == b'\n') {
                if nl_pos > self.max_frame_bytes {
                    return Ok(FrameRead::Oversized);
                }
                let mut line = self.buf.drain(..=nl_pos).collect::<Vec<u8>>();
                line.pop(); // remove '\n'
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                if line.len() > self.max_frame_bytes {
                    return Ok(FrameRead::Oversized);
                }
                return Ok(FrameRead::Line(line));
            }

            if self.buf.len() > self.max_frame_bytes {
                return Ok(FrameRead::Oversized);
            }

            if self.eof {
                if self.buf.is_empty() {
                    return Ok(FrameRead::Eof);
                }
                let mut line = std::mem::take(&mut self.buf);
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                if line.len() > self.max_frame_bytes {
                    return Ok(FrameRead::Oversized);
                }
                return Ok(FrameRead::Line(line));
            }

            let mut chunk = [0u8; 8192];
            let n = self.reader.read(&mut chunk).await?;
            if n == 0 {
                self.eof = true;
            } else {
                self.buf.extend_from_slice(&chunk[..n]);
            }
        }
    }
}

/// Result of parsing a single NDJSON frame.
#[derive(Debug)]
pub enum ParsedFrame {
    Empty,
    Request(Request),
    InvalidRequestWithId {
        id: String,
        code: ErrorCode,
        message: String,
    },
    ProtocolError(String),
}

const KNOWN_METHODS: &[&str] = &[
    "initialize",
    "session.open",
    "session.close",
    "call",
    "cancel",
];

/// Parses a single UTF-8 NDJSON frame into a `Request` or a structured error.
#[must_use]
pub fn parse_frame(bytes: &[u8]) -> ParsedFrame {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return ParsedFrame::ProtocolError("frame is not valid UTF-8".to_string());
    };

    if text.trim().is_empty() {
        return ParsedFrame::Empty;
    }

    match serde_json::from_str::<Request>(text) {
        Ok(req) => ParsedFrame::Request(req),
        Err(req_err) => {
            if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(text)
                && let Some(id) = map.get("id").and_then(Value::as_str)
                && !id.trim().is_empty()
            {
                let code = match map.get("method").and_then(Value::as_str) {
                    Some(m) if !KNOWN_METHODS.contains(&m) => ErrorCode::EUnknownCommand,
                    _ => ErrorCode::EInvalidRequest,
                };
                return ParsedFrame::InvalidRequestWithId {
                    id: id.to_string(),
                    code,
                    message: format!("invalid request: {req_err}"),
                };
            }
            ParsedFrame::ProtocolError(format!("malformed JSON frame: {req_err}"))
        }
    }
}
