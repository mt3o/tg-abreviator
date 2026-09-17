/**
 * The README makes three operational promises that only stay true if the code
 * agrees with them. Nothing here tests behaviour; it tests that the
 * documentation has not drifted away from the composition root — which is the
 * failure mode a passing test suite is famously blind to.
 *
 * 1. The documented no-Docker path runs the file the build actually emits.
 * 2. The environment-variable table lists exactly what the process reads.
 * 3. `config.example.yaml` validates (that one lives in `boot.test.ts`, where
 *    it goes through the real `createConfig`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { envLayerSchema } from '../../src/config/schema.js';

const README = readFileSync('README.md', 'utf8');
const DOCKERFILE = readFileSync('Dockerfile', 'utf8');
const BUILD_TSCONFIG = JSON.parse(readFileSync('tsconfig.build.json', 'utf8')) as {
  compilerOptions: { outDir: string; rootDir: string };
};

const ENTRY_SOURCE = 'src/bootstrap/main.ts';
const ENTRY_BUILT = 'dist/bootstrap/main.js';

describe('the documented no-Docker path', () => {
  it('runs the entry point the build emits, from the source file that exists', () => {
    expect(existsSync(ENTRY_SOURCE)).toBe(true);
    // `rootDir: src` + `outDir: dist` is what turns the first path into the second.
    expect(BUILD_TSCONFIG.compilerOptions.rootDir).toBe('src');
    expect(BUILD_TSCONFIG.compilerOptions.outDir).toBe('dist');
    expect(README).toContain(`node ${ENTRY_BUILT}`);
  });

  it('is the same entry point the image starts', () => {
    expect(DOCKERFILE).toContain(`CMD ["node", "${ENTRY_BUILT}"]`);
  });

  it('documents the build step that produces it', () => {
    const scripts = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts;
    expect(scripts.build).toBe('tsc -p tsconfig.build.json');
    expect(README).toContain('npm run build');
  });
});

describe('the environment variable table', () => {
  /** Every `| \`NAME\` |` row of the table under "Environment variables". */
  const documented = new Set(
    [...README.matchAll(/^\| `([A-Z][A-Z0-9_]*)` \|/gm)].map((match) => match[1] ?? ''),
  );

  /**
   * What the process actually reads: the env layer (DESIGN §10 layer 3), the
   * provider key names the model registry references by `apiKeyEnv`, and
   * `CONFIG_PATH`, which the composition root reads before any layer exists.
   */
  const read = new Set<string>([
    ...Object.keys(envLayerSchema.shape),
    ...Object.values(DEFAULT_CONFIG.models.registry).map((entry) => entry.apiKeyEnv),
    'CONFIG_PATH',
  ]);

  it('documents every variable the process reads', () => {
    expect([...read].filter((name) => !documented.has(name)).sort()).toEqual([]);
  });

  it('documents nothing the process does not read', () => {
    expect([...documented].filter((name) => !read.has(name)).sort()).toEqual([]);
  });
});
