/**
 * Renders a `ReadUsageResult` as `/tldr stats` reply text (DESIGN §2).
 *
 * In-chat stats always render with whatever identity the caller already
 * assembled — DESIGN §11: "In-chat `/tldr stats` uses real display names:
 * everyone in that chat can already see who is there." This module never
 * touches identity at all; it only formats the aggregate `UsageSummary` and
 * the budget headroom, in the chat's configured language.
 *
 * Plain text, not Telegram HTML — the caller (WS5's rendering pipeline, or
 * the dispatcher) is responsible for however it ultimately gets sent; this
 * module owns none of that and does not import `domain/render`.
 */
import { microsToUsd } from '../../domain/cost.js';
import type { RenderLanguage } from '../../domain/render/language.js';
import type { ReadUsageResult } from '../ports/driving/read-usage.js';

function formatUsd(micros: number): string {
  const usd = microsToUsd(micros);
  return usd.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

const LABELS: Readonly<
  Record<
    RenderLanguage,
    {
      readonly scopeChat: string;
      readonly scopeGlobal: string;
      readonly calls: string;
      readonly tokens: string;
      readonly cost: string;
      readonly budgetRemaining: string;
      readonly budgetExhausted: string;
      readonly perModel: string;
    }
  >
> = {
  en: {
    scopeChat: 'This chat',
    scopeGlobal: 'All chats (operator view)',
    calls: 'calls',
    tokens: 'tokens',
    cost: 'cost',
    budgetRemaining: 'remaining in today’s global budget',
    budgetExhausted: 'today’s global budget is exhausted',
    perModel: 'By model',
  },
  pl: {
    scopeChat: 'Ten czat',
    scopeGlobal: 'Wszystkie czaty (widok operatora)',
    calls: 'wywołań',
    tokens: 'tokenów',
    cost: 'koszt',
    budgetRemaining: 'pozostało z dzisiejszego globalnego budżetu',
    budgetExhausted: 'dzisiejszy globalny budżet jest wyczerpany',
    perModel: 'Według modelu',
  },
};

/** Renders one `ReadUsageResult` into plain-text lines ready to join with `\n`. */
export function formatUsageStats(result: ReadUsageResult, language: RenderLanguage): string {
  const labels = LABELS[language];
  const { summary, budgetRemainingMicros } = result;

  const lines: string[] = [
    result.scope.kind === 'chat' ? labels.scopeChat : labels.scopeGlobal,
    `${String(summary.calls)} ${labels.calls} · ${String(summary.inputTokens + summary.outputTokens)} ${labels.tokens} · ${labels.cost}: ${formatUsd(summary.costMicros)}`,
  ];

  const modelEntries = Object.entries(summary.byModel);
  if (modelEntries.length > 0) {
    lines.push(`${labels.perModel}:`);
    for (const [model, modelSummary] of modelEntries) {
      lines.push(
        `  ${model}: ${String(modelSummary.calls)} ${labels.calls} · ${formatUsd(modelSummary.costMicros)}`,
      );
    }
  }

  if (budgetRemainingMicros !== null) {
    lines.push(
      budgetRemainingMicros > 0
        ? `${formatUsd(budgetRemainingMicros)} ${labels.budgetRemaining}`
        : labels.budgetExhausted,
    );
  }

  return lines.join('\n');
}
