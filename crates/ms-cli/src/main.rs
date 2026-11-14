mod config;

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use config::CliMode;
use ms_rpc::{
    RpcServerConfig, RuntimeAdapter, exec::exec_and_distill, exec::read_log,
    mcp::run_mcp_stdio_server, run_stdio_server,
};
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

    match cfg.mode {
        CliMode::Exec => {
            match exec_and_distill(&cfg.root, &cfg.exec_command, cfg.exec_timeout_ms).await {
                Ok(res) => {
                    println!("{}", res.distilled);
                    let code = u8::try_from(res.exit_code.clamp(0, 255)).unwrap_or(1);
                    return ExitCode::from(code);
                }
                Err(err) => {
                    eprintln!("ms exec: {err}");
                    return ExitCode::from(1);
                }
            }
        }
        CliMode::Log => {
            let id = cfg.log_id.as_deref().unwrap_or("");
            match read_log(id, cfg.log_tail, cfg.log_grep.as_deref()) {
                Ok(text) => {
                    println!("{text}");
                    return ExitCode::SUCCESS;
                }
                Err(err) => {
                    eprintln!("ms log: {err}");
                    return ExitCode::from(1);
                }
            }
        }
        CliMode::Serve | CliMode::Mcp => {}
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

    if cfg.mode == CliMode::Mcp {
        if let Err(err) = run_mcp_stdio_server(runtime, cfg.root).await {
            eprintln!("ms: mcp server error: {}", err.kind());
            return ExitCode::from(1);
        }
        return ExitCode::SUCCESS;
    }

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
