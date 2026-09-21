// Tiny promise wrapper over child_process.spawnFile-style spawning.
// No shell interpolation by default — engine commands are arrays.
import { spawn } from 'node:child_process';

export function spawnFile(file, args, { timeoutMs = 120_000, cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd, env, shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export async function spawnLine(file, args, opts) {
  const r = await spawnFile(file, args, opts);
  return { ...r, firstLine: (r.stdout.trim().split('\n')[0] ?? '').trim() };
}
