import fs from 'node:fs';
import { stagePytest } from '../integrations/axiom/snapshot.js';

export { PYTHON_REPL_WORKFLOW, buildPythonReplPrompt, createPythonRepl, hostPython, pythonSandbox, repoMap } from '../integrations/axiom/python-repl.js';

export function stageReplPytest(workspace: string, stateDir: string): void {
  const fd = fs.openSync(workspace, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { stagePytest(stateDir, fd); } finally { fs.closeSync(fd); }
}
