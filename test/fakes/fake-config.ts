/**
 * In-memory `Config` (DESIGN §10).
 *
 * Four layers, resolved in the real order — `defaults` -> `file` -> `env` ->
 * `chat` — so that a test can assert precedence and `inspect()` answers the
 * question the operator `config <key>` command exists to answer ("why is this
 * chat on Haiku?").
 *
 * It validates its own resolved snapshot with `resolvedConfigSchema`, which
 * means a test that builds a nonsense override fails at construction rather
 * than three assertions later.
 */
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { resolvedConfigSchema } from '../../src/config/schema.js';
import type { ChatLayer, ConfigLayer, ResolvedConfig } from '../../src/config/schema.js';
import type { ChatId } from '../../src/domain/model/ids.js';
import type {
  ChatConfigView,
  Config,
  ConfigLayerName,
  ConfigOrigin,
} from '../../src/application/ports/driven/config.js';

export type Plain = Record<string, unknown>;

function isPlainObject(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deepMerge(base: Plain, patch: Plain): Plain {
  const out: Plain = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const existing = out[key];
    out[key] =
      isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return out;
}

function valueAt(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** The env layer a test needs so that the resolved snapshot is actually valid. */
export const TEST_ENV_LAYER: ConfigLayer = {
  telegram: { token: 'test-bot-token', operatorUserIds: [] },
};

/** The file layer a test needs: a non-empty allowlist, or the bot leaves every chat. */
export const TEST_FILE_LAYER: ConfigLayer = {
  telegram: { allowlist: [-1000000000001] },
  bot: { operatorContact: '@test-operator' },
};

export interface FakeConfigOptions {
  readonly file?: ConfigLayer;
  readonly env?: ConfigLayer;
  readonly chats?: ReadonlyMap<ChatId, ChatLayer>;
}

export class FakeConfig implements Config {
  readonly #layers: readonly { name: ConfigLayerName; layer: ConfigLayer }[];
  readonly #resolved: ResolvedConfig;
  readonly #chats: Map<ChatId, ChatLayer>;
  readonly #derivedCache = new Map<ChatId, ChatConfigView>();
  /** Counts `__derive` equivalents, so a cache test can prove one is not built per read. */
  derivations = 0;

  constructor(options: FakeConfigOptions = {}) {
    this.#layers = [
      { name: 'defaults', layer: DEFAULT_CONFIG as ConfigLayer },
      { name: 'file', layer: options.file ?? TEST_FILE_LAYER },
      { name: 'env', layer: options.env ?? TEST_ENV_LAYER },
    ];
    this.#resolved = this.#resolve([]);
    this.#chats = new Map(options.chats ?? []);
  }

  all(): ResolvedConfig {
    return this.#resolved;
  }

  get<K extends keyof ResolvedConfig>(section: K): ResolvedConfig[K] {
    return this.#resolved[section];
  }

  inspect(path: string): ConfigOrigin {
    return this.#inspect(path, []);
  }

  async forChat(chatId: ChatId): Promise<ChatConfigView> {
    const cached = this.#derivedCache.get(chatId);
    if (cached !== undefined) return await Promise.resolve(cached);

    this.derivations += 1;
    const chatLayer = (this.#chats.get(chatId) ?? {}) as ConfigLayer;
    const resolved = this.#resolve([chatLayer]);
    const view: ChatConfigView = {
      chatId,
      all: () => resolved,
      get: (section) => resolved[section],
      inspect: (path) => this.#inspect(path, [chatLayer]),
    };
    this.#derivedCache.set(chatId, view);
    return await Promise.resolve(view);
  }

  invalidateChat(chatId: ChatId): void {
    this.#derivedCache.delete(chatId);
  }

  /* ---------------------------- test helpers ----------------------------- */

  /** Simulates a settings command writing the `chat` layer. Does not invalidate. */
  setChatLayer(chatId: ChatId, layer: ChatLayer): void {
    this.#chats.set(chatId, layer);
  }

  /* ------------------------------ internals ------------------------------ */

  #resolve(extra: readonly ConfigLayer[]): ResolvedConfig {
    let merged: Plain = {};
    for (const { layer } of this.#layers) merged = deepMerge(merged, layer as Plain);
    for (const layer of extra) merged = deepMerge(merged, layer as Plain);
    return resolvedConfigSchema.parse(merged);
  }

  #inspect(path: string, extra: readonly ConfigLayer[]): ConfigOrigin {
    const all: { name: ConfigLayerName; layer: ConfigLayer }[] = [
      ...this.#layers,
      ...extra.map((layer) => ({ name: 'chat' as ConfigLayerName, layer })),
    ];
    const candidates = all.map(({ name, layer }) => ({
      layer: name,
      value: valueAt(layer, path),
      active: false,
    }));
    let winner = candidates.length - 1;
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      if (candidates[i]?.value !== undefined) {
        winner = i;
        break;
      }
    }
    const marked = candidates.map((candidate, index) => ({
      ...candidate,
      active: index === winner,
    }));
    return {
      path,
      value: candidates[winner]?.value,
      layer: marked[winner]?.layer ?? 'defaults',
      candidates: marked,
    };
  }
}
