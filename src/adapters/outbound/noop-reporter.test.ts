/**
 * DESIGN §11: "a no-op adapter is used when GLITCHTIP_DSN is unset, so a
 * contributor without a DSN still gets a working bot and tests never emit."
 * This asserts the "tests never emit" half directly: nothing this adapter does
 * touches the network, the console, or any shared state.
 */
import { describe, expect, it, vi } from 'vitest';
import { UnexpectedError } from '../../domain/errors.js';
import type { ErrorContext } from '../../application/ports/driven/error-reporter.js';
import { NoopErrorReporter, createNoopErrorReporter } from './noop-reporter.js';

describe('NoopErrorReporter', () => {
  it('never touches the console when capturing an error', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const reporter = new NoopErrorReporter();
    const context: ErrorContext = { phase: 'llm' };
    reporter.capture(new UnexpectedError(), context);
    reporter.capture('a bare string throw', context);
    reporter.capture(undefined, context);

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('flush and close resolve true without doing anything observable', async () => {
    const reporter = new NoopErrorReporter();
    await expect(reporter.flush()).resolves.toBe(true);
    await expect(reporter.flush(5000)).resolves.toBe(true);
    await expect(reporter.close()).resolves.toBe(true);
    await expect(reporter.close(1000)).resolves.toBe(true);
  });

  it('createNoopErrorReporter returns a working instance', () => {
    const reporter = createNoopErrorReporter();
    expect(() => {
      reporter.capture(new Error('boom'), { phase: 'boot' });
    }).not.toThrow();
  });
});
