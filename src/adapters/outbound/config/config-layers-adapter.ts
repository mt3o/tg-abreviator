/**
 * `Config` adapter over `config-layers` (DESIGN §10, WS7).
 *
 * Layers, lowest priority first: `defaults` -> `file` -> `env` -> `chat`.
 * The first three are built once, here, at construction (`createConfig`).
 * The fourth is `__derive`d per chat on first read and cached until a
 * settings write calls `invalidateChat` (DESIGN §10: "a Proxy must not be
 * constructed per request").
 *
 * **No `config-layers` type crosses the `Config` port.** `ConfigHandle`,
 * `ConfigInspectionResult` and `LayerName` live only in this file;
 * `ConfigOrigin` (our own shape) is what `inspect()` returns.
 *
 * Boot sequence (DESIGN §10):
 *   1. Parse `config.yaml` — the caller's job; this adapter takes the parsed
 *      value (`fileConfig: unknown`), so it has no opinion on YAML vs JSON
 *      vs a hand-built object in a test.
 *   2. **Zod-validate each layer's shape** before handing it to `fromLayers`.
 *   3. Build the layered config.
 *   4. **Cross-validate the resolved snapshot** (`crossValidateResolved`),
 *      which cannot be a per-layer check — a routing rule in the file may
 *      legitimately name a model defined in `defaults`.
 *   5. Fail fast with a readable message: every issue found at any step is
 *      collected and thrown together as one `ConfigValidationError`, so a
 *      config file with three mistakes reports three mistakes.
 */
import { LayeredConfig } from 'config-layers';
import type { ConfigHandle, ConfigInspectionResult, DeepOptionalAndUndefined } from 'config-layers';
import type { ZodError } from 'zod';

import { DEFAULT_CONFIG } from '../../../config/defaults.js';
import {
  chatLayerFromSettings,
  configLayerSchema,
  crossValidateResolved,
  envLayerFromEnv,
  fileLayerSchema,
  resolvedConfigSchema,
} from '../../../config/schema.js';
import type { ConfigLayer, EnvSource, ResolvedConfig } from '../../../config/schema.js';
import { ConfigValidationError } from '../../../domain/errors.js';
import type { ConfigIssue } from '../../../domain/errors.js';
import type { ChatId } from '../../../domain/model/ids.js';
import type {
  ChatConfigView,
  Config,
  ConfigLayerName,
  ConfigOrigin,
} from '../../../application/ports/driven/config.js';
import type { SettingsStore } from '../../../application/ports/driven/settings-store.js';
import { zodErrorToConfigIssues } from './zod-issues.js';

/** Top-level sections of `ResolvedConfig`, in the order the schema declares them. */
const SECTION_NAMES = [
  'bot',
  'telegram',
  'database',
  'retention',
  'timezone',
  'models',
  'prompts',
  'limits',
  'guards',
  'delivery',
  'safety',
  'observability',
  'logging',
] as const satisfies readonly (keyof ResolvedConfig)[];

export interface CreateConfigOptions {
  /** `config.yaml`, already parsed (by the caller) into a plain object. */
  readonly fileConfig?: unknown;
  /** The process environment, or a test double. Never mutated. */
  readonly env: EnvSource;
  /** Backs the `chat` layer: `getChatSettings` feeds `chatLayerFromSettings`. */
  readonly settingsStore: SettingsStore;
}

/**
 * Validates the three boot-time layers, builds the layered config, and
 * cross-validates the resolved snapshot. Throws `ConfigValidationError` with
 * every issue found, rather than the first.
 */
export async function createConfig(options: CreateConfigOptions): Promise<Config> {
  const issues: ConfigIssue[] = [];

  const defaultsResult = configLayerSchema.safeParse(DEFAULT_CONFIG);
  if (!defaultsResult.success) {
    issues.push(...zodErrorToConfigIssues(defaultsResult.error, 'defaults'));
  }

  const fileResult = fileLayerSchema.safeParse(options.fileConfig ?? {});
  if (!fileResult.success) {
    issues.push(...zodErrorToConfigIssues(fileResult.error, 'file'));
  }

  let envLayer: ConfigLayer = {};
  try {
    envLayer = envLayerFromEnv(options.env);
  } catch (error) {
    issues.push(...zodEnvIssues(error));
  }

  if (issues.length > 0) {
    throw new ConfigValidationError(issues);
  }

  // Safe: both `safeParse` calls above succeeded, or we would have thrown.
  const defaultsLayer = defaultsResult.success ? defaultsResult.data : DEFAULT_CONFIG;
  const fileLayer = fileResult.success ? fileResult.data : {};

  const handle = await LayeredConfig.fromLayersAsync<ResolvedConfig>(
    [
      { name: 'defaults', config: asDeepPartial(defaultsLayer) },
      { name: 'file', config: asDeepPartial(fileLayer) },
      { name: 'env', config: asDeepPartial(envLayer) },
    ],
    // `observability.dsn` / `.release` are `string | null` by schema (unset
    // selects the no-op reporter, DESIGN §11) — without this, config-layers
    // treats a layer's explicit `null` as "absent" and falls through, which
    // for a key every layer leaves `null` resolves to `undefined` instead.
    { acceptNull: true },
  );

  const resolved = validateResolved(extractSections(handle), options.env, issues);

  return new ConfigLayersAdapter(handle, resolved, options.settingsStore);
}

