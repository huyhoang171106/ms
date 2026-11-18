"""Harbor agent that runs one Axiom arm (A_eight / B_one / C_py / B_repl) inside the task container.

    benchmarks/tb/build.sh   # once: builds /tmp/abx
    PYTHONPATH=benchmarks/tb harbor run -p /tmp/tb/terminal-bench-2-1 -t fix-ocaml-gc \
        -a harbor_agent:AxiomArm --ak arm=B_one -m openai-codex/gpt-6-luna -n 3
"""
import json
import os
import shlex
import tempfile
from pathlib import Path

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

BUNDLE = Path(os.environ.get("ABX_OUT", "/tmp/abx"))
REMOTE = "/opt/abx"


class AxiomArm(BaseAgent):
    def __init__(self, *args, arm: str = "A_eight", max_steps: str | int = 150, **kwargs):
        super().__init__(*args, **kwargs)
        if arm not in ("A_eight", "B_one", "C_py", "B_repl"):
            raise ValueError(f"unknown arm {arm}")
        self.arm, self.max_steps = arm, int(max_steps)

    @staticmethod
    def name() -> str:
        return "axiom-arm"

    def version(self) -> str:
        return "1"

    async def setup(self, environment: BaseEnvironment) -> None:
        if not (BUNDLE / "runner.js").exists():
            raise RuntimeError(f"{BUNDLE} missing: run benchmarks/tb/build.sh")
        await environment.upload_dir(BUNDLE, REMOTE)
        await environment.exec(f"chmod -R go-rwx {REMOTE}/home", user="root")

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
            f.write(instruction)
        await environment.upload_file(f.name, f"{REMOTE}/instruction.md")
        os.unlink(f.name)
        out = f"{self.environment_logs_dir}/result.json"
        cmd = (
            f"mkdir -p {shlex.quote(str(self.environment_logs_dir))} && "
            f"AXIOM_HOME={REMOTE}/home {REMOTE}/bun {REMOTE}/runner.js --arm {self.arm} "
            f"--model {shlex.quote(self.model_name or '')} --workspace \"$(pwd)\" --abx {REMOTE} "
            f"--instruction {REMOTE}/instruction.md --out {shlex.quote(out)} --max-steps {self.max_steps} "
            f"> {shlex.quote(str(self.environment_logs_dir))}/runner.log 2>&1"
        )
        try:
            await environment.exec(cmd, user="root")
        finally:
            self.populate_context_post_run(context)

    def populate_context_post_run(self, context: AgentContext) -> None:
        path = self.logs_dir / "result.json"
        if not path.exists():
            return
        r = json.loads(path.read_text())
        u = r["usage"]
        context.n_input_tokens = u["prompt"]
        context.n_cache_tokens = u["cacheRead"]
        context.n_output_tokens = u["completion"]
        context.metadata = {k: r.get(k) for k in ("arm", "status", "error", "llmTurns", "toolCalls", "toolFailures", "toolOutputBytes", "wallMs")}
