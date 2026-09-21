// Ledger state machine — the engine is the single writer of
// coverage-ledger.json; every mutation runs the vendored upstream validator
// before commit (see validators.js). Contract mirrors upstream exactly.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { assertValid } from './validators.js';

export const UNIT_STATUSES = Object.freeze([
  'planned', 'not_applicable', 'out_of_scope', 'in_progress',
  'covered', 'candidate', 'blocked', 'deferred',
]);

export class Ledger {
  /**
   * @param {object} opts
   * @param {string} opts.pluginRoot  plugin install root (locates vendored validator)
   * @param {string} opts.ledgerPath  canonical coverage-ledger.json path in the run dir
   */
  constructor({ pluginRoot, ledgerPath }) {
    this.pluginRoot = pluginRoot;
    this.path = ledgerPath;
    this.doc = null;
    this._queue = Promise.resolve(); // serialize transactions (concurrent assigns)
  }

  /** Serialized transaction runner: no two mutations interleave on one ledger. */
  _enqueue(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {}); // keep chain alive after failures
    return run;
  }

  async load() {
    this.doc = JSON.parse(await readFile(this.path, 'utf8'));
    return this;
  }

  /** Ensure a .ledger.tmp staging write never leaves a torn ledger. */
  async commit() {
    await assertValid(this.pluginRoot, 'ledger', this.path);
  }

  /**
   * Transactional mutation: mutate(this.doc) → atomic write → validate.
   * Validator failure throws EngineInvariantError; the staged file is
   * discarded and the on-disk ledger keeps its last good state.
   * @returns {Promise<boolean>} false when mutate() returned false (no-op)
   */
  async transact(mutate) {
    return this._enqueue(async () => {
      if (mutate(this.doc) === false) return false;
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
      await writeFile(tmp, JSON.stringify(this.doc, null, 2) + '\n');
      await rename(tmp, this.path);
      await this.commit();
      return true;
    });
  }

  unit(coverageId) {
    return this.doc.find((u) => u.coverage_id === coverageId)
      ?? throwErr(`unknown coverage_id ${coverageId}`);
  }

  /**
   * Assign a planned unit to an agent for the given wave (planned → in_progress).
   * Upstream contract: `attempts` holds only ARCHIVED prior assignments; the
   * active assignment lives in top-level fields (agent_id / wave).
   */
  async assign(coverageId, agentId, wave) {
    return this.transact((doc) => {
      const u = this.unit(coverageId);
      if (u.status !== 'planned') return false;
      u.status = 'in_progress';
      u.agent_id = agentId;
      u.wave = wave;
      return true;
    });
  }

  /**
   * Archive the active assignment (fresh retry / reassignment) then hand over.
   * Upstream invariant: the archived attempt's wave must strictly precede the
   * new wave — a retry always bumps the wave (pass `wave: current + 1`).
   */
  async reassign(coverageId, newAgentId, wave, reassignmentReason) {
    return this.transact((doc) => {
      const u = this.unit(coverageId);
      if (u.agent_id == null) return false;
      u.attempts.push({
        wave: u.wave, agent_id: u.agent_id, status: u.status,
        reviewed_paths: u.reviewed_paths, local_checks: u.local_checks,
        result_fingerprints: u.result_fingerprints, unresolved: u.unresolved,
        reassignment_reason: reassignmentReason,
      });
      u.agent_id = newAgentId;
      u.wave = wave;
      u.reviewed_paths = []; u.local_checks = [];
      u.result_fingerprints = []; u.unresolved = [];
      u.status = 'in_progress';
      return true;
    });
  }

  /**
   * Merge one agent's result for a unit (top-level fields; attempts stay archived).
   * Accepts both snake_case (agent evidence contract / upstream ledger keys)
   * and camelCase. Upstream invariant: covered/candidate REQUIRE
   * reviewed_paths + local_checks + result_fingerprints entries — a thin
   * result must be recorded as 'blocked' with unresolved[] instead; the
   * validator rejects anything less.
   */
  async recordResult(coverageId, r) {
    return this.transact((doc) => {
      const u = this.unit(coverageId);
      const status = r.status;
      if (!UNIT_STATUSES.includes(status)) throw new Error(`bad status ${status}`);
      if (r.reviewedPaths ?? r.reviewed_paths) u.reviewed_paths = r.reviewedPaths ?? r.reviewed_paths;
      if (r.localChecks ?? r.local_checks) u.local_checks = r.localChecks ?? r.local_checks;
      if (r.fingerprints ?? r.result_fingerprints) u.result_fingerprints = r.fingerprints ?? r.result_fingerprints;
      if (r.unresolved) u.unresolved = r.unresolved;
      // Normalize to the upstream status matrix (validateStateInvariants):
      // terminal non-findings are unassigned with empty evidence; covered has
      // no unresolved; blocked keeps reviewed paths + a documented check.
      if (['deferred', 'not_applicable', 'out_of_scope'].includes(status)) {
        u.agent_id = null;
        u.reviewed_paths = []; u.local_checks = []; u.result_fingerprints = [];
        if (!u.unresolved.length) u.unresolved = [`recorded ${status} by engine`];
      } else if (status === 'covered') {
        u.result_fingerprints = []; u.unresolved = [];
      } else if (status === 'blocked') {
        u.result_fingerprints = [];
        if (!u.reviewed_paths.length) u.reviewed_paths = [...(u.starting_paths ?? [])];
        if (!u.local_checks.length) {
          u.local_checks = [{
            agent_id: u.agent_id, reviewed_paths: [...u.reviewed_paths],
            invariant: 'engine-recorded blocker', method: 'source',
            result: `blocked before checks: ${(u.unresolved ?? []).join('; ') || 'unknown'}`,
            artifact: null,
          }];
        }
        if (!u.unresolved.length) u.unresolved = ['blocked (reason not recorded)'];
      }
      u.status = status;
      return true;
    });
  }

  counts() {
    const by = {};
    for (const s of UNIT_STATUSES) by[s] = 0;
    for (const u of this.doc) by[u.status] = (by[u.status] ?? 0) + 1;
    return by;
  }

  openUnits() {
    return this.doc.filter((u) => u.status === 'planned' || u.status === 'in_progress');
  }
}

function throwErr(m) { throw new Error(m); }
