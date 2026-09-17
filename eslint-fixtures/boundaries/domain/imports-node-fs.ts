/**
 * DELIBERATELY BROKEN. The domain performs no I/O (DESIGN §3).
 *
 * Expected: no-restricted-imports
 */
import { readFileSync } from 'node:fs';

export const read = (path: string): string => readFileSync(path, 'utf8');