/** Runs steps 4-5 (shape re-check + cross-validation) against a resolved snapshot. */
function validateResolved(
  candidate: unknown,
  env: EnvSource,
  priorIssues: readonly ConfigIssue[],
): ResolvedConfig {
  const shapeResult = resolvedConfigSchema.safeParse(candidate);
  if (!shapeResult.success) {
    throw new ConfigValidationError([
      ...priorIssues,
      ...zodErrorToConfigIssues(shapeResult.error, 'resolved'),
    ]);
  }

  const crossIssues = crossValidateResolved(shapeResult.data, env);
  if (crossIssues.length > 0) {
    throw new ConfigValidationError([...priorIssues, ...crossIssues]);
  }

  return shapeResult.data;
}

/** `envLayerSchema.parse` (inside `envLayerFromEnv`) throws a `ZodError` on a bad env var. */
function zodEnvIssues(error: unknown): ConfigIssue[] {
  if (error instanceof Error && error.name === 'ZodError') {
    // `envLayerFromEnv` lets whatever `.parse` throws propagate; narrow
    // structurally rather than depending on an `instanceof ZodError` check.
    return zodErrorToConfigIssues(error as ZodError, 'env');
  }
  throw error;
}

/**
 * `config-layers`' own generic constraints are looser than our schema (it
 * merely wants "deeply optional"); our layers are already Zod-validated, so
 * this is an interop cast at the library boundary, not an escape from
 * validation.
 */
function asDeepPartial(layer: ConfigLayer): DeepOptionalAndUndefined<ResolvedConfig> {
  return layer as unknown as DeepOptionalAndUndefined<ResolvedConfig>;
}

function extractSections(handle: ConfigHandle<ResolvedConfig>): unknown {
  const out: Record<string, unknown> = {};
  for (const name of SECTION_NAMES) {
    out[name] = handle[name];
  }
  return out;
}

function toConfigOrigin(path: string, raw: ConfigInspectionResult<ResolvedConfig, unknown>): ConfigOrigin {
  // `__inspect` reports layers highest-priority-first; `ConfigOrigin.candidates`
  // is documented (and tested against the fake) lowest-priority-first.
  const candidates = [...raw.layers].reverse().map((layer) => ({
    layer: String(layer.layer) as ConfigLayerName,
    value: layer.value,
    active: layer.isActive,
  }));
  return {
    path,
    value: raw.resolved.value,
    layer: String(raw.resolved.source) as ConfigLayerName,
    candidates,
  };
}

class ConfigLayersAdapter implements Config {
  readonly #handle: ConfigHandle<ResolvedConfig>;
  readonly #resolved: ResolvedConfig;
  readonly #settingsStore: SettingsStore;
  readonly #derivedCache = new Map<ChatId, ChatConfigView>();

  constructor(
    handle: ConfigHandle<ResolvedConfig>,
    resolved: ResolvedConfig,
    settingsStore: SettingsStore,
  ) {
    this.#handle = handle;
    this.#resolved = resolved;
    this.#settingsStore = settingsStore;
  }

  all(): ResolvedConfig {
    return this.#resolved;
  }

  get<K extends keyof ResolvedConfig>(section: K): ResolvedConfig[K] {
    return this.#resolved[section];
  }

  inspect(path: string): ConfigOrigin {
    return toConfigOrigin(path, this.#handle.__inspect(path));
  }

  async forChat(chatId: ChatId): Promise<ChatConfigView> {
    const cached = this.#derivedCache.get(chatId);
    if (cached !== undefined) return cached;

    const settings = await this.#settingsStore.getChatSettings(chatId);
    const chatLayer = chatLayerFromSettings(settings);
    const derivedHandle = this.#handle.__derive('chat', chatLayer as unknown as Partial<ResolvedConfig>);

    // The chat layer can only narrow `timezone.default` / `models.default`
    // (DESIGN §10: `chatLayerSchema`), so a shape re-check is enough here —
    // re-running the full registry/price cross-validation on every chat read
    // would be wasted work for a layer that cannot introduce a new model.
    const resolved = resolvedConfigSchema.parse(extractSections(derivedHandle));

    const view: ChatConfigView = {
      chatId,
      all: () => resolved,
      get: (section) => resolved[section],
      inspect: (path) => toConfigOrigin(path, derivedHandle.__inspect(path)),
    };
    this.#derivedCache.set(chatId, view);
    return view;
  }

  invalidateChat(chatId: ChatId): void {
    this.#derivedCache.delete(chatId);
  }
}
