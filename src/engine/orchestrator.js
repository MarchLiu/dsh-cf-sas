// Orchestrator — the host-side autonomous engine (design §4).
//
// Runs the six phases end-to-end by delegating all code-reading and judgment
// to subagents through an injected adapter (wired to ctx.subagents by the
// plugin layer). Every agent return is a transactional disk update:
//   result → promote allowlist → ledger transact → validator → advance.
// State lives entirely in the run directory; the engine is resumable from disk.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import {
  newRunMetadata, assertBudgetReserve, canSpend, spend,
  saveRunMetadata, loadRunMetadata, PHASES, LIFECYCLE_POLICY_DEFAULTS,
} from './run-metadata.js';
import { Ledger } from './ledger.js';
import { promoteAllowlist, assertValidAgentId } from './promote.js';
import { buildAgentPayload, COMPANIONS } from './prompts.js';
import { writeFindings, writeReports } from '../report/render.js';
import { assertValid } from './validators.js';

export class Orchestrator {
  /**
   * @param {object} d
   * @param {object} d.subagents  adapter: {spawn({agentId, kind, payload, timeoutMs, steerAtMs, onBlocker}) → Promise<{ok, json, raw}>}
   * @param {object} d.driver     SandboxDriver (probe/run/promote)
   * @param {string} d.pluginRoot
   * @param {string} d.outputRoot e.g. ~/security-audit-runs  (never inside target)
   * @param {Function} d.onEvent  (event) → void — panel/UI feed
   * @param {object} [d.policy]   lifecycle overrides
   */
  constructor({ subagents, driver, pluginRoot, outputRoot, onEvent = () => {}, policy = {} }) {
    Object.assign(this, { subagents, driver, pluginRoot, outputRoot, onEvent });
    this.policy = { ...LIFECYCLE_POLICY_DEFAULTS, ...policy };
    this.emit = (type, data) => { onEvent({ type, runId: this.runId, phase: this.meta?.phase, ...data }); };
  }

  // ---- run lifecycle -------------------------------------------------------
  async createRun({ target, profile = 'standard', budget = 40, sourceRef = 'HEAD', scope = null }) {
    const targetName = basename(target);
    const runRoot = join(this.outputRoot, targetName);
    await mkdir(runRoot, { recursive: true });
    let n = 1;
    const cap = await this.probeOrBlock(target);
    const capReport = cap.report;
    const meta = newRunMetadata({
      target, profile, budget, sourceRef,
      executionLocation: 'local',
      imageManifest: cap.imageManifest ?? null,
    });
    meta.capability_report = capReport.toJSON ? capReport.toJSON() : capReport;
    if (capReport.gaps?.length) {
      meta.pending_approval = { kind: 'install-gaps', gaps: capReport.gaps };
      // audit_start returns here; user approves via panel; resume() continues.
    }
    // find next free run-N
    while (true) {
      try { await readFile(join(runRoot, `run-${n}`, 'run-metadata.json')); n++; } catch { break; }
    }
    this.dir = join(runRoot, `run-${n}`);
    this.runId = `${targetName}/run-${n}`;
    await mkdir(join(this.dir, 'agents'), { recursive: true });
    await saveRunMetadata(meta, this.dir);
    this.meta = meta;
    this.emit('run-created', { dir: this.dir, gaps: capReport.gaps });
    return { runId: this.runId, dir: this.dir, pendingApproval: meta.pending_approval ?? null };
  }

  async resume(runId) {
    this.runId = runId;
    this.dir = join(this.outputRoot, runId);
    this.meta = await loadRunMetadata(this.dir);
    this.ledger = await new Ledger({ pluginRoot: this.pluginRoot, ledgerPath: join(this.dir, 'coverage-ledger.json') }).load();
    this.emit('run-resumed', { phase: this.meta.phase, status: this.meta.run_status });
    return this;
  }

  async probeOrBlock(target) {
    const report = await this.driver.probe();
    // toolchain detection for the target lives with recon; base probe here.
    return { report, imageManifest: null };
  }

  // ---- main loop -----------------------------------------------------------
  async execute() {
    assertBudgetReserve(this.meta);
    const steps = {
      recon: () => this.phaseRecon(),
      hunt: () => this.phaseHunt(),
      validate: () => this.phaseValidate(),
      output: () => this.phaseOutput(),
      verify: () => this.phaseVerify(),
      report: () => this.phaseReport(),
    };
    let i = PHASES.indexOf(this.meta.phase);
    if (i < 0) i = 0;
    for (; i < PHASES.length && this.meta.run_status === 'in_progress'; i++) {
      this.meta.phase = PHASES[i];
      await saveRunMetadata(this.meta, this.dir);
      this.emit('phase-start', { phase: PHASES[i] });
      await steps[PHASES[i]]();
    }
    this.emit('run-finished', { status: this.meta.run_status, reason: this.meta.incomplete_reason });
    return { status: this.meta.run_status, dir: this.dir };
  }

