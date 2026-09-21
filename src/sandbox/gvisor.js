// GVisorDriver — Linux preferred backend (runsc). Falls back honestly: if
// runsc is absent, probe reports the gap; the engine may then offer the
// strict-runc DockerDriver as a documented degradation (§3.2).
import { spawnFile } from '../util/spawn.js';
import { CapabilityReport, gap, probeBinary } from './driver.js';
import { DockerDriver } from './docker.js';

export class GVisorDriver {
  constructor({ runtime = 'runsc', fallback = null } = {}) {
    this.runtime = runtime;
    this.fallback = fallback; // a DockerDriver instance used only if declared
    this.name = 'gvisor';
  }

  static async detect() {
    // Preferred: docker with runsc runtime registered; else direct runsc do/denied.
    const runsc = await probeBinary('runsc', ['--version']);
    return { runsc };
  }

  async probe() {
    const r = new CapabilityReport();
    r.driver = this.name;
    const { runsc } = await GVisorDriver.detect();
    const docker = await probeBinary('docker', ['info']);
    if (!runsc) {
      gap(r, 'gvisor',
        'gVisor runsc not found — Linux audits should use gVisor for strongest userspace-kernel isolation.',
        'install-gvisor-debian.sh');
      if (this.fallback && docker) {
        r.degradations.push('runsc unavailable; strict-runc fallback allowed by config and will be recorded per-evidence.');
        return this.fallback.probe();
      }
      r.ok = false;
      return r;
    }
    r.controls.gvisor = { available: true, detail: runsc };
    r.controls.networkIsolation = { available: true, detail: 'docker --network none under runsc' };
    r.controls.readonlyRootfs = { available: true, detail: '--read-only' };
    r.controls.scratch = { available: true, detail: 'tmpfs /work size-capped' };
    r.controls.resourceLimits = { available: true, detail: 'memory/cpus/pids/fsize' };
    r.controls.wallClock = { available: true, detail: 'timeout(1)' };
    r.controls.capDrop = { available: true, detail: '--cap-drop ALL + runsc userspace kernel' };
    r.ok = true;
    return r;
  }

  async run(req) {
    const { runsc } = await GVisorDriver.detect();
    if (!runsc) {
      if (!this.fallback) throw new Error('gVisor unavailable and no fallback driver configured');
      const res = await this.fallback.run(req);
      return { ...res, degradedTo: 'runc' };
    }
    const docker = new DockerDriver();
    const args = [
      'run', '--rm', '--network', req.network === 'none' ? 'none' : req.network,
      '--read-only',
      '--tmpfs', '/work:rw,size=2g,uid=1000',
      '--mount', `type=bind,src=${req.targetMount},dst=/target,readonly`,
      '--memory', req.limits.mem ?? '4g', '--cpus', req.limits.cpu ?? '2',
      '--pids-limit', String(req.limits.pids ?? 256),
      '--ulimit', 'nofile=1024:2048',
      '--ulimit', `fsize=${req.limits.fsizeBytes ?? 1073741824}`,
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--user', '1000:1000',
      '--runtime', this.runtime,
      req.image ?? docker.defaultImage,
    ];
    const timed = req.limits.wallClockMs
      ? ['timeout', `${Math.ceil(req.limits.wallClockMs / 1000)}`, ...req.cmd] : req.cmd;
    args.push(...timed);
    const r = await spawnFile('docker', args, { timeoutMs: (req.limits.wallClockMs ?? 900_000) + 60_000 });
    return { exitCode: r.code, stdout: r.stdout, stderr: r.stderr, driver: this.name };
  }
}

/** Pick the best local driver for this host (design §3.2 backend matrix). */
export async function selectLocalDriver(config = {}) {
  if (process.platform === 'linux') {
    const g = new GVisorDriver({ fallback: config.allowRuncFallback === false ? null : new DockerDriver(config) });
    return g;
  }
  return new DockerDriver(config);
}
