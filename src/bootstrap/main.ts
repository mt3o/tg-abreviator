/**
 * Process entry point — `node dist/bootstrap/main.js` (README, Dockerfile).
 *
 * Deliberately three statements. Everything that can be tested lives in
 * `run.ts`; what is left here is the part that cannot be: loading `.env` off
 * the developer's disk, reading the real environment, and setting an exit
 * code.
 *
 * `.env` is loaded here rather than inside `run()` so the environment a test
 * passes in is the environment that is used, with nothing read off disk.
 * `override` stays false (the dotenv default): a real environment variable
 * beats the file, which is what makes `docker compose`'s `environment:` block
 * authoritative over a stray `.env` (README, "Running with Docker").
 */
import { config as loadDotEnv } from 'dotenv';

import { run } from './run.js';

loadDotEnv({ quiet: true });

process.exitCode = await run({ env: process.env, cwd: process.cwd() });
