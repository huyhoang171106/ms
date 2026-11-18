import { expect, test } from "bun:test";
import { normalizeTokenTotals } from "./usage_single_tool";

const usage = { promptTokens: 100, completionTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 10 };
test("Anthropic cache input is separate from uncached input", () => {
  expect(normalizeTokenTotals("anthropic-messages", usage, true)).toEqual({ totalTokens: 160, cacheHitRate: 0.2143 });
});
test("OpenAI cache read is included in prompt input", () => {
  expect(normalizeTokenTotals("openai-completions", { ...usage, cacheCreationInputTokens: 0 }, true)).toEqual({ totalTokens: 120, cacheHitRate: 0.3 });
});
test("unknown or incomplete usage is not presented as a total", () => {
  expect(normalizeTokenTotals("unknown", usage, true)).toEqual({ totalTokens: null, cacheHitRate: null });
  expect(normalizeTokenTotals("anthropic-messages", usage, false)).toEqual({ totalTokens: null, cacheHitRate: null });
});
