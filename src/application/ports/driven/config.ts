/**
 * `Config` — typed read of the resolved configuration (DESIGN §3, §10).
 *
 * **No `config-layers` type crosses this boundary.** The port exposes a typed
 * view of `ResolvedConfig`, not a `LayeredConfig`; `ConfigOrigin` is our own
 * shape, not the library's `ConfigInspectionResult`.
 *
 * Layers, lowest priority first: `defaults` → `file` → `env` → `chat`
 * (DESIGN §10). The first three are built once at boot. The fourth is a derived
 * view per chat, cached and invalidated on write — a Proxy must not be
 * constructed per request.
 */
import type { ChatId } from '../../../domain/model/ids.js';
import type { ResolvedConfig } from '../../../config/schema.js';

export type ConfigLayerName = 'defaults' | 'file' | 'env' | 'chat';

/**
 * DESIGN §10: `__inspect(key)` reports which layer supplied a value. That
 * becomes the operator-only `config <key>` command, answering "why is this chat
 * on Haiku?" — otherwise a genuinely irritating thing to debug across four
 * layers.
 */
export interface ConfigOrigin {
  /** Dotted path, e.g. `models.default`. */
  readonly path: string;
  readonly value: unknown;
  readonly layer: ConfigLayerName;
  /** Every layer that had an opinion, lowest priority first. */
  readonly candidates: readonly {
    readonly layer: ConfigLayerName;
    readonly value: unknown;
    readonly active: boolean;
  }[];
}

/** The read side, shared by the global config and every per-chat derivation. */
export interface ConfigView {
  /** The whole frozen snapshot. Nothing mutates config at runtime (DESIGN §10). */
  all(): ResolvedConfig;

  /** Typed section read: `config.get('limits').maxInputTokens`. */
  get<K extends keyof ResolvedConfig>(section: K): ResolvedConfig[K];

  inspect(path: string): ConfigOrigin;
}

export interface ChatConfigView extends ConfigView {
  readonly chatId: ChatId;
}

export interface Config extends ConfigView {
  /**
   * The `chat` layer applied on top (DESIGN §10, `__derive`). Cached per
   * `chatId`; a settings write calls `invalidateChat` and the next read sees it.
   */
  forChat(chatId: ChatId): Promise<ChatConfigView>;

  /** Called by `UpdateChatSetting` after a successful write. */
  invalidateChat(chatId: ChatId): void;
}
