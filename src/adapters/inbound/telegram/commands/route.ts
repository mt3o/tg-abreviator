/**
 * `/tldr`'s own leading-word dispatch (DESIGN §2's subcommand table): `help`,
 * `tz`, `model`, `dm`, `stats`, `config`, each matched only as a *whole*
 * leading word — never mid-question. "co ustalono w kwestii stats?" must not
 * trigger `/tldr stats`; only the leading token is ever a grammar attempt
 * (the same rule WS3's `parse()` applies to range tokens). Anything else —
 * including no leading word at all — is a range/question invocation
 * (`range.ts`).
 */
import { runConfigInspect } from './config-inspect.js';
import { runDm } from './dm.js';
import { runHelp } from './help.js';
import { runModel } from './model.js';
import { runRange } from './range.js';
import { runStats } from './stats.js';
import { runTz } from './tz.js';
import type { CommandContext, CommandResult } from './types.js';
import type { CommandName } from '../../../../domain/permissions.js';

export interface ResolvedTldrCommand {
  readonly name: CommandName;
  /**
   * For a matched subcommand, everything after the keyword, trimmed of its
   * leading whitespace. For the range/question fallback, `args` verbatim.
   */
  readonly args: string;
  readonly run: (ctx: CommandContext) => Promise<CommandResult>;
}

interface Subcommand {
  readonly name: CommandName;
  readonly run: (ctx: CommandContext) => Promise<CommandResult>;
}

const SUBCOMMANDS: Readonly<Record<string, Subcommand>> = Object.freeze({
  help: { name: 'help', run: runHelp },
  tz: { name: 'tz', run: runTz },
  model: { name: 'model', run: runModel },
  dm: { name: 'dm', run: runDm },
  stats: { name: 'stats', run: runStats },
  config: { name: 'config', run: runConfigInspect },
});

/** `args` is everything after `/tldr` (or its configured name), verbatim. */
export function resolveTldrCommand(args: string): ResolvedTldrCommand {
  const trimmed = args.trim();
  const boundary = trimmed.search(/\s/);
  const leadingWord = (boundary === -1 ? trimmed : trimmed.slice(0, boundary)).toLowerCase();
  const subcommand = SUBCOMMANDS[leadingWord];

  if (subcommand === undefined) {
    return { name: 'tldr', args, run: runRange };
  }

  const rest = boundary === -1 ? '' : trimmed.slice(boundary).trimStart();
  return { name: subcommand.name, args: rest, run: subcommand.run };
}
