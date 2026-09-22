// dsh-security-audit plugin entry (cordis service).
//
// Wires the orchestrator engine onto the DSH host: tools (audit_*),
// ctx.subagents one-shot pool as the agent workhorse, local sandbox driver
// selection, and disk-state-only progress (resumable across restarts).
//
// Panel note (docs/dsh-plugin-api-notes.md §4): the host has no push-a-panel
// API; progress reaches the user as tool results + assistant dsh-ui fences.
// The engine keeps everything on disk; audit_status is the poll surface.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { Orchestrator } from '../engine/orchestrator.js';
import { selectLocalDriver } from '../sandbox/gvisor.js';
import { loadRunMetadata, saveRunMetadata } from '../engine/run-metadata.js';
import { Ledger } from '../engine/ledger.js';
import { makeSubagentAdapter } from './subagent-adapter.js';

export const name = 'security-audit';

let Config;
try { Config = (await import('@deepseek-ai/schemastery')).default; } catch {}

export const inject = ['tools', 'subagents'];

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const activeRuns = new Map(); // runId → { controller, startedAt }

export function apply(ctx, config = {}) {
  config = config ?? {}; // host passes null when no `config:` block is set in the bundle patch
  const log = ctx.logger?.('security-audit') ?? console;
  log.info?.('security-audit plugin starting');

  const outputRootFor = () => config.outputRoot
    ?? join(process.env.HOME ?? process.cwd(), 'security-audit-runs');

  async function newEngine(signal, parentAgent) {
    const driver = await selectLocalDriver(config.sandbox ?? {});
    return new Orchestrator({
      subagents: makeSubagentAdapter({ subagents: ctx.subagents, parent: parentAgent, provider: config.subagentProvider ?? 'spawn', signal }),
      driver,
      pluginRoot,
      outputRoot: outputRootFor(),
      policy: config.lifecycle ?? {},
      onEvent: (e) => log.info?.(`[audit] ${e.runId}: ${e.type}`, e.phase ?? ''),
    });
  }

  // ---- audit_start ---------------------------------------------------------
  ctx.tools.register(require_tool('audit_start', {
    description: 'Start a full structured security audit of a local repository (six-phase, subagent-driven, sandboxed). Returns immediately with a run id; progress is on disk — poll audit_status. Requires an explicit audit/pen-test/full-review intent.',
    parameters: {
      target: { type: 'string', required: true, description: 'Absolute path of the target repository (never the output root).' },
      profile: { type: 'string', description: 'quick | standard | deep (default standard)' },
      budget: { type: 'number', description: 'Max agent calls (default 40).' },
      scope: { type: 'string', description: 'Optional scope statement.' },
    },
  }, async (args, exec) => {
    // exec.agent is the delegating Agent — SubagentStartRequest requires it as
    // `parent` (providers derive workspace/lineage/depth from its session).
    const parent = exec?.agent;
    if (!parent) return { error: 'audit_start must be called from an agent tool context (exec.agent missing)' };
    const controller = new AbortController();
    const engine = await newEngine(controller.signal, parent);
    const created = await engine.createRun({
      target: args.target,
      profile: args.profile ?? 'standard',
      budget: args.budget ?? 40,
      scope: args.scope ?? null,
    });
    // Kick execution in the background; disk state is authoritative.
    const runId = created.runId;
    activeRuns.set(runId, { controller, startedAt: Date.now() });
    engine.execute()
      .catch((e) => log.error?.(`[audit] ${runId} engine error`, e))
      .finally(() => activeRuns.delete(runId));
    return {
      runId, dir: created.dir,
      pendingApproval: created.pendingApproval,
      note: 'Execution continues in the background. Poll audit_status; surface progress to the user as a panel:true dsh-ui card.',
    };
  }));

  // ---- audit_status --------------------------------------------------------
  ctx.tools.register(require_tool('audit_status', {
    description: 'Report the on-disk state of a security audit run: phase, run_status, ledger counts, agents, incomplete reason.',
    parameters: {
      runId: { type: 'string', description: 'run id from audit_start ("target/run-N"). Omit for the latest run.' },
    },
  }, async (args) => {
    const base = outputRootFor();
    let dir;
    if (args.runId) dir = join(base, args.runId);
    else {
      const targets = await readdir(base).catch(() => []);
      outer: for (const t of targets.reverse()) {
        const runs = await readdir(join(base, t)).catch(() => []);
        for (const r of runs.reverse()) {
          try { await readFile(join(base, t, r, 'run-metadata.json')); dir = join(base, t, r); break outer; } catch {}
        }
      }
    }
    if (!dir) return { error: 'no audit run found' };
    const meta = JSON.parse(await readFile(join(dir, 'run-metadata.json'), 'utf8'));
    let counts = null;
    try { counts = (await new Ledger({ pluginRoot, ledgerPath: join(dir, 'coverage-ledger.json') }).load()).counts(); } catch {}
    return {
      runId: args.runId ?? dir.slice(base.length + 1),
      phase: meta.phase, run_status: meta.run_status,
      incomplete_reason: meta.incomplete_reason,
      budget: { max: meta.budget?.max_agent_calls, spent: meta.budget?.spent },
      ledger_counts: counts,
      active: activeRuns.has(args.runId ?? ''),
      pending_approval: meta.pending_approval ?? null,
      dir,
    };
  }));

  // ---- audit_cancel --------------------------------------------------------
  ctx.tools.register(require_tool('audit_cancel', {
    description: 'Abort a running security audit engine (disk state is kept; the run can be marked incomplete).',
    parameters: { runId: { type: 'string', required: true } },
  }, async (args) => {
    const r = activeRuns.get(args.runId);
    if (!r) return { ok: false, reason: 'not active (already finished or lost to restart)' };
    r.controller.abort('user cancelled');
    return { ok: true };
  }));

  log.info?.('security-audit tools registered');
  return () => { for (const [, r] of activeRuns) r.controller.abort('plugin disposed'); };
}

function require_tool(name_, { description, parameters }, fn) {
  return defineTool({
    name: name_,
    description,
    parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    },
    execute: (args, exec) => fn(args, exec),
  });
}
