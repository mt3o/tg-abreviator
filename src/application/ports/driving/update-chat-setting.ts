/**
 * `UpdateChatSetting` — `/tldr tz`, `/tldr model`, `/tldr dm` (DESIGN §2, §3).
 *
 * Writing a chat setting writes SQLite *and* invalidates the derived config for
 * that chat (DESIGN §10): chat settings are live precisely because they are a
 * DB-backed configuration layer.
 *
 * TTL is deliberately absent. It is operator-only and lives in the config file:
 * a group admin extending retention would be doing it to other people's
 * messages (DESIGN §2).
 */
import type { Temporal } from '../../../domain/time/temporal.js';
import type { ChatId, UserId } from '../../../domain/model/ids.js';
import type { TimeZoneId } from '../../../domain/time/temporal.js';
import type { ChatSettings, UserPrefs } from '../../../domain/model/settings.js';

export type ChatSettingChange =
  /** chat admin. Validated as a real IANA zone before the write. */
  | { readonly kind: 'timeZone'; readonly timeZone: TimeZoneId }
  /** chat admin. Validated against the model registry before the write. */
  | { readonly kind: 'model'; readonly alias: string }
  /** member, and only for themselves (DESIGN §2). */
  | { readonly kind: 'dmDelivery'; readonly enabled: boolean };

export interface UpdateChatSettingCommand {
  readonly chatId: ChatId;
  readonly change: ChatSettingChange;
  readonly requestedBy: UserId;
  readonly at: Temporal.Instant;
}

export type UpdateChatSettingResult =
  | { readonly kind: 'chatSettings'; readonly settings: ChatSettings }
  | { readonly kind: 'userPrefs'; readonly prefs: UserPrefs };

export interface UpdateChatSetting {
  execute(command: UpdateChatSettingCommand): Promise<UpdateChatSettingResult>;
}
