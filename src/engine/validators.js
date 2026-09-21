// Validator bridge: run the vendored upstream validators as engine self-checks.
//
// Design doc §2: the upstream validators are the engine's post-mutation
// self-checks. A validation failure is an ENGINE BUG, never a data problem:
// the orchestrator must surface it as a red error state and never silently
// retry. (Exit code 2 = schema/contract violation; 0 = ok; 1 = usage error.)
import { spawnFile } from '../util/spawn.js';
import { join } from 'node:path';

export function vendoredRoot(pluginRoot) {
  return join(pluginRoot, 'vendor', 'skills', 'security-audit');
}

/**
 * @returns {Promise<{ok: boolean, exitCode: number, stdout: string, stderr: string}>}
 */
export async function runValidator(pluginRoot, script, payloadPath) {
  const r = await spawnFile(process.execPath, [
    join(vendoredRoot(pluginRoot), script), payloadPath,
  ], { timeoutMs: 30_000 });
  return { ok: r.code === 0, exitCode: r.code, stdout: r.stdout, stderr: r.stderr };
}

export function validateFindings(pluginRoot, findingsPath) {
  return runValidator(pluginRoot, 'validate-findings.cjs', findingsPath);
}

export function validateCoverageLedger(pluginRoot, ledgerPath) {
  return runValidator(pluginRoot, 'validate-coverage-ledger.cjs', ledgerPath);
}

/**
 * Engine invariant: mutate → validate → commit-or-panic.
 * Throws EngineInvariantError on validator failure (caller renders red state).
 */
export async function assertValid(pluginRoot, kind, path) {
  const r = kind === 'findings'
    ? await validateFindings(pluginRoot, path)
    : await validateCoverageLedger(pluginRoot, path);
  if (!r.ok) {
    const err = new Error(
      `ENGINE BUG: vendored ${kind} validator rejected ${path} (exit ${r.exitCode})\n${r.stderr || r.stdout}`);
    err.code = 'ENGINE_INVARIANT_VIOLATION';
    throw err;
  }
  return r;
}
