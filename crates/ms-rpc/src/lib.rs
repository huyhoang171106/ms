pub mod backend;
pub mod dispatcher;
pub mod framing;

pub use backend::{
    CancelToken, EffectiveSession, ExecuteFuture, ExecutionContext, OperationOutcome, RpcBackend,
    RuntimeAdapter,
};
pub use dispatcher::{RpcServerConfig, run_rpc_server};
pub use framing::{FrameRead, NdjsonReader, ParsedFrame, parse_frame};

/// Runs the NDJSON RPC server on process `stdin` and `stdout`.
pub async fn run_stdio_server<B: RpcBackend>(
    backend: B,
    config: RpcServerConfig,
) -> std::io::Result<()> {
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();
    run_rpc_server(backend, stdin, stdout, config).await
}
