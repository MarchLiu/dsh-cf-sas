// Race-safe artifact promotion — SKILL.md "Write isolation" steps 1–11, code.
//
// Only trusted parent-side engine code ever writes `artifacts/`. Agents and
// target-controlled processes write only inside their own `scratch/`. This
// module is the single promotion path; nothing else may copy out of scratch.
import { open, mkdir, constants } from 'node:fs/promises';
import { join, sep } from 'node:path';

const WINDOWS_DEVICE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

export class PromotionError extends Error {
  constructor(message, { relPath, decisiveEvidence = false } = {}) {
    super(`promotion rejected ${relPath}: ${message}`);
    this.relPath = relPath;
    this.decisiveEvidence = decisiveEvidence;
  }
}

/** SKILL.md canonical agent IDs: lowercase [a-z0-9][a-z0-9_-]{0,63}, no Windows device names. */
export function assertValidAgentId(id) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || WINDOWS_DEVICE_NAMES.has(id)) {
    throw new Error(`invalid agent id: ${JSON.stringify(id)}`);
  }
  return id;
}

/** Step 1: validate declared relative path — reject absolute, empty, '.', '..', symlink-named components. */
function validateRelPath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) throw new PromotionError('empty path', { relPath });
  if (relPath.includes('\0')) throw new PromotionError('NUL in path', { relPath });
  const parts = relPath.split(/[\\/]/).filter((p) => p !== '' && p !== '.');
  if (relPath.startsWith('/') || relPath.startsWith('\\') || /^[a-zA-Z]:/.test(relPath)) {
    throw new PromotionError('absolute path', { relPath });
  }
  for (const p of parts) {
    if (p === '..') throw new PromotionError('.. component', { relPath });
    if (WINDOWS_DEVICE_NAMES.has(p.toLowerCase())) throw new PromotionError('reserved device name', { relPath });
  }
  if (parts.length === 0) throw new PromotionError('no components', { relPath });
  return parts;
}

async function walkNoFollow(rootFdlessPath, parts, { createMissing = false } = {}) {
  // Steps 2/7: walk parent components. Node lacks openat(); we mitigate the
  // residual race by opening every parent with O_NOFOLLOW and verifying each
  // directory with fstat (real directory, link rules) before descending.
  let cur = rootFdlessPath;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = join(cur, parts[i]);
    if (createMissing) {
      try {
        await mkdir(next, { recursive: false, mode: 0o700 });
      } catch (e) {
        if (e.code !== 'EEXIST') throw new PromotionError(`mkdir ${parts[i]}: ${e.message}`, { relPath: parts.join('/') });
      }
    }
    const fh = await open(next, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY).catch((e) => {
      throw new PromotionError(`component ${parts[i]}: ${e.message}`, { relPath: parts.join('/') });
    });
    try {
      const st = await fh.stat();
      if (!st.isDirectory()) throw new PromotionError(`component ${parts[i]} not a directory`, { relPath: parts.join('/') });
    } finally { await fh.close(); }
    cur = next;
  }
  return join(cur, parts[parts.length - 1]);
}

async function readVerified(srcPath, limitBytes, relPath) {
  // Steps 3–6: open leaf no-follow + nonblocking, fstat (regular file,
  // link count 1, within byte bound), read exactly st.size, re-fstat identity.
  const fh = await open(srcPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((e) => {
    throw new PromotionError(`open leaf: ${e.message}`, { relPath });
  });
  try {
    let st = await fh.stat();
    if (!st.isFile()) throw new PromotionError('not a regular file', { relPath });
    if (st.nlink !== 1) throw new PromotionError(`link count ${st.nlink} != 1`, { relPath });
    if (st.size > limitBytes) throw new PromotionError(`size ${st.size} > bound ${limitBytes}`, { relPath });
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const { bytesRead } = await fh.read(buf, read, st.size - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
      if (read > limitBytes) throw new PromotionError('grew beyond bound while reading', { relPath });
    }
    const st2 = await fh.stat();
    if (st2.isFile() !== st.isFile() || st2.nlink !== 1 || st2.size !== st.size ||
        st2.ino !== st.ino || st2.dev !== st.dev) {
      throw new PromotionError('file changed identity/size during read', { relPath });
    }
    return buf.subarray(0, read);
  } finally { await fh.close(); }
}

/**
 * Promote one allowlisted scratch file into the agent's artifacts/ dir.
 * @param {object} p
 * @param {string} p.scratchRoot  parent-owned absolute path of agent scratch/
 * @param {string} p.artifactsRoot parent-owned absolute path of agent artifacts/
 * @param {string} p.relPath      allowlisted scratch-relative path
 * @param {number} p.maxBytes     per-file byte limit (from the recorded allowlist)
 * @returns {Promise<{promoted: true, destPath: string, bytes: number}>}
 */
export async function promoteFile({ scratchRoot, artifactsRoot, relPath, maxBytes }) {
  const parts = validateRelPath(relPath);
  const srcPath = await walkNoFollow(scratchRoot, parts);
  const destPath = await walkNoFollow(artifactsRoot, parts, { createMissing: true });
  const buf = await readVerified(srcPath, maxBytes, relPath);
  // Step 8: create leaf exclusively, no-follow; then write via descriptor.
  const out = await open(destPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600).catch((e) => {
    throw new PromotionError(`exclusive create: ${e.message}`, { relPath });
  });
  try {
    const dst = await out.stat();
    if (!dst.isFile() || dst.nlink !== 1) throw new PromotionError('destination not a fresh regular file', { relPath });
    await out.writeFile(buf);
  } finally { await out.close(); }
  return { promoted: true, destPath, bytes: buf.length };
}

/**
 * Promote an entire allowlist; per-file failures follow SKILL.md step 11:
 * discard the entry, keep the blocker for needs_validation handling.
 * @returns {Promise<{promoted: Array, blocked: Array<{relPath, reason, decisiveEvidence}>}>}
 */
export async function promoteAllowlist({ scratchRoot, artifactsRoot, allowlist }) {
  const promoted = [], blocked = [];
  let cumulative = 0;
  for (const entry of allowlist) {
    try {
      const r = await promoteFile({
        scratchRoot, artifactsRoot, relPath: entry.relPath, maxBytes: entry.maxBytes,
      });
      cumulative += r.bytes;
      if (entry.cumulativeMaxBytes != null && cumulative > entry.cumulativeMaxBytes) {
        throw new PromotionError('cumulative byte limit exceeded', { relPath: entry.relPath });
      }
      promoted.push(r);
    } catch (e) {
      blocked.push({
        relPath: entry.relPath,
        reason: e.message,
        decisiveEvidence: e.decisiveEvidence ?? entry.decisiveEvidence === true,
      });
    }
  }
  return { promoted, blocked };
}
