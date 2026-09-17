/**
 * `/tldr stats [global]` — usage and cost (DESIGN §2, §9, §11).
 *
 * Two scopes, and the tier requirement differs by *which one was asked for*,
 * not just by the command name: chat-admin for the caller's own chat,
 * operator for `global`. `COMMAND_TIERS.stats` (domain/permissions.ts)
 * records only the floor (`chatAdmin`, enforced before this handler ever
 * runs); the stricter `operator` bound for `global` is enforced here, by
 * throwing the same `PermissionDeniedError` the dispatcher already knows how
 * to turn into a reply.
 *
 * The reporting window is fixed at the last 24h: DESIGN does not specify one,
 * and a rolling day is the smallest window that is still useful for "is the
 * bot behaving right now" without requiring its own range grammar.
 */
import { escapeHtml } from './html.js';
import type { CommandContext, CommandResult } from './types.js';
import { languageOf } from './types.js';
import type { UsageScope } from '../../../../application/ports/driving/read-usage.js';
import { PermissionDeniedError } from '../../../../domain/errors.js';
import type { UsageSummary } from '../../../../domain/model/usage.js';
import type { RenderLanguage } from '../../../../domain/render/language.js';

const STATS_WINDOW_HOURS = 24;

function formatUsd(costMicros: number): string {
  return (costMicros / 1_000_000).toFixed(4);
}

function summaryLines(language: RenderLanguage, summary: UsageSummary): string[] {
  const lines: string[] = [];
  if (language === 'pl') {
    lines.push(
      `Wywołania: ${String(summary.calls)}`,
      `Tokeny: ${String(summary.inputTokens)} wejście / ${String(summary.outputTokens)} wyjście`,
      `Koszt: $${formatUsd(summary.costMicros)}`,
    );
  } else {
    lines.push(
      `Calls: ${String(summary.calls)}`,
      `Tokens: ${String(summary.inputTokens)} in / ${String(summary.outputTokens)} out`,
      `Cost: $${formatUsd(summary.costMicros)}`,
    );
  }
  for (const [model, byModel] of Object.entries(summary.byModel).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${escapeHtml(model)}: ${String(byModel.calls)} × $${formatUsd(byModel.costMicros)}`);
  }
  return lines;
}

function statsText(
  language: RenderLanguage,
  scope: UsageScope,
  summary: UsageSummary,
  budgetRemainingMicros: number | null,
): string {
  const header =
    scope.kind === 'global'
      ? language === 'pl'
        ? `Statystyki globalne (ostatnie ${String(STATS_WINDOW_HOURS)}h):`
        : `Global stats (last ${String(STATS_WINDOW_HOURS)}h):`
      : language === 'pl'
        ? `Statystyki tego czatu (ostatnie ${String(STATS_WINDOW_HOURS)}h):`
        : `This chat's stats (last ${String(STATS_WINDOW_HOURS)}h):`;
  const lines = [header, ...summaryLines(language, summary)];
  if (budgetRemainingMicros !== null) {
    lines.push(
      language === 'pl'
        ? `Pozostały dzienny budżet: $${formatUsd(budgetRemainingMicros)}`
        : `Remaining daily budget: $${formatUsd(budgetRemainingMicros)}`,
    );
  }
  return lines.join('\n');
}

export async function runStats(ctx: CommandContext): Promise<CommandResult> {
  const { invocation, deps, args } = ctx;
  const language = languageOf(deps);
  const wantsGlobal = args.trim().toLowerCase() === 'global';

  if (wantsGlobal && invocation.invoker.tier !== 'operator') {
    // DESIGN §2: global stats are operator-only, stricter than the chatAdmin
    // floor the dispatcher already checked for `stats` in general.
    throw new PermissionDeniedError('operator', invocation.invoker.tier);
  }

  const scope: UsageScope = wantsGlobal ? { kind: 'global' } : { kind: 'chat', chatId: invocation.chatId };
  const until = deps.clock.now();
  const since = until.subtract({ hours: STATS_WINDOW_HOURS });
  const result = await deps.readUsage.execute({
    scope,
    since,
    until,
    requestedBy: invocation.invoker.userId,
  });

  await deps.gateway.sendText(invocation.chatId, {
    text: statsText(language, scope, result.summary, result.budgetRemainingMicros),
    threadId: invocation.threadId,
    replyToMessageId: invocation.invokedMessageId,
  });
  return { kind: 'replied' };
}