  // ---- agent dispatch with lifecycle policy (§4.3) --------------------------
  async dispatch(kind, { agentId, task, companions = [], allowlist, scratchRoot, artifactsRoot, wave }) {
    assertValidAgentId(agentId);
    const agentDir = join(this.dir, 'agents', agentId);
    await mkdir(join(agentDir, 'scratch'), { recursive: true });
    await mkdir(join(agentDir, 'artifacts'), { recursive: true });
    const payload = await buildAgentPayload(this.pluginRoot, {
      kind, task, outputDir: this.dir, agentId, wave, companions, allowlist,
    });
    if (!canSpend(this.meta)) {
      this.meta.run_status = 'incomplete';
      this.meta.incomplete_reason = `budget exhausted before ${kind} agent ${agentId}`;
      await saveRunMetadata(this.meta, this.dir);
      throw new Error(this.meta.incomplete_reason);
    }
    spend(this.meta, 1, kind);
    this.meta.agents[agentId] = { kind, wave, started_at: new Date().toISOString(), status: 'running' };
    await saveRunMetadata(this.meta, this.dir);
    this.emit('agent-start', { agentId, kind, wave });

    const runOne = (pl) => this.subagents.spawn({
      agentId, kind, payload: pl,
      timeoutMs: this.policy.agentTimeoutMs,
      steerAfterMs: this.policy.steerAfterMs,
    });

    let r = await runOne(payload);
    if (!r.ok && this.policy.freshRetryMax > 0) {
      // Fresh retry: a brand-new agent, no partial predecessor results, keep blocker.
      this.emit('agent-retry', { agentId, blocker: r.error });
      const retryId = `${agentId}b`;
      const retryPayload = await buildAgentPayload(this.pluginRoot, {
        kind, task: `${task}\n\nNOTE: a previous agent on this assignment stalled; start fresh. Blocker on record: ${r.error}`,
        outputDir: this.dir, agentId: retryId, wave, companions, allowlist,
      });
      spend(this.meta, 1, `${kind}-retry`);
      r = await runOne(retryPayload);
      if (r.ok) this.meta.agents[retryId] = { kind, wave, status: 'ok', retried: agentId };
    }
    this.meta.agents[agentId].status = r.ok ? 'ok' : 'failed';
    await saveRunMetadata(this.meta, this.dir);

    if (r.ok && r.json?.scratch_artifacts?.length) {
      const { promoted, blocked } = await promoteAllowlist({
        scratchRoot, artifactsRoot,
        allowlist: r.json.scratch_artifacts.map((a) => ({
          relPath: a.rel_path ?? a.relPath, maxBytes: a.max_bytes,
          decisiveEvidence: a.decisive_evidence === true,
        })),
      });
      if (blocked.length) this.emit('promotion-blocked', { agentId, blocked });
    }
    return r;
  }

  // ---- phases ---------------------------------------------------------------
  async phaseRecon() {
    const agentId = 'recon-1';
    const r = await this.dispatch('recon', {
      agentId, wave: 0,
      task: `Reconnaissance for target ${this.meta.target} (ref ${this.meta.source_ref}). Produce architecture.md, the coverage plan (units), required companion modules, and the toolchain list the sandbox must provide.`,
      allowlist: [{ relPath: 'architecture.md', maxBytes: 512 * 1024 }, { relPath: 'coverage-plan.json', maxBytes: 1024 * 1024 }],
    });
    if (!r.ok || !r.json) return this.incomplete(`recon agent failed: ${r.error}`);
    // Engine materializes the ledger from recon's plan; sanitize to the
    // upstream contract (planned units: agent_id null, attempts empty).
    this.ledger = new Ledger({ pluginRoot: this.pluginRoot, ledgerPath: join(this.dir, 'coverage-ledger.json') });
    this.ledger.doc = (r.json.units ?? []).map((u) => ({
      ...u,
      status: 'planned',
      agent_id: null,
      attempts: [],
      wave: Number.isInteger(u.wave) && u.wave > 0 ? u.wave : 1,
      prior_status: u.prior_status ?? 'none',
      reviewed_paths: [], local_checks: [], result_fingerprints: [], unresolved: [],
    }));
    await this.ledger.transact(() => true);
  }

