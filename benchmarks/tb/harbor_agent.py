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
from harbor.agents.installed.codex import Codex
from harbor.agents.installed.pi import Pi
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

BUNDLE = Path(os.environ.get("ABX_OUT", "/tmp/abx"))
REMOTE = "/opt/abx"


class AxiomArm(BaseAgent):
    def __init__(self, *args, arm: str = "A_eight", max_steps: str | int = 150, effort: str = "", **kwargs):
        super().__init__(*args, **kwargs)
        if arm not in ("A_eight", "B_one", "C_py", "B_repl"):
            raise ValueError(f"unknown arm {arm}")
        if effort not in ("", "off", "minimal", "low", "medium", "high", "xhigh"):  # Axiom selector `:level` suffixes
            raise ValueError(f"unknown effort {effort}")
        self.arm, self.max_steps, self.effort = arm, int(max_steps), effort

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
            f"--model {shlex.quote((self.model_name or '') + (f':{self.effort}' if self.effort else ''))} --workspace \"$(pwd)\" --abx {REMOTE} "
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
        # harbor's n_input_tokens includes cached input. Axiom's anthropic provider reports prompt without cache; the others include it.
        cached = u["cacheRead"] + u["cacheWrite"] if str(r.get("model", "")).startswith("anthropic/") else 0
        context.n_input_tokens = u["prompt"] + cached
        context.n_cache_tokens = u["cacheRead"]
        context.n_output_tokens = u["completion"]
        context.metadata = {k: r.get(k) for k in ("arm", "status", "error", "llmTurns", "toolCalls", "toolFailures", "toolOutputBytes", "wallMs")}


def _access_only(src: Path, keep) -> str:
    """Temp copy of a host auth.json with refresh tokens blanked, so nothing in a container can rotate the host login."""
    data = keep(json.loads(src.read_text()))
    f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    json.dump(data, f)
    f.close()
    os.chmod(f.name, 0o600)
    return f.name


class LeanPi(Pi):
    """pi with only its built-in tools: no extensions, skills, context files, prompt templates or MCP.
    Auth: the host's access token for the model's provider (refresh blanked) as ~/.pi/agent/auth.json."""

    def build_cli_flags(self) -> str:
        return f"{super().build_cli_flags()} --no-extensions --no-skills --no-context-files --no-prompt-templates --no-mcp".strip()

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        # pi has no anthropic login on this host; reuse Axiom's (same oauth shape), access token only.
        prov = (self.model_name or "openai-codex/").split("/")[0]
        src = Path.home() / (".axiom/auth.json" if prov == "anthropic" else ".pi/agent/auth.json")
        local = _access_only(src, lambda a: {prov: {**a[prov], "refresh": ""}})
        try:
            await environment.upload_file(local, "/tmp/pi-auth.json")
        finally:
            os.unlink(local)
        if environment.default_user is not None:
            await self.exec_as_root(environment, command=f"chown {environment.default_user} /tmp/pi-auth.json")
        await self.exec_as_agent(environment, command="mkdir -p ~/.pi/agent && mv /tmp/pi-auth.json ~/.pi/agent/auth.json && chmod 600 ~/.pi/agent/auth.json")
        await super().run(instruction, environment, context)


class LeanCodex(Codex):
    """Codex CLI with an empty config (no MCP, skills or hooks); ChatGPT login with the refresh token blanked."""

    def _resolve_auth_json_path(self) -> Path | None:
        if not getattr(self, "_lean_auth", None):
            self._lean_auth = _access_only(Path.home() / ".codex/auth.json", lambda a: {**a, "tokens": {**a["tokens"], "refresh_token": ""}})
        return Path(self._lean_auth)
