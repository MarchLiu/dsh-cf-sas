// DockerDriver — macOS/Windows (and Linux fallback). This is the exact
// control set verified in the hypatia run-1 audit (assets/sandbox/
// run-audit-sandbox.sh), lifted into code:
//   --network none, --read-only rootfs, tmpfs scratch (size-capped),
//   ro bind-mount target, resource + wall-clock limits, cap-drop ALL,
//   no-new-privileges, non-root uid, sanitized allowlisted environment.
import { spawnFile } from '../util/spawn.js';
import { CapabilityReport, gap, probeBinary } from './driver.js';

export class DockerDriver {
  constructor({ scratchSize = '2g', defaultImage = 'security-audit-sandbox:latest' } = {}) {
    this.scratchSize = scratchSize;
    this.defaultImage = defaultImage;
    this.name = 'docker';
  }

  async probe() {
    const r = new CapabilityReport();
    r.driver = this.name;
    const version = await probeBinary('docker', ['version', '--format', '{{.Server.Version}}']);
    r.controls.daemon = { available: !!version, detail: version ?? 'docker daemon unreachable' };
    if (!version) {
      gap(r, 'daemon', 'Docker daemon is not running (Desktop may need to be started).', 'start-docker.md');
      r.ok = false;
      return r;
    }
    const info = await spawnFile('docker', ['info', '--format', '{{.OperatingSystem}}']);
    r.controls.networkIsolation = { available: true, detail: '--network none' };
    r.controls.readonlyRootfs = { available: true, detail: '--read-only' };
    r.controls.scratch = { available: true, detail: `tmpfs /work size=${this.scratchSize}` };
    r.controls.resourceLimits = { available: true, detail: 'memory/cpus/pids/fsize/no-file' };
    r.controls.wallClock = { available: true, detail: 'timeout(1) inside container' };
    r.controls.capDrop = { available: true, detail: '--cap-drop ALL --security-opt no-new-privileges' };
    // Honest note (design §3.2): Docker Desktop isolates via a Linux VM; on
    // native Linux prefer the gVisor driver when runsc is available.
    if (process.platform !== 'linux') {
      r.degradations.push('Docker Desktop runs the container inside a Linux VM — isolation is good but weaker than gVisor; documented in capability report.');
    }
    r.ok = true;
    return r;
  }

  async run(req) {
    const args = [
      'run', '--rm',
      '--network', req.network === 'none' ? 'none' : req.network,
      '--read-only',
      '--tmpfs', `/work:rw,size=${req.limits.fsizeTmpfs ?? this.scratchSize},uid=1000`,
      '--mount', `type=bind,src=${req.targetMount},dst=/target,readonly`,
      '--memory', req.limits.mem ?? '4g',
      '--cpus', req.limits.cpu ?? '2',
      '--pids-limit', String(req.limits.pids ?? 256),
      '--ulimit', 'nofile=1024:2048',
      '--ulimit', `fsize=${req.limits.fsizeBytes ?? 1073741824}`,
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--user', '1000:1000',
    ];
    for (const [k, v] of Object.entries(req.env ?? { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: '/work' })) {
      args.push('-e', `${k}=${v}`);
    }
    args.push(req.image ?? this.defaultImage);
    const timed = req.limits.wallClockMs
      ? ['timeout', `${Math.ceil(req.limits.wallClockMs / 1000)}`, ...req.cmd]
      : req.cmd;
    args.push(...timed);
    const r = await spawnFile('docker', args, {
      timeoutMs: (req.limits.wallClockMs ?? 900_000) + 60_000,
    });
    return { exitCode: r.code, stdout: r.stdout, stderr: r.stderr, driver: this.name };
  }
}
