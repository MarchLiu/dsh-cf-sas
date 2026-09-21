// Prompt assembly — orchestrator-side payloads for recon/hunter/critic/
// verifier/reviewer agents. Vendored upstream md files are the single source
// of truth; this module only concatenates and frames them, never paraphrases
// (design §2: no fork, no rewrite).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { vendoredRoot } from './validators.js';

const md = (pluginRoot, file) => readFile(join(vendoredRoot(pluginRoot), file), 'utf8');

export const AGENT_KINDS = Object.freeze({
  recon: { phases: ['RECONNAISSANCE.md'], extra: [] },
  hunter: { phases: ['HUNTING.md', 'ATTACK-CLASSES.md'], companions: true },
  critic: { phases: ['HUNTING.md'], extra: ['Review ONLY the wave summary. Rule on ledger status per unit: covered/candidate/blocked. Do not re-hunt.'] },
  verifier: { phases: ['VALIDATION-AND-REPORTING.md'], extra: ['You are an adversarial verifier. Your goal is to REFUTE the candidate. Fresh agent: you receive the candidate claim, not the hunter\'s reasoning.'] },
  reviewer: { phases: ['VALIDATION-AND-REPORTING.md'], extra: ['Phase 5 independent review of the final findings set.'] },
});

async function loadFor(pluginRoot, kind, { companions = [] } = {}) {
  const spec = AGENT_KINDS[kind];
  const files = ['SKILL.md', ...spec.phases];
  if (spec.companions) files.push(...companions);
  const parts = [];
  for (const f of files) parts.push(await md(pluginRoot, f));
  return parts.join('\n\n---\n\n');
}

/** Build one agent task payload. `task` is engine-issued; evidence contract is JSON. */
export async function buildAgentPayload(pluginRoot, { kind, task, outputDir, agentId, wave, companions = [], allowlist, priorState = null }) {
  const spec = AGENT_KINDS[kind] ?? { phases: [], extra: [] };
  const skill = await loadFor(pluginRoot, kind, { companions });
  const evidenceContract = [
    '## Engine evidence contract (overrides nothing above)',
    `You are agent \`${agentId}\`, wave ${wave}, writing ONLY inside your assigned \`scratch/\`.`,
    `Output directory: \`${outputDir}\`. Your root: \`<output-dir>/agents/${agentId}/\`.`,
    'Return a single JSON object (and nothing else after it) shaped as:',
    '{ "units": [{ "coverage_id": "...", "status": "covered|candidate|blocked|deferred",',
    '  "reviewed_paths": [...], "local_checks": [{"command":"...","result":"..."}],',
    '  "result_fingerprints": [...], "unresolved": [...] }],',
    'Fingerprint rule: each result_fingerprints entry is a short token matching ^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$ (no spaces), e.g. "taint:req.body.q".',
    'Coverage rule: EVERY terminal status has mandatory fields — covered/candidate REQUIRE non-empty reviewed_paths + local_checks + result_fingerprints (candidate only; covered fingerprints must be empty);',
    'blocked REQUIREs non-empty reviewed_paths + local_checks (document what you did before blocking) + unresolved[]; deferred/not_applicable/out_of_scope are engine-assigned; if you lack evidence, return "blocked" with your partial reviewed paths and an explanatory local_check.',
    '  "summary": "..." , "scratch_artifacts": [{"rel_path":"...","max_bytes":N,"decisive_evidence":bool}] }',
    `Allowed scratch-relative artifact files (allowlist, enforced): ${JSON.stringify(allowlist ?? [])}`,
  ];
  if (priorState) evidenceContract.push(`\n## Prior run state (carry-over candidates only)\n${priorState}`);
  return `${skill}\n\n${[...spec.extra ?? [], task].join('\n\n')}\n\n${evidenceContract.join('\n')}\n`;
}

export const COMPANIONS = Object.freeze({
  rust: 'MEMORY-SAFETY-AND-BINARY.md',
  ai: 'AI-AND-LLM.md',
  web: 'WEB-PROTOCOL-AND-AUTH.md',
  client: 'CLIENT-SIDE.md',
  supply: 'SUPPLY-CHAIN-AND-RELEASE.md',
  cloud: 'CLOUD-AND-DEPLOYMENT.md',
  rpc: 'PROTOCOLS-RPC-AND-MESSAGING.md',
  avail: 'RESOURCE-EXHAUSTION-AND-AVAILABILITY.md',
  data: 'DATA-ISOLATION-AND-LIFECYCLE.md',
  desktop: 'DESKTOP-MOBILE-AND-LOCAL-IPC.md',
});
