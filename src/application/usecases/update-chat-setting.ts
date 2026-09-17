/**
 * `UpdateChatSetting` — `/tldr tz`, `/tldr model`, `/tldr dm` (DESIGN §2, §10).
 *
 * "A write here must invalidate the per-chat derived config cache (DESIGN §10):
 * chat settings are live precisely because they are a DB-backed configuration
 * layer." That pairing — write, then invalidate — is the entire reason this use
 * case exists rather than the command handlers calling `SettingsStore`
 * directly.
 *
 * Validation is deliberately *not* here: the port's own contract says a
 * `ChatSettingChange` arrives carrying a zone already proven real and an alias
 * already proven to exist in the registry (`commands/tz.ts`, `commands/model.ts`).
 * Re-validating would put a second, drifting copy of those rules one layer down.
 *
 * `dmDelivery` writes `user_prefs`, not `chat_settings`: it is a per-user
 * preference a member sets for themselves (DESIGN §2, §8), so it is not part of
 * the `chat` config layer and invalidating the derived config for it would be
 * pointless cache churn.
 */
import type { Config } from '../ports/driven/config.js';
import type { SettingsStore } from '../ports/driven/settings-store.js';
import type {
  UpdateChatSetting,
  UpdateChatSettingCommand,
  UpdateChatSettingResult,
} from '../ports/driving/update-chat-setting.js';

export interface UpdateChatSettingDeps {
  readonly settings: SettingsStore;
  readonly config: Config;
}

export class UpdateChatSettingUseCase implements UpdateChatSetting {
  readonly #deps: UpdateChatSettingDeps;

  constructor(deps: UpdateChatSettingDeps) {
    this.#deps = deps;
  }

  async execute(command: UpdateChatSettingCommand): Promise<UpdateChatSettingResult> {
    const { chatId, change, requestedBy, at } = command;
    const { settings, config } = this.#deps;

    if (change.kind === 'dmDelivery') {
      const prefs = await settings.putUserPrefs(chatId, requestedBy, { dmDelivery: change.enabled });
      return { kind: 'userPrefs', prefs };
    }

    const patch =
      change.kind === 'timeZone' ? { tz: change.timeZone } : { modelAlias: change.alias };
    const updated = await settings.putChatSettings(chatId, patch, requestedBy, at);
    config.invalidateChat(chatId);
    return { kind: 'chatSettings', settings: updated };
  }
}
