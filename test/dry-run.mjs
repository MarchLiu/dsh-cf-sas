// End-to-end dry run: the full orchestrator against a fixture target with a
// stub subagent adapter + stub sandbox driver. Proves: six phases, budget
// accounting, ledger transactions gated by the upstream validator, promotion,
// findings gating, and report rendering — all on real disk state.
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Orchestrator } from '../src/engine/orchestrator.js';

const pluginRoot = join(import.meta.dirname, '..');
const base = '/tmp/sas-dryrun';
await rm(base, { recursive: true, force: true });
await mkdir(join(base, 'target/src'), { recursive: true });
await writeFile(join(base, 'target/src/app.py'), 'email = request.form["email"]\nq = f"SELECT * FROM users WHERE email = \'{email}\'"\n');

const unitBase = (surface, ac) => {
  const canonical_refs = { surface, boundary: 'input', subsystem: 'auth', attack_class: ac };
  return { coverage_id: [surface, 'input', 'auth', ac].join('::'), canonical_refs, surface,
    boundary: 'input', subsystem: 'auth', attack_class: ac, starting_paths: ['src/app.py'],
    ordinary_attack_class_block: 'A1', selected_companion_blocks: [], excluded_blocks: [],
    prior_status: 'none' };
};
const hunterResult = (id) => ({ units: [{
  coverage_id: id, status: 'covered',
  reviewed_paths: ['src/app.py'],
  local_checks: [{ agent_id: 'x', reviewed_paths: ['src/app.py'], invariant: 'parameterized queries', method: 'source', result: 'f-string concatenation found', artifact: null }],
  result_fingerprints: [`taint:app.py:${id.split('::')[3]}`], unresolved: [],
}] });

const finding = {
  verdict: 'needs_validation', fingerprint: 'taint:app.py:injection',
  title: 'SQL injection in email lookup', description: 'Form email is concatenated into SQL.',
  claimed_root_cause: 'f-string query construction',
  trace: [{ kind: 'sink', file: 'src/app.py', line: 2, scope: 'query build', description: 'concatenation' }],
  evidence: [{ file: 'src/app.py', line: 2, description: 'f-string' }],
  blockers: ['sqlite unavailable in audit sandbox'],
  validation_plan: { local: 'Run sqlite3 with payload x — observe all rows.' },
};

// --- stub subagent adapter: canned responses per kind
const calls = [];
const subagents = { spawn: async ({ agentId, kind, payload }) => {
  calls.push({ agentId, kind });
  if (kind === 'recon') return { ok: true, json: { units: [unitBase('api', 'injection'), unitBase('api', 'xss')] } };
  if (kind === 'hunter') return { ok: true, json: hunterResult(payload.match(/Hunt unit (\S+):/)?.[1] ?? "api::input::auth::injection") };
  if (kind === 'critic') return { ok: true, json: { summary: 'one candidate held' } };
  if (kind === 'verifier') return { ok: true, json: { verdict: 'needs_validation', finding } };
  if (kind === 'reviewer') return { ok: true, json: { summary: 'reviewed' } };
  return { ok: false, error: 'unknown kind' };
} };
// NOTE: hunter response above maps candidate detection via ledger statuses:
// critic doesn't change statuses in stub, so units end 'covered' → no candidates.
// To exercise validation, force unit 2 to 'candidate' via a critic-hook below.

const driver = {
  async probe() { return { ok: true, driver: 'stub', controls: {}, toolchains: {}, gaps: [], degradations: [] }; },
};

const engine = new Orchestrator({
  subagents, driver, pluginRoot, outputRoot: join(base, 'runs'),
  onEvent: (e) => console.log('  event:', e.type, e.phase ?? '', e.counts ? JSON.stringify(e.counts) : ''),
});
const created = await engine.createRun({ target: join(base, 'target'), profile: 'quick', budget: 40 });
console.log('run created:', created.runId);

// After recon, mark unit 2 as candidate via a real ledger transaction (what a
// critic ruling would do), to exercise the validation path end-to-end.
const origHunt = engine.phaseHunt.bind(engine);
engine.phaseHunt = async () => {
  // wave 1 hunts normally...
  await origHunt();
  // then simulate a critic ruling: second unit → candidate (needs verification)
  await engine.ledger.transact((doc) => {
    const u = doc.find((x) => x.coverage_id.endsWith('::xss'));
    if (u) { u.status = 'candidate';
      u.reviewed_paths = ['src/app.py'];
      u.local_checks = [{ agent_id: u.agent_id, reviewed_paths: ['src/app.py'], invariant: 'escaped output', method: 'source', result: 'uncertain', artifact: null }];
      u.result_fingerprints = ['taint:app.py:xss'];
      u.agent_id = 'critic-w1'; }
    return true;
  });
  // re-run hunt loop tail: nothing planned remains, proceed
};

const res = await engine.execute();
console.log('result:', res.status);
console.log('agent calls:', calls.map((c) => `${c.kind}:${c.agentId}`).join(', '));
console.log('budget spent:', engine.meta.budget.spent, '/', engine.meta.budget.max_agent_calls);

// verify artifacts
const { readFile } = await import('node:fs/promises');
const dir = engine.dir;
for (const f of ['run-metadata.json', 'coverage-ledger.json', 'findings.json', 'findings-draft.json', 'REPORT.md', 'report.html']) {
  try { await readFile(join(dir, f)); console.log('  ✓', f); } catch { console.log('  ✗ MISSING', f); }
}
const ledger = JSON.parse(await readFile(join(dir, 'coverage-ledger.json'), 'utf8'));
console.log('final ledger statuses:', ledger.map((u) => `${u.coverage_id.split('::')[3]}=${u.status}`).join(' '));
const md = await readFile(join(dir, 'REPORT.md'), 'utf8');
console.log('REPORT.md head:', md.split('\n')[0]);
console.log('phase5:', engine.meta.phase5_review);
