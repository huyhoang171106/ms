import { expect, test } from 'bun:test';

import { responsesReplayFetch, withReasoning } from './responses-replay.ts';

const sse = (...events: object[]) => new Response(events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200 });
const done = (item: object) => ({ type: 'response.output_item.done', item });
const R1 = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc1' };
const R2 = { type: 'reasoning', id: 'rs_2', summary: [], encrypted_content: 'enc2' };

test('replays each turn\'s reasoning before that turn and shapes the request', async () => {
  const bodies: Array<Record<string, any>> = [];
  const replies = [
    sse(done(R1), done({ type: 'function_call', call_id: 'c1', name: 'python', arguments: '{"code":"1"}' })),
    sse(done(R2), done({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] })),
    sse(),
  ];
  const base = (async (_url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return replies.shift()!; }) as unknown as typeof fetch;
  const f = responsesReplayFetch(base, { cacheKey: 'k' });
  const post = async (input: object[]) => (await f('https://x/backend-api/codex/responses', { method: 'POST', body: JSON.stringify({ input, include: ['a'] }) })).text();

  const user = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'task' }] };
  const call = { type: 'function_call', call_id: 'c1', name: 'python', arguments: '{"code":"1"}' };
  const out = { type: 'function_call_output', call_id: 'c1', output: '1' };
  const final = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] };
  const reminder = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'You stopped.' }] };

  expect(await post([user])).toContain('rs_1'); // the caller still gets the whole stream
  await post([user, call, out]);
  await post([user, call, out, final, reminder]);

  expect(bodies[0]).toMatchObject({ include: ['a', 'reasoning.encrypted_content'], prompt_cache_key: 'k', text: { verbosity: 'low' } });
  expect(bodies[1].input).toEqual([user, R1, call, out]);
  expect(bodies[2].input).toEqual([user, R1, call, out, R2, final, reminder]);
});

test('reasoning goes before the assistant text of a turn that also called tools, once per turn', () => {
  const msg = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Plan' }] };
  const a = { type: 'function_call', call_id: 'a' }, b = { type: 'function_call', call_id: 'b' };
  const items = [R1];
  expect(withReasoning([msg, a, b], new Map([['a', items], ['b', items]]))).toEqual([R1, msg, a, b]);
});

test('other requests and non-JSON bodies pass through untouched', async () => {
  const seen: Array<RequestInit | undefined> = [];
  const base = (async (_u: string, init?: RequestInit) => { seen.push(init); return new Response('ok'); }) as unknown as typeof fetch;
  const f = responsesReplayFetch(base, { cacheKey: 'k' });
  await f('https://x/v1/messages', { method: 'POST', body: '{"input":[]}' });
  await f('https://x/responses', { method: 'POST', body: 'not json' });
  await f('https://x/responses', { method: 'GET' });
  expect(seen.map((i) => i?.body)).toEqual(['{"input":[]}', 'not json', undefined]);
});
