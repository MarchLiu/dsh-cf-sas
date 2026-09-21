// Run metadata + budget gate. The budget is a hard invariant: if the reserve
// cannot be honored, the run ends `incomplete` with the exact reason — the
// engine never silently shrinks evidence (SKILL.md budget discipline).
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function runDir(outputRoot, targetName, n) {
  return join(outputRoot, targetName, `run-${n}`);
}

export const PHASES = Object.freeze([
  'recon', 'hunt', 'validate', 'output', 'verify', 'report',
]);

export function newRunMetadata({ target, profile, budget, sourceRef, executionLocation, imageManifest }) {
  return {
    schema_version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    target, profile, source_ref: sourceRef,
    execution_location: executionLocation,   // v1: single location
    phase: 'recon',
    run_status: 'in_progress',               // in_progress | complete | incomplete
    incomplete_reason: null,
    budget: {
      max_agent_calls: budget,
      reserved: { recon_baseline: 2, critic: 2, validation_reserve: 3 },
      spent: 0,
    },
    image_manifest: imageManifest ?? null,   // sandbox image auditability (§3.3)
    agents: {},                              // agentId → {kind, unit, startedAt, status}
    approvals: [],                           // probe/approval protocol ledger
    capability_report: null,
  };
}

/** Reserve baseline before any wave may start. Throws on shortfall (hard gate). */
export function assertBudgetReserve(meta) {
  const { reserved } = meta.budget;
  const totalReserved = Object.values(reserved).reduce((a, b) => a + b, 0);
  if (meta.budget.max_agent_calls < totalReserved + 1) {
    const err = new Error(
      `budget ${meta.budget.max_agent_calls} cannot cover reserved ${totalReserved} + 1 work call — run must be incomplete`);
    err.code = 'BUDGET_SHORTFALL';
    throw err;
  }
}

export function canSpend(meta, n = 1) {
  const totalReserved = Object.values(meta.budget.reserved).reduce((a, b) => a + b, 0);
  return meta.budget.spent + n <= meta.budget.max_agent_calls - totalReserved;
}

/** Spending reserved budget (critic/verify) also goes through here, tagged. */
export function spend(meta, n, kind) {
  meta.budget.spent += n;
  meta.updated_at = new Date().toISOString();
}

let _metaQueue = Promise.resolve();
export async function saveRunMetadata(meta, dir) {
  // Serialize metadata writes: parallel agent dispatches mutate one file.
  return (_metaQueue = _metaQueue.catch(() => {}).then(async () => {
    await mkdir(dir, { recursive: true });
    meta.updated_at = new Date().toISOString();
    const tmp = join(dir, `run-metadata.json.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`);
    await writeFile(tmp, JSON.stringify(meta, null, 2) + '\n');
    await rename(tmp, join(dir, 'run-metadata.json'));
  }));
}

export async function loadRunMetadata(dir) {
  return JSON.parse(await readFile(join(dir, 'run-metadata.json'), 'utf8'));
}

// ---- Agent lifecycle policy (design §4.3) --------------------------------
export const LIFECYCLE_POLICY_DEFAULTS = Object.freeze({
  agentTimeoutMs: 20 * 60_000,
  steerAfterMs: 8 * 60_000,     // timeout → steer → interrupt → fresh retry
  freshRetryMax: 1,
});
