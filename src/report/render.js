// findings.json assembly + REPORT rendering (design §5.2: report is a
// rendering layer — UI/HTML/md are all generated from findings.json; md is
// an export, never the source of truth).
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// Verdict-specific required shapes per report-schema.json oneOf branches.
export function needsValidationFinding({ fingerprint, title, description, claimedRootCause, trace, evidence, blockers, validationPlan }) {
  return {
    verdict: 'needs_validation',
    fingerprint, title, description,
    claimed_root_cause: claimedRootCause,
    trace, evidence, blockers,
    validation_plan: validationPlan,
  };
}

export function confirmedFinding(f) {
  return { verdict: 'confirmed', ...f }; // caller supplies full confirmed shape
}

export function rejectedFinding({ fingerprint, title, description, claimedRootCause, trace, evidence, reason }) {
  return { verdict: 'rejected', fingerprint, title, description, claimed_root_cause: claimedRootCause, trace, evidence, reason };
}

/** Build blockers (plain strings per schema) from promotion failures / missing controls. */
export function blockerFromPromotion(b) {
  return `artifact promotion rejected: ${b.reason}`;
}

export async function writeFindings(runDir, findings) {
  const p = join(runDir, 'findings.json');
  await writeFile(p, JSON.stringify(findings, null, 2) + '\n');
  return p;
}

// ---- rendering -------------------------------------------------------------

function groupByVerdict(findings) {
  const g = { confirmed: [], needs_validation: [], rejected: [] };
  for (const f of findings) (g[f.verdict] ??= []).push(f);
  return g;
}

export function renderReportMarkdown(findings, { target, sourceRef, runId }) {
  const g = groupByVerdict(findings);
  const lines = [
    `# Security Audit Report — ${target}`, '',
    `- Run: \`${runId}\` · Source ref: \`${sourceRef}\` · Generated: ${new Date().toISOString()}`,
    `- Findings: ${g.confirmed.length} confirmed · ${g.needs_validation.length} needs validation · ${g.rejected.length} rejected`, '',
  ];
  for (const [verdict, label] of [['confirmed', 'Confirmed'], ['needs_validation', 'Needs Validation'], ['rejected', 'Rejected']]) {
    if (!g[verdict].length) continue;
    lines.push(`## ${label}`, '');
    for (const f of g[verdict]) {
      lines.push(`### [${verdict}] ${f.title}`, '', `\`${f.fingerprint}\``, '', f.description, '');
      if (f.root_cause) lines.push(`**Root cause:** ${f.root_cause}`, '');
      if (f.claimed_root_cause) lines.push(`**Claimed root cause (unverified):** ${f.claimed_root_cause}`, '');
      if (f.trace?.length) {
        lines.push('**Trace:**', '');
        for (const t of f.trace) lines.push(`- \`${t.file}:${t.line}\` (${t.kind}) — ${t.description}`);
        lines.push('');
      }
      if (f.execution) {
        lines.push('**Reproduction:**', '', f.execution.observed_result, '');
      }
      if (f.validation_plan) {
        lines.push('**Validation plan:**', f.validation_plan.local ? `- Local: ${f.validation_plan.local}` : '', f.validation_plan.deployment ? `- Deployment: ${f.validation_plan.deployment}` : '', '');
      }
      if (f.reason) lines.push(`**Rejection reason:** ${f.reason}`, '');
    }
  }
  return lines.join('\n');
}

export function renderReportHtml(findings, meta) {
  const g = groupByVerdict(findings);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const badge = (v) => `<span class="badge ${v}">${v.replace('_', ' ')}</span>`;
  const cards = (arr) => arr.map((f) => `
  <article class="card">
    <header>${badge(f.verdict)} <strong>${esc(f.title)}</strong> <code class="fp">${esc(f.fingerprint)}</code></header>
    <p>${esc(f.description)}</p>
    ${f.root_cause ? `<p><b>Root cause:</b> ${esc(f.root_cause)}</p>` : ''}
    ${f.trace ? `<ol class="trace">${f.trace.map((t) => `<li><code>${esc(t.file)}:${t.line}</code> <em>${t.kind}</em> — ${esc(t.description)}</li>`).join('')}</ol>` : ''}
    ${f.execution ? `<p class="repro"><b>Observed:</b> ${esc(f.execution.observed_result)}</p>` : ''}
    ${f.validation_plan ? `<p><b>Validate locally:</b> ${esc(f.validation_plan.local ?? '')} ${f.validation_plan.deployment ? `<br><b>Deployment:</b> ${esc(f.validation_plan.deployment)}` : ''}</p>` : ''}
    ${f.reason ? `<p><b>Rejected:</b> ${esc(f.reason)}</p>` : ''}
  </article>`).join('\n');
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<title>Security Audit — ${esc(meta.target)}</title>
<style>
 :root { color-scheme: light dark; }
 body { font: 15px/1.6 -apple-system, "Segoe UI", sans-serif; max-width: 880px; margin: 40px auto; padding: 0 20px; }
 .badge { display: inline-block; padding: 1px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; margin-right: 8px; }
 .badge.confirmed { background: #b91c1c22; color: #b91c1c; }
 .badge.needs_validation { background: #b4530922; color: #b45309; }
 .badge.rejected { background: #8884; color: inherit; }
 .card { border: 1px solid #8884; border-radius: 12px; padding: 12px 18px; margin: 14px 0; }
 .fp { opacity: .6; font-size: 12px; }
 .trace { opacity: .85; }
 summary { cursor: pointer; }
</style></head><body>
<h1>Security Audit — ${esc(meta.target)}</h1>
<p>Run <code>${esc(meta.runId)}</code> · ref <code>${esc(meta.sourceRef)}</code> · ${esc(meta.generatedAt)}</p>
<p><b>${g.confirmed.length}</b> confirmed · <b>${g.needs_validation.length}</b> needs validation · <b>${g.rejected.length}</b> rejected</p>
<details open><summary><b>Confirmed (${g.confirmed.length})</b></summary>${cards(g.confirmed)}</details>
<details open><summary><b>Needs validation (${g.needs_validation.length})</b></summary>${cards(g.needs_validation)}</details>
<details><summary><b>Rejected (${g.rejected.length})</b></summary>${cards(g.rejected)}</details>
</body></html>
`;
}

export async function writeReports(runDir, findings, meta) {
  await mkdir(runDir, { recursive: true });
  const md = renderReportMarkdown(findings, meta);
  const html = renderReportHtml(findings, meta);
  await writeFile(join(runDir, 'REPORT.md'), md);
  await writeFile(join(runDir, 'report.html'), html);
  return { reportMd: join(runDir, 'REPORT.md'), reportHtml: join(runDir, 'report.html') };
}
