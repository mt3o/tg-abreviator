/**
 * A wiring smoke test for `createGlitchTipReporter`, not a network test: the
 * DSN's transport is swapped for an in-memory one, so `init` → `capture` →
 * `beforeSend` → "send" all run for real, but nothing ever leaves the process
 * (DESIGN §11: "tests never emit"). The detailed no-leak assertions live in
 * `scrub-event.test.ts`, which exercises the pure `beforeSend` hook directly
 * against every error path; this file only proves the adapter actually wires
 * that hook in, honours the report/don't-report split end to end, and that
 * `flush`/`close` behave.
 */
import { describe, expect, it } from 'vitest';
import { DmForbiddenError, UnexpectedError } from '../../../domain/errors.js';
import { createGlitchTipReporter } from './glitchtip-reporter.js';
import type { GlitchTipOptions } from './glitchtip-reporter.js';

interface CapturedRequest {
  readonly body: string | Uint8Array;
}

function makeCapturingTransport(): {
  readonly requests: CapturedRequest[];
  readonly transport: NonNullable<GlitchTipOptions['transport']>;
} {
  const requests: CapturedRequest[] = [];
  const transport: NonNullable<GlitchTipOptions['transport']> = () => ({
    send: async (envelope) => {
      // The envelope is whatever the SDK's own serializer produced; we only
      // need proof that *something* reached the transport, and how much.
      requests.push({ body: JSON.stringify(envelope) });
      return await Promise.resolve({ statusCode: 200 });
    },
    flush: async () => await Promise.resolve(true),
  });
  return { requests, transport };
}

function options(overrides: Partial<GlitchTipOptions> = {}): GlitchTipOptions {
  return {
    dsn: 'https://public@localhost/1',
    environment: 'test',
    release: 'abc1234',
    promptVersion: 'v1',
    ...overrides,
  };
}

describe('createGlitchTipReporter', () => {
  it('sends a reportable error through to the transport', async () => {
    const { requests, transport } = makeCapturingTransport();
    const reporter = createGlitchTipReporter(options({ transport }));

    reporter.capture(new UnexpectedError(), { phase: 'llm', model: 'claude-strong' });
    await reporter.flush(2000);

    expect(requests.length).toBeGreaterThan(0);
  });

  it('never sends an error DESIGN §11 says is a metric, not an incident', async () => {
    const { requests, transport } = makeCapturingTransport();
    const reporter = createGlitchTipReporter(options({ transport }));

    reporter.capture(new DmForbiddenError(), { phase: 'deliver', adapter: 'telegram_out' });
    await reporter.flush(2000);

    expect(requests).toHaveLength(0);
  });

  it('flush and close resolve booleans and never throw', async () => {
    const { transport } = makeCapturingTransport();
    const reporter = createGlitchTipReporter(options({ transport }));

    await expect(reporter.flush(500)).resolves.toBe(true);
    await expect(reporter.close(500)).resolves.toBe(true);
  });
});
