mod config;

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use ms_rpc::{RpcServerConfig, RuntimeAdapter, run_stdio_server};
use ms_runtime::{HostConfig, Runtime};

#[tokio::main]
async fn main() -> ExitCode {
    let cfg = match config::parse_args(std::env::args().skip(1)) {
        Ok(cfg) => cfg,
        Err(err) => {
            eprintln!("ms: {err}");
            return ExitCode::from(2);
        }
    };

    if cfg.show_help {
        eprint!("{}", config::help_text());
        return ExitCode::SUCCESS;
    }
    if cfg.show_version {
        println!("ms {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }

    // Read-only runs do not write to state_dir, but HostConfig expects a PathBuf.
    let state_dir = cfg
        .state_dir
        .unwrap_or_else(|| PathBuf::from(format!("/tmp/ms-ro-state-{}", std::process::id())));

    let mut host_cfg = HostConfig::new(&cfg.root, state_dir)
        .with_allow_write(cfg.allow_write)
        .with_read_subpaths(cfg.read_subpaths)
        .with_write_subpaths(cfg.write_subpaths)
        .with_limits(cfg.limits.clone());

    if let Some(patterns) = cfg.replace_secret_patterns {
        host_cfg.secret_patterns = patterns;
    }
    host_cfg.secret_patterns.extend(cfg.extra_secret_patterns);

    if let Some(max_state) = cfg.max_state_bytes {
        host_cfg = host_cfg.with_max_state_bytes(max_state);
    }

    let runtime = match Runtime::new(host_cfg) {
        Ok(rt) => Arc::new(rt),
        Err(err) => {
            eprintln!("ms: failed to initialize runtime: {err}");
            return ExitCode::from(1);
        }
    };

    let rpc_cfg = RpcServerConfig {
        max_frame_bytes: cfg.limits.max_frame_bytes,
        max_concurrent_reads_per_connection: cfg.limits.max_concurrent_reads_per_connection,
        max_concurrent_mutations_per_workspace: cfg.limits.max_concurrent_mutations_per_workspace,
        ..RpcServerConfig::default()
    };

    let adapter = RuntimeAdapter::new(runtime);
    if let Err(err) = run_stdio_server(adapter, rpc_cfg).await {
        eprintln!("ms: stdio server error: {}", err.kind());
        return ExitCode::from(1);
    }

    ExitCode::SUCCESS
}
