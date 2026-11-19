import { expect, test } from 'bun:test';
import path from 'node:path';

import { CPY_REMINDER, addUsage, createCpyGate, createPythonTool, trimOldToolOutputs } from './cpy.ts';

type R = { content?: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; usage?: Record<string, number> };
const msgs = (...m: Array<[string, string]>) => ({ messages: m.map(([role, content]) => ({ role, content })) });
const scripted = (...replies: R[]) => {
  const seen: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  return { seen, send: async (p: (typeof seen)[number]) => { seen.push(p); return replies.shift()!; } };
};

test('stop after a passing check and a suite claim completes; anything weaker gets the reminder', async () => {
  const g = createCpyGate();
  g.toolEnded('[exit 0]\n367 passed');
  await g.chat(msgs(['user', 'task']), scripted({ content: 'All 367 tests pass.' }).send);
  expect(g.isComplete()).toBe(true);

  const weak = createCpyGate();
  weak.toolEnded('[exit 0]\nok');
  await weak.chat(msgs(['user', 'task']), scripted({ content: 'Done.' }).send);
  expect(weak.isComplete()).toBe(false);

  const failed = createCpyGate();
  failed.toolEnded('[exit 1]\nFAILED');
  await failed.chat(msgs(['user', 'task']), scripted({ content: 'All 3 tests pass.' }).send);
  expect(failed.isComplete()).toBe(false);
  expect(failed.reminder).toBe(CPY_REMINDER);
});

test('after the reminder a reply that admits a gap gets one nudge, billed as one turn with all usage fields', async () => {
  let extra = 0;
  const g = createCpyGate({ onExtraTurn: () => extra++ });
  const s = scripted(
    { content: 'I have not verified it.', usage: { promptTokens: 10, completionTokens: 1, cacheReadInputTokens: 4, cacheCreationInputTokens: 2, costEstimate: 0.5 } },
    { content: '', toolCalls: [{ id: 'a', name: 'python', arguments: { code: '1' } }], usage: { promptTokens: 20, completionTokens: 2, cacheReadInputTokens: 8, cacheCreationInputTokens: 3, costEstimate: 1 } },
  );
  const res = await g.chat(msgs(['user', 'task'], ['user', CPY_REMINDER]), s.send);
  expect(extra).toBe(1);
  expect(res.toolCalls?.[0].id).toBe('a');
  expect(res.usage).toEqual({ promptTokens: 30, completionTokens: 3, cacheReadInputTokens: 12, cacheCreationInputTokens: 5, costEstimate: 1.5 });
  expect(s.seen[1].messages.at(-1)?.content).toMatch(/^Unverified/);
  // only once per run
  await g.chat(msgs(['user', 'task'], ['user', CPY_REMINDER]), scripted({ content: 'still unverified' }).send);
  expect(extra).toBe(1);
});

test('a call printed as JSON text runs as a python call; flagged errors retry once', async () => {
  const g = createCpyGate();
  const res = await g.chat(msgs(['user', 'task']), scripted({ content: '{"code": "print(1)"}' }).send);
  expect(res.toolCalls).toEqual([{ id: 'call_text_1', name: 'python', arguments: { code: 'print(1)' } }]);

  let n = 0;
  const flaky = async () => { if (n++ === 0) throw new Error('Response was flagged as potentially violating policy'); return { content: 'ok' }; };
  expect((await g.chat(msgs(['user', 'task']), flaky)).content).toBe('ok');
  await expect(g.chat(msgs(['user', 'task']), async () => { throw new Error('boom'); })).rejects.toThrow('boom');
});

test('old long tool outputs are clipped (keep 3, keep 1 after the reminder) unless trim is off', async () => {
  const big = 'x'.repeat(9000);
  const conv = msgs(['user', 'task'], ['tool', big], ['tool', big], ['tool', big], ['tool', big]);
  const clipped = (p: { messages: Array<{ content: string }> }) => p.messages.filter((m) => m.content.includes('elided')).length;
  const s = scripted({ content: 'x' }, { content: 'x' }, { content: 'x' });
  await createCpyGate().chat(conv, s.send);
  await createCpyGate().chat({ messages: [...conv.messages, { role: 'user', content: CPY_REMINDER }] }, s.send);
  await createCpyGate({ trim: false }).chat(conv, s.send);
  expect(s.seen.map(clipped)).toEqual([1, 3, 0]);
});

test('old run logs clip at 1500, old source prints keep the 8000 cap', () => {
  const call = (id: string, code: string) => ({ role: 'assistant', content: '', toolCalls: [{ id, arguments: { code } }] });
  const tool = (id: string) => ({ role: 'tool', content: 'y'.repeat(3000), toolCallId: id });
  const m = [call('a', "bash('make test')"), tool('a'), call('b', "print(open('x').read())"), tool('b'), ...['c', 'd', 'e'].flatMap((id) => [call(id, '1'), tool(id)])];
  const out = trimOldToolOutputs(m);
  expect([out[1].content.length < 1000, out[3].content.length]).toEqual([true, 3000]);
});

test('addUsage keeps one side when the other is missing', () => {
  expect(addUsage(undefined, { a: 1 })).toEqual({ a: 1 });
  expect(addUsage({ a: 1 }, undefined)).toEqual({ a: 1 });
});

test('python tool keeps state, isolates stdin and reports an empty call', async () => {
  const tool = createPythonTool({ python: 'python3', kernel: path.join(import.meta.dirname, 'cpy_kernel.py'), cwd: import.meta.dirname, timeoutMs: 10_000 });
  try {
    expect(await tool.execute({ code: 'x = 41' })).toBe('(no output)');
    expect(await tool.execute({ code: 'x + 1' })).toBe('42\n');
    expect(await tool.execute({ code: "bash('cat').code" })).toBe('0\n');
    expect(await tool.execute({ code: ' ' })).toMatch(/^Error: `code` is required/);
  } finally { await tool.close(); }
});

test('a reply whose only call has empty code is resampled once, billed together', async () => {
  let extra = 0;
  const g = createCpyGate({ onExtraTurn: () => extra++ });
  const empty = { content: '', toolCalls: [{ id: 'e', name: 'python', arguments: { code: ' ' } }], usage: { promptTokens: 5 } };
  const real = { content: '', toolCalls: [{ id: 'r', name: 'python', arguments: { code: 'print(1)' } }], usage: { promptTokens: 7 } };
  const s = scripted(empty, real);
  const res = await g.chat(msgs(['user', 'task']), s.send);
  expect([res.toolCalls?.[0].id, res.usage, extra, s.seen.length]).toEqual(['r', { promptTokens: 12 }, 1, 2]);
  expect(s.seen[1]).toBe(s.seen[0]); // same request, nothing added to history
  const twice = await createCpyGate().chat(msgs(['user', 'task']), scripted(empty, empty).send);
  expect(twice.toolCalls?.[0].id).toBe('e'); // still empty: the tool's error reaches the model
});

test('a stalled stream is left to Axiom\'s retry (it already retries "stream failed" up to 6x)', async () => {
  let n = 0;
  const send = async () => { n++; throw new Error('openai-codex stream failed for model m: stream stalled: no data for 120s'); };
  await expect(createCpyGate().chat(msgs(['user', 'task']), send)).rejects.toThrow('stream stalled');
  expect(n).toBe(1);
});
