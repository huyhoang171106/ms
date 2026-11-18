/** Normalize only wire formats whose cache semantics are known. */
export function normalizeTokenTotals(
  api: string | undefined,
  usage: { promptTokens: number; completionTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number },
  complete: boolean,
): { totalTokens: number | null; cacheHitRate: number | null } {
  if (!complete) return { totalTokens: null, cacheHitRate: null };
  const read = usage.cacheReadInputTokens ?? 0;
  const write = usage.cacheCreationInputTokens ?? 0;
  let allInput: number;
  if (api === "anthropic-messages") allInput = usage.promptTokens + read + write;
  else if (api === "openai-completions") allInput = usage.promptTokens;
  else return { totalTokens: null, cacheHitRate: null };
  return {
    totalTokens: allInput + usage.completionTokens,
    cacheHitRate: allInput > 0 ? Number((read / allInput).toFixed(4)) : 0,
  };
}
