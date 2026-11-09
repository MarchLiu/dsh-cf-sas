// Verification for subagent-adapter on dsh-subagent 0.2.2-rc.1:
// 1) import the plugin entry against the real installed 0.2.2 packages
//    (@deepseek-ai/dsh-tools via node_modules symlink) — proves the module
//    graph resolves on 0.2.2;
// 2) drive makeSubagentAdapter with a mock SubagentRuntime whose
//    startActivation validates the spec shape against the 0.2.2 type contract
//    (spec top-level signal/delivery, request = { prompt, parent }, no label/
//    signal inside request), and exercises success / non-completed /
//    dispose-called paths.
import { makeSubagentAdapter } from '../src/plugin/subagent-adapter.js';
import * as plugin from '../src/plugin/index.js';

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } };

assert(plugin.name === 'security-audit', 'plugin entry loads, name exported');
assert(Array.isArray(plugin.inject) && plugin.inject.join() === 'tools,subagents', 'inject matches cordis.patch.yml');

const parent = { fake: 'agent' };
let seenSpec, disposed = 0;

const mkRuntime = (result) => ({
  async startActivation(spec) {
    seenSpec = spec;
    return {
      childId: 'child-1',
      result: Promise.resolve(result),
      dispose: async () => { disposed++; },
    };
  },
});

// --- success path
{
  const rt = mkRuntime({
    output: [{ type: 'text', text: 'preamble {\"answer\":' }, { type: 'text', text: '42}' }],
    stopReason: 'completed',
  });
  const a = makeSubagentAdapter({ subagents: rt, parent, provider: 'spawn' });
  const r = await a.spawn({ agentId: 'ag1', kind: 'hunt', payload: 'do the thing' });
  assert(r.ok === true && r.json.answer === 42, 'success path extracts JSON');
  assert(seenSpec.provider === 'spawn', 'spec.provider mapped from adapter provider');
  assert(seenSpec.label === 'audit:hunt:ag1', 'spec.label format');
  assert(seenSpec.delivery === 'caller', 'spec.delivery=caller');
  assert(typeof seenSpec.signal.aborted === 'boolean', 'spec.signal present (AbortSignal)');
  assert(Array.isArray(seenSpec.request.prompt)
    && seenSpec.request.prompt[0].type === 'text'
    && seenSpec.request.prompt[0].text === 'do the thing', 'request.prompt ContentBlock[]');
  assert(seenSpec.request.parent === parent, 'request.parent is the delegating Agent');
  assert(!('label' in seenSpec.request), 'label NOT inside request (Omit per types)');
  assert(!('signal' in seenSpec.request), 'signal NOT inside request (Omit per types)');
  assert(disposed === 1, 'dispose called once on success');
}

// --- non-completed stopReason carries diagnostic
{
  const rt = mkRuntime({ output: [{ type: 'text', text: 'partial' }], stopReason: 'error', diagnostic: 'child blew up' });
  const a = makeSubagentAdapter({ subagents: rt, parent, provider: 'fork' });
  const r = await a.spawn({ agentId: 'ag2', kind: 'validate', payload: 'x' });
  assert(r.ok === false && r.error === 'child blew up' && r.raw === 'partial', 'non-completed → error w/ diagnostic');
  assert(seenSpec.provider === 'fork', 'fork maps to spec.provider');
  assert(disposed === 2, 'dispose called on failure path');
}

// --- startActivation rejection still disposes nothing, returns error contract
{
  const rt = { async startActivation() { throw new Error('capacity full'); } };
  const a = makeSubagentAdapter({ subagents: rt, parent });
  const r = await a.spawn({ agentId: 'ag3', kind: 'plan', payload: 'x' });
  assert(r.ok === false && r.json === null && r.raw === '' && /capacity full/.test(r.error), 'startActivation rejection → contract error');
  assert(disposed === 2, 'no dispose when handle never materialized');
}

// --- dispose throwing is swallowed
{
  const rt = {
    async startActivation() {
      return { childId: 'c', result: Promise.resolve({ output: [{ type: 'text', text: '{"a":1}' }], stopReason: 'completed' }), dispose: async () => { throw new Error('teardown boom'); } };
    },
  };
  const a = makeSubagentAdapter({ subagents: rt, parent });
  const r = await a.spawn({ agentId: 'ag4', kind: 'plan', payload: 'x' });
  assert(r.ok === true && r.json.a === 1, 'dispose rejection does not mask result');
}

console.log(process.exitCode ? 'ADAPTER VERIFY FAILED' : 'ADAPTER VERIFY OK');
