/**
 * Responses API request shaping that Axiom's wire lacks and pi/codex have: each turn's reasoning items are replayed
 * (encrypted, `store:false`) ahead of the output they led to, plus `prompt_cache_key` and `text.verbosity`.
 * Without replay the model starts every turn with no memory of its own plan (luna, tb21-luna-lean20-30: 0.3 empty
 * `{"code":""}` calls per run, re-reads). Implemented as a `fetch` wrapper so Axiom itself is untouched: Axiom's
 * Responses routes call the global `fetch` per request with a JSON body that has `input`.
 */
type Item = Record<string, unknown>;

export interface ReplayOptions {
  /** Shared by every request of one run so the backend routes them to the same prompt cache. */
  cacheKey: string;
  verbosity?: 'low' | 'medium' | 'high';
}

/** Returns a fetch that shapes `/responses` POSTs and records reasoning from their streams; other requests pass through. */
export function responsesReplayFetch(base: typeof fetch, opts: ReplayOptions): typeof fetch {
  const reasoning = new Map<string, Item[]>(); // call_id or "text:<assistant text>" -> reasoning items of that turn
  let parsing: Promise<void> = Promise.resolve();

  const wrapped = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!/\/responses(\?|$)/.test(url) || init?.method !== 'POST' || typeof init.body !== 'string') return base(input, init);
    let body: Item;
    try { body = JSON.parse(init.body); } catch { return base(input, init); }
    if (!Array.isArray(body.input)) return base(input, init);

    await parsing; // the previous turn's stream must be fully recorded before its reasoning can be replayed
    const include = new Set([...(Array.isArray(body.include) ? body.include : []), 'reasoning.encrypted_content']);
    const shaped = {
      ...body,
      input: withReasoning(body.input as Item[], reasoning),
      include: [...include],
      prompt_cache_key: body.prompt_cache_key ?? opts.cacheKey,
      text: { ...(body.text as Item | undefined), verbosity: opts.verbosity ?? 'low' },
    };
    const res = await base(input, { ...init, body: JSON.stringify(shaped) });
    if (!res.ok || !res.body) return res;
    const [mine, theirs] = res.body.tee();
    parsing = record(mine, reasoning).catch(() => {}); // a broken stream only loses replay for that turn
    return new Response(theirs, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  return Object.assign(wrapped, base) as typeof fetch;
}

/** Puts each recorded turn's reasoning right before that turn's first output item (its text message, else its first call). */
export function withReasoning(input: Item[], reasoning: Map<string, Item[]>): Item[] {
  const out: Item[] = [];
  const used = new Set<Item[]>();
  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    const items = item.type === 'function_call' ? reasoning.get(String(item.call_id))
      : item.type === 'message' && item.role === 'assistant' ? reasoning.get(`text:${assistantText(item)}`) : undefined;
    if (items && !used.has(items)) {
      used.add(items);
      // Axiom emits an assistant turn as [message?, function_call...]; the reasoning precedes the whole turn.
      const prev = out.at(-1);
      const at = item.type === 'function_call' && prev?.type === 'message' && prev.role === 'assistant' ? out.length - 1 : out.length;
      out.splice(at, 0, ...items);
    }
    out.push(item);
  }
  return out;
}

const assistantText = (m: Item) => (Array.isArray(m.content) ? m.content : []).map((c: Item) => String(c.text ?? '')).join('');

async function record(stream: ReadableStream<Uint8Array>, reasoning: Map<string, Item[]>): Promise<void> {
  const items: Item[] = [];
  const keys: string[] = [];
  let text = '';
  let buf = '';
  const decoder = new TextDecoder();
  const take = (line: string) => {
    if (!line.startsWith('data:')) return;
    let ev: Item;
    try { ev = JSON.parse(line.slice(5).trim()); } catch { return; }
    if (ev.type !== 'response.output_item.done') return;
    const item = ev.item as Item | undefined;
    if (item?.type === 'reasoning' && item.encrypted_content) items.push(item);
    if (item?.type === 'function_call') keys.push(String(item.call_id));
    if (item?.type === 'message') text += assistantText(item);
  };
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    lines.forEach(take);
  }
  take(buf);
  if (!items.length) return;
  if (text) keys.push(`text:${text}`);
  for (const k of keys) reasoning.set(k, items);
}

/**
 * Fails a request whose response (headers or body) sends nothing for `idleMs`, so the caller can retry instead of
 * waiting out the whole episode: tb21-luna-lean30 fix-vuln sat 876s on one stalled stream until the 900s agent timeout.
 * Idle, not total: a long reply keeps streaming events. Axiom wraps the error as "stream failed", which it retries up to
 * 6x; so the idle limit times 6 must fit the agent timeout (lean34: 300s x stacked retries outlived the 900s budget).
 */
export function stallGuardFetch(base: typeof fetch, idleMs: number): typeof fetch {
  const wrapped = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const stalled = () => new Error(`stream stalled: no data for ${idleMs / 1000}s`);
    const abort = new AbortController();
    const headers = setTimeout(() => abort.abort(stalled()), idleMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, abort.signal]) : abort.signal;
    const res = await base(input, { ...init, signal }).finally(() => clearTimeout(headers));
    if (!res.body) return res;
    const reader = res.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const idle = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(stalled()), idleMs); });
        try {
          const { done, value } = await Promise.race([reader.read(), idle]);
          if (done) controller.close(); else controller.enqueue(value);
        } catch (err) {
          abort.abort(err);
          void reader.cancel(err).catch(() => {});
          controller.error(err);
        } finally { clearTimeout(timer); }
      },
      cancel(reason) { return reader.cancel(reason); },
    });
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  return Object.assign(wrapped, base) as typeof fetch;
}

/**
 * Routes every `/responses` request of one run to the same prompt cache, as pi does (body `prompt_cache_key` plus
 * `session-id` / `x-client-request-id` headers). Axiom sends neither: tb21-luna-lean38-43 C_py hit cache on 12% of
 * input vs pi 67%, codex 85%, though a simulated replay of those traces keeps ~83% of each request's prefix stable.
 */
export function sessionCacheFetch(base: typeof fetch, sessionId: string): typeof fetch {
  const wrapped = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!/\/responses(\?|$)/.test(url) || init?.method !== 'POST' || typeof init.body !== 'string') return base(input, init);
    let body: Item;
    try { body = JSON.parse(init.body); } catch { return base(input, init); }
    const headers = new Headers(init.headers);
    headers.set('session-id', sessionId);
    headers.set('x-client-request-id', sessionId);
    return base(input, { ...init, headers, body: JSON.stringify({ ...body, prompt_cache_key: body.prompt_cache_key ?? sessionId }) });
  };
  return Object.assign(wrapped, base) as typeof fetch;
}
