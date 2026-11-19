import type { TokenUsage } from '../../nhom-30/axiom-cli/src/core/types.js';

export type CacheWriteType = 'ephemeral_5m' | 'ephemeral_1h' | 'unknown';

export interface NormalizedUsage {
  uncachedInput: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWriteType: CacheWriteType;
  output: number;
  totalInputAll: number;
  totalTokens: number;
}

export type PricingStatus = 'priced' | 'free' | 'unpriced';

export interface ModelPricingEntry {
  canonicalId: string;
  pricingStatus?: PricingStatus;
  inputPer1M: number | null;
  outputPer1M: number | null;
  cacheReadPer1M: number | null;
  cacheWrite5mPer1M: number | null;
  cacheWrite1hPer1M?: number | null;
  source: string;
  asOfDate: string;
}

export interface CostCalculation {
  costDollars: number | null;
  costKind: 'estimated' | 'unpriced';
  pricing: ModelPricingEntry;
  breakdown: {
    uncachedInputUsd: number | null;
    cacheReadUsd: number | null;
    cacheWriteUsd: number | null;
    outputUsd: number | null;
  };
}

export class UnknownModelPricingError extends Error {
  constructor(public readonly model: string, public readonly normalizedKey: string) {
    super(
      `Unknown model pricing for "${model}" (normalized: "${normalizedKey}"). ` +
        `Cost-measurement mode refuses silent fallback pricing; add an explicit entry to MODEL_PRICING_TABLE.`
    );
    this.name = 'UnknownModelPricingError';
  }
}

export const PRICING_SOURCE_DEFAULT = 'nhom-30/axiom-cli/src/llm/cost-tracker.ts + Anthropic prompt caching 1.25x 5m write multiplier';
export const PRICING_AS_OF_DATE = '2026-11-14';

export const MODEL_PRICING_TABLE: Record<string, ModelPricingEntry> = {
  'claude-haiku-5.5': {
    canonicalId: 'claude-haiku-5.5',
    inputPer1M: 0.10,
    outputPer1M: 0.50,
    cacheReadPer1M: 0.02,
    cacheWrite5mPer1M: 0.125,
    source: PRICING_SOURCE_DEFAULT,
    asOfDate: PRICING_AS_OF_DATE,
  },
  'claude-3-5-haiku': {
    canonicalId: 'claude-3-5-haiku',
    inputPer1M: 0.80,
    outputPer1M: 4.00,
    cacheReadPer1M: 0.08,
    cacheWrite5mPer1M: 1.00,
    source: PRICING_SOURCE_DEFAULT,
    asOfDate: PRICING_AS_OF_DATE,
  },
  'claude-3-5-sonnet': {
    canonicalId: 'claude-3-5-sonnet',
    inputPer1M: 3.00,
    outputPer1M: 15.00,
    cacheReadPer1M: 0.30,
    cacheWrite5mPer1M: 3.75,
    source: PRICING_SOURCE_DEFAULT,
    asOfDate: PRICING_AS_OF_DATE,
  },
  'claude-3-7-sonnet': {
    canonicalId: 'claude-3-7-sonnet',
    inputPer1M: 3.00,
    outputPer1M: 15.00,
    cacheReadPer1M: 0.30,
    cacheWrite5mPer1M: 3.75,
    source: PRICING_SOURCE_DEFAULT,
    asOfDate: PRICING_AS_OF_DATE,
  },
  'gpt-4o': {
    canonicalId: 'gpt-4o',
    inputPer1M: 2.50,
    outputPer1M: 10.00,
    cacheReadPer1M: 1.25,
    cacheWrite5mPer1M: 2.50,
    source: 'nhom-30/axiom-cli/src/llm/cost-tracker.ts',
    asOfDate: PRICING_AS_OF_DATE,
  },
  'gpt-4o-mini': {
    canonicalId: 'gpt-4o-mini',
    inputPer1M: 0.15,
    outputPer1M: 0.60,
    cacheReadPer1M: 0.075,
    cacheWrite5mPer1M: 0.15,
    source: 'nhom-30/axiom-cli/src/llm/cost-tracker.ts',
    asOfDate: PRICING_AS_OF_DATE,
  },
  'gemini-2.5-flash': {
    canonicalId: 'gemini-2.5-flash',
    inputPer1M: 0.15,
    outputPer1M: 0.60,
    cacheReadPer1M: 0.0375,
    cacheWrite5mPer1M: 0.15,
    source: 'nhom-30/axiom-cli/src/llm/cost-tracker.ts',
    asOfDate: PRICING_AS_OF_DATE,
  },
  'gemini-2.5-pro': {
    canonicalId: 'gemini-2.5-pro',
    inputPer1M: 1.25,
    outputPer1M: 5.00,
    cacheReadPer1M: 0.3125,
    cacheWrite5mPer1M: 1.25,
    source: 'nhom-30/axiom-cli/src/llm/cost-tracker.ts',
    asOfDate: PRICING_AS_OF_DATE,
  },
};

