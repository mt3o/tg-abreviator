import { describe, expect, it } from 'vitest';
import { NoopErrorReporter } from '../noop-reporter.js';
import { createErrorReporter } from './create-error-reporter.js';

describe('createErrorReporter', () => {
  it('selects the no-op adapter when the DSN is null (DESIGN §11)', () => {
    const reporter = createErrorReporter({
      dsn: null,
      environment: 'dev',
      release: null,
      promptVersion: 'v1',
    });

    expect(reporter).toBeInstanceOf(NoopErrorReporter);
  });

  it('selects the GlitchTip adapter when a DSN is configured', () => {
    const reporter = createErrorReporter({
      dsn: 'https://public@localhost/1',
      environment: 'dev',
      release: null,
      promptVersion: 'v1',
      transport: () => ({
        send: async () => await Promise.resolve({ statusCode: 200 }),
        flush: async () => await Promise.resolve(true),
      }),
    });

    expect(reporter).not.toBeInstanceOf(NoopErrorReporter);
  });
});
