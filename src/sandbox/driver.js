// SandboxDriver abstraction (design §3.1). Local drivers only in v1.
import { spawnFile } from '../util/spawn.js';

/**
 * @typedef {Object} ExecRequest
 * @property {string} image
 * @property {string[]} cmd
 * @property {string} targetMount        absolute host path, mounted read-only
 * @property {string} scratch            absolute host path, mounted rw (/work)
 * @property {'none'|'loopback'|'proxy-allowlist'} network
 * @property {{cpu?:string, mem?:string, pids?:number, wallClockMs?:number, fsizeBytes?:number}} limits
 * @property {Record<string,string>} [env]  sanitized allowlist only
 */

/**
 * @typedef {Object} ExecResult
 * @property {number} exitCode
 * @property {string} stdout
 * @property {string} stderr
 * @property {string} driver
 */

export class CapabilityReport {
  constructor() {
    this.ok = false;                 // true only when every control is enforceable
    this.driver = null;
    this.controls = {};              // name → {available, detail}
    this.toolchains = {};            // e.g. rust/node/python → available
    this.gaps = [];                  // structured gap list for the approval flow
    this.degradations = [];          // honest downgrade statements
  }
  toJSON() { return { ok: this.ok, driver: this.driver, controls: this.controls, toolchains: this.toolchains, gaps: this.gaps, degradations: this.degradations }; }
}

export function gap(report, id, summary, installScript) {
  report.gaps.push({ id, summary, installScript }); // declarative, auditable
  report.controls[id] = { available: false, detail: summary };
}

/** Probe one binary with `--version`. Returns version string or null. */
export async function probeBinary(bin, args = ['--version'], timeoutMs = 10_000) {
  const r = await spawnFile(bin, args, { timeoutMs });
  return r.code === 0 ? (r.stdout.trim().split('\n')[0] ?? null) : null;
}