const MODEL_ALIASES: Record<string, string> = {
  'claude-haiku-5-5': 'claude-haiku-5.5',
  'claude-haiku-5.5': 'claude-haiku-5.5',
};

const KNOWN_UNPRICED_MODELS = new Set<string>([
  'deepseek-v4-1-flash',
]);

export interface ResolvePricingOptions {
  allowUnpriced?: boolean;
}

function makeUnpricedEntry(canonicalId: string, source: string): ModelPricingEntry {
  return {
    canonicalId,
    pricingStatus: 'unpriced',
    inputPer1M: null,
    outputPer1M: null,
    cacheReadPer1M: null,
    cacheWrite5mPer1M: null,
    source,
    asOfDate: PRICING_AS_OF_DATE,
  };
}

export function finiteNonNegInt(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function canonicalizeModelId(model: string): string {
  const normalized = model.toLowerCase().trim();
  const slashIdx = normalized.indexOf('/');
  const withoutPrefix = slashIdx !== -1 ? normalized.slice(slashIdx + 1) : normalized;
  return MODEL_ALIASES[withoutPrefix] ?? withoutPrefix;
}

export function resolveModelPricing(model: string, opts?: ResolvePricingOptions): ModelPricingEntry {
  const normalized = model.toLowerCase().trim();
  if (normalized.endsWith(':free') || normalized.includes(':free')) {
    return {
      canonicalId: normalized,
      pricingStatus: 'free',
      inputPer1M: 0,
      outputPer1M: 0,
      cacheReadPer1M: 0,
      cacheWrite5mPer1M: 0,
      source: 'free-tier',
      asOfDate: PRICING_AS_OF_DATE,
    };
  }

  const canonical = canonicalizeModelId(model);
  if (MODEL_PRICING_TABLE[canonical]) {
    return { pricingStatus: 'priced', ...MODEL_PRICING_TABLE[canonical] };
  }

  const candidates = Object.keys(MODEL_PRICING_TABLE).sort((a, b) => b.length - a.length);
  for (const key of candidates) {
    const suffix = canonical.slice(key.length);
    if (canonical.startsWith(key) && /^(?:-\d{4,}|-latest|-v\d+|\/|$)/.test(suffix)) {
      return { pricingStatus: 'priced', ...MODEL_PRICING_TABLE[key] };
    }
  }

  if (KNOWN_UNPRICED_MODELS.has(canonical)) {
    return makeUnpricedEntry(canonical, 'unpriced-catalog-model');
  }

  if (opts?.allowUnpriced) {
    return makeUnpricedEntry(canonical, 'unpriced-fallback');
  }

  throw new UnknownModelPricingError(model, canonical);
}

/**
 * Normalizes Axiom/Anthropic provider usage at the boundary.
 * In Axiom's AnthropicProvider (`src/llm/providers/anthropic.ts`), `promptTokens` is `usage.input_tokens`
 * (already uncached input), while `cacheReadInputTokens` and `cacheCreationInputTokens` are separate.
 * We never subtract cache from `promptTokens`.
 */
export function normalizeProviderUsage(
  usage: Partial<TokenUsage>,
  cacheWriteType: CacheWriteType = 'ephemeral_5m',
): NormalizedUsage {
  const uncachedInput = finiteNonNegInt(usage.promptTokens);
  const cacheRead = finiteNonNegInt(usage.cacheReadInputTokens);
  const cacheWrite = finiteNonNegInt(usage.cacheCreationInputTokens);
  const output = finiteNonNegInt(usage.completionTokens);
  const totalInputAll = uncachedInput + cacheRead + cacheWrite;
  const totalTokens = totalInputAll + output;

  return {
    uncachedInput,
    cacheRead,
    cacheWrite,
    cacheWriteType,
    output,
    totalInputAll,
    totalTokens,
  };
}

export function calculateNormalizedCost(
  model: string,
  usage: NormalizedUsage,
  opts?: ResolvePricingOptions,
): CostCalculation {
  const pricing = resolveModelPricing(model, opts);
  if (
    pricing.pricingStatus === 'unpriced' ||
    pricing.inputPer1M === null ||
    pricing.outputPer1M === null ||
    pricing.cacheReadPer1M === null ||
    pricing.cacheWrite5mPer1M === null
  ) {
    return {
      costDollars: null,
      costKind: 'unpriced',
      pricing,
      breakdown: {
        uncachedInputUsd: null,
        cacheReadUsd: null,
        cacheWriteUsd: null,
        outputUsd: null,
      },
    };
  }

  const cacheWriteRate =
    usage.cacheWriteType === 'ephemeral_1h' && pricing.cacheWrite1hPer1M != null
      ? pricing.cacheWrite1hPer1M
      : pricing.cacheWrite5mPer1M;

  const uncachedInputUsd = (usage.uncachedInput * pricing.inputPer1M) / 1_000_000;
  const cacheReadUsd = (usage.cacheRead * pricing.cacheReadPer1M) / 1_000_000;
  const cacheWriteUsd = (usage.cacheWrite * cacheWriteRate) / 1_000_000;
  const outputUsd = (usage.output * pricing.outputPer1M) / 1_000_000;
  const costDollars = Number((uncachedInputUsd + cacheReadUsd + cacheWriteUsd + outputUsd).toFixed(6));

  return {
    costDollars,
    costKind: 'estimated',
    pricing,
    breakdown: {
      uncachedInputUsd: Number(uncachedInputUsd.toFixed(6)),
      cacheReadUsd: Number(cacheReadUsd.toFixed(6)),
      cacheWriteUsd: Number(cacheWriteUsd.toFixed(6)),
      outputUsd: Number(outputUsd.toFixed(6)),
    },
  };
}

export function aggregateNormalizedUsage(
  requests: readonly NormalizedUsage[],
  model: string,
  opts?: ResolvePricingOptions,
): { totals: NormalizedUsage; cost: CostCalculation } {
  const totals: NormalizedUsage = {
    uncachedInput: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWriteType: 'ephemeral_5m',
    output: 0,
    totalInputAll: 0,
    totalTokens: 0,
  };
  for (const r of requests) {
    totals.uncachedInput += r.uncachedInput;
    totals.cacheRead += r.cacheRead;
    totals.cacheWrite += r.cacheWrite;
    totals.output += r.output;
  }
  totals.totalInputAll = totals.uncachedInput + totals.cacheRead + totals.cacheWrite;
  totals.totalTokens = totals.totalInputAll + totals.output;

  return {
    totals,
    cost: calculateNormalizedCost(model, totals, opts),
  };
}