  async phaseHunt() {
    let wave = 1;
    while (this.meta.run_status === 'in_progress') {
      const open = this.ledger.openUnits().filter((u) => u.status === 'planned');
      if (!open.length) break;
      if (!canSpend(this.meta, 1)) return this.incomplete('budget exhausted before wave ' + wave);
      const batch = open.slice(0, Math.max(1, Math.min(5, open.length)));
      await Promise.all(batch.map((u) => this.ledger.assign(u.coverage_id, `hunter-w${wave}-${slug(u.coverage_id)}`, wave)));
      const companions = (this.meta.companions ?? []).map((c) => COMPANIONS[c]).filter(Boolean);
      const results = await Promise.all(batch.map((u) => this.dispatch('hunter', {
        agentId: `hunter-w${wave}-${slug(u.coverage_id)}`, wave,
        companions,
        task: `Hunt unit ${u.coverage_id}: ${u.boundary ?? ''} (${u.subsystem ?? ''}). Attack class: ${u.attack_class ?? ''}.`,
        allowlist: [{ relPath: 'evidence.md', maxBytes: 1024 * 1024 }],
      })));
      for (let i = 0; i < batch.length; i++) {
        const u = batch[i], r = results[i];
        const ur = r.ok && r.json ? (r.json.units ?? []).find((x) => x.coverage_id === u.coverage_id) : null;
        if (ur) {
          // Upstream invariant: covered/candidate require the evidence triple;
          // thin agent results fall back to blocked — never fabricate entries.
          const hasEvidence = ['covered', 'candidate'].includes(ur.status)
            && ur.reviewed_paths?.length > 0 && ur.local_checks?.length > 0 && ur.result_fingerprints?.length > 0;
          if (hasEvidence || ['blocked', 'deferred', 'not_applicable', 'out_of_scope'].includes(ur.status)) {
            await this.ledger.recordResult(u.coverage_id, ur);
          } else {
            await this.ledger.recordResult(u.coverage_id, {
              status: 'blocked', unresolved: [`agent returned ${ur.status} without required evidence`],
            });
          }
        } else {
          await this.ledger.recordResult(u.coverage_id, {
            status: 'blocked', unresolved: [`hunter failed or omitted unit: ${r.ok ? 'unit missing from response' : r.error}`],
          });
        }
      }
      // critic rules on the wave
      const c = await this.dispatch('critic', {
        agentId: `critic-w${wave}`, wave,
        task: `Wave ${wave} summary follows. Rule per unit.`,
        allowlist: [],
      });
      this.emit('wave-done', { wave, counts: this.ledger.counts(), criticOk: c.ok });
      wave++;
    }
  }

  async phaseValidate() {
    const candidates = this.ledger.doc.filter((u) => u.status === 'candidate');
    this.findingsDraft = [];
    for (const u of candidates) {
      if (!canSpend(this.meta)) return this.incomplete('budget exhausted in validation');
      const r = await this.dispatch('verifier', {
        agentId: `verifier-${slug(u.coverage_id)}`, wave: 0,
        task: `Verify candidate ${u.coverage_id}. Attempt to refute it with a reproduced check in the sandbox. Return a findings.json entry matching report-schema.json for your verdict (confirmed | needs_validation | rejected) as "finding", plus "verdict".`,
        allowlist: [{ relPath: 'verification.md', maxBytes: 1024 * 1024 }],
      });
      if (r.ok && r.json?.finding) {
        this.findingsDraft.push(r.json.finding);
        await this.ledger.recordResult(u.coverage_id, {
          status: r.json.verdict === 'rejected' ? 'deferred' : 'covered',
          unresolved: r.json.verdict === 'needs_validation' ? ['finding recorded as needs_validation'] : undefined,
        });
      } else {
        await this.ledger.recordResult(u.coverage_id, {
          status: 'blocked', unresolved: [`verifier failed: ${r.error}`],
        });
      }
    }
    // Crash-resumable draft; findings.json itself is gated in phaseOutput.
    await writeFile(join(this.dir, 'findings-draft.json'), JSON.stringify(this.findingsDraft, null, 2) + '\n');
  }

  async phaseOutput() {
    const draftPath = join(this.dir, 'findings-draft.json');
    const draft = JSON.parse(await readFile(draftPath, 'utf8').catch(() => '[]'));
    const path = await writeFindings(this.dir, draft);
    await assertValid(this.pluginRoot, 'findings', path);
  }

  async phaseVerify() {
    // Phase 5: independent reviewer over the final findings set (budget permitting).
    if (!canSpend(this.meta, 1)) {
      this.meta.degradations = [...(this.meta.degradations ?? []), 'phase-5 independent review skipped: budget'];
      return;
    }
    const r = await this.dispatch('reviewer', {
      agentId: 'reviewer-1', wave: 0,
      task: 'Independently review findings.json on disk. Confirm each entry meets its verdict bar; report discrepancies in your summary.',
      allowlist: [{ relPath: 'review.md', maxBytes: 512 * 1024 }],
    });
    this.meta.phase5_review = r.ok ? 'done' : `skipped: ${r.error}`;
  }

  async phaseReport() {
    // Render reports from findings.json (single source of truth).
    const findings = JSON.parse(await readFile(join(this.dir, 'findings.json'), 'utf8'));
    const paths = await writeReports(this.dir, findings, {
      target: this.meta.target, runId: this.runId, sourceRef: this.meta.source_ref,
      generatedAt: new Date().toISOString(),
    });
    this.meta.report_artifacts = paths;
    this.meta.run_status = 'complete';
    await saveRunMetadata(this.meta, this.dir);
  }

  async incomplete(reason) {
    this.meta.run_status = 'incomplete';
    this.meta.incomplete_reason = reason;
    await saveRunMetadata(this.meta, this.dir);
    this.emit('run-incomplete', { reason });
  }
}

function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'unit'; }
