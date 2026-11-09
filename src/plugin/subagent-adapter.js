// Subagent adapter — bridges the orchestrator's spawn contract onto
// ctx.subagents activations (provider "spawn" / "fork").
//
// dsh 0.2.2 API: SubagentRuntime only exposes startActivation(spec) /
// startLocal / startExternal — the two-argument start(provider, request) was
// removed. Spec shape (lib/types/types.d.ts, SubagentActivationSpec):
//   { provider, label, request: { prompt, parent, ... }, signal, delivery }
// where `request` is Omit<SubagentStartRequest, 'label' | 'signal'> — the
// cancellation signal lives at the spec top level, NOT inside request, and
// delivery: 'caller' means we await the result ourselves (no parent turn
// notification). The activation handle exposes result: Promise<SubagentResult>
// ({ output: ContentBlock[], stopReason, diagnostic?, structured? }) and
// dispose(): Promise<void>.
/**
 * @param {object} opts
 * @param {object} opts.subagents   ctx.subagents (SubagentRuntime)
 * @param {object} opts.parent      delegating Agent (exec.agent) — required by
 *                                  SubagentStartRequest; providers derive
 *                                  workspace/lineage/depth from its session.
 * @param {string} [opts.provider]  "spawn" (default) | "fork" — mapped straight
 *                                  onto SubagentActivationSpec.provider, the
 *                                  registered backend name.
 * @param {AbortSignal} [opts.signal]
 */
export function makeSubagentAdapter({ subagents, parent, provider = 'spawn', signal }) {
  if (!parent) throw new Error('subagent-adapter: parent Agent (exec.agent) is required');
  return {
    /**
     * @returns {Promise<{ok: boolean, json: object|null, raw: string, error?: string}>}
     */
    async spawn({ agentId, kind, payload }) {
      let activation;
      try {
        activation = await subagents.startActivation({
          provider,
          label: `audit:${kind}:${agentId}`,
          request: {
            prompt: [{ type: 'text', text: payload }],
            parent,
          },
          // SubagentActivationSpec.signal is required: it owns cancellation
          // until publication; a missing opts.signal falls back to a fresh,
          // never-aborted controller signal to satisfy the contract.
          signal: signal ?? new AbortController().signal,
          delivery: 'caller',
        });
        const outcome = await activation.result;
        const raw = (outcome.output ?? [])
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('');
        if (outcome.stopReason !== 'completed') {
          return { ok: false, json: null, raw, error: outcome.diagnostic ?? `stopReason ${outcome.stopReason}` };
        }
        const json = extractLastJsonObject(raw);
        if (!json) return { ok: false, json: null, raw, error: 'no JSON evidence object in final output' };
        return { ok: true, json, raw };
      } catch (e) {
        return { ok: false, json: null, raw: '', error: String(e?.message ?? e) };
      } finally {
        // Defensive: dispose only a handle that actually materialized; cleanup
        // failures must not mask the run outcome.
        if (activation && typeof activation.dispose === 'function') {
          try {
            await activation.dispose();
          } catch {
            // ignored
          }
        }
      }
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
