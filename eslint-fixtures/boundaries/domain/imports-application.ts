/**
 * DELIBERATELY BROKEN. This file exists to prove the boundary rule fires.
 *
 * Classified as `domain` by eslint.config.js, and the domain may import only
 * the domain (DESIGN §3). Importing an application port must be an error.
 *
 * Expected: boundaries/dependencies
 */
import type { Clock } from '../../../src/application/ports/driven/clock.js';

export type LeakedClock = Clock;
