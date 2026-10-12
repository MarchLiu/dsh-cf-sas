// Subagent adapter — bridges the orchestrator's spawn contract onto
// ctx.subagents one-shot runs (provider "spawn"), mirroring
// dsh-tool-subagent's settleRun usage (see docs/dsh-plugin-api-notes.md §3).
import { settleRun } from '@deepseek-ai/dsh-subagent';

/**
 * @param {object} opts
 * @param {object} opts.subagents   ctx.subagents (SubagentRuntime)
 * @param {object} opts.parent      delegating Agent (exec.agent) — required by
 *                                  SubagentStartRequest; providers derive
 *                                  workspace/lineage/depth from its session.
 * @param {string} [opts.provider]  "spawn" (default) | "fork"
 * @param {AbortSignal} [opts.signal]
 */
export function makeSubagentAdapter({ subagents, parent, provider = 'spawn', signal }) {
  if (!parent) throw new Error('subagent-adapter: parent Agent (exec.agent) is required');
  return {
    /**
     * @returns {Promise<{ok: boolean, json: object|null, raw: string, error?: string}>}
     */
    async spawn({ agentId, kind, payload }) {
      let outcome;
      try {
        outcome = await settleRun(await subagents.start(provider, {
          label: `audit:${kind}:${agentId}`,
          prompt: [{ type: 'text', text: payload }],
          parent,
          ...(signal ? { signal } : {}),
        }));
      } catch (e) {
        return { ok: false, json: null, raw: '', error: String(e?.message ?? e) };
      }
      const raw = outcome.result ?? outcome.output ?? '';
      if (outcome.status !== 'completed') {
        return { ok: false, json: null, raw, error: outcome.detail ?? `status ${outcome.status}` };
      }
      const json = extractLastJsonObject(raw);
      if (!json) return { ok: false, json: null, raw, error: 'no JSON evidence object in final output' };
      return { ok: true, json, raw };
    },
  };
}

/** Extract the last balanced JSON object from an assistant message. */
export function extractLastJsonObject(text) {
  const end = text.lastIndexOf('}');
  if (end < 0) return null;
  for (let start = text.lastIndexOf('{', end); start >= 0; start = text.lastIndexOf('{', start - 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch { /* try a later start */ }
  }
  return null;
}
