import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

interface PackageLike {
  main?: string;
  types?: string;
  exports?: Record<string, unknown>;
  bin?: string;
  files?: string[];
  scripts?: Record<string, string>;
}

const loadPackageJSON = (): PackageLike => {
  const src = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8');
  return JSON.parse(src) as PackageLike;
};

describe('npm publish manifest', () => {
  test('library entry は dist/index.mjs を向く', () => {
    const pkg = loadPackageJSON();
    expect(pkg.main).toBe('./dist/index.mjs');
    expect(pkg.types).toBe('./dist/index.d.mts');
    const dot = (pkg.exports?.['.'] ?? {}) as Record<string, string>;
    expect(dot.import).toBe('./dist/index.mjs');
    expect(dot.types).toBe('./dist/index.d.mts');
  });

  test('cli entry は rlm ラッパーを向く', () => {
    const pkg = loadPackageJSON();
    expect(pkg.bin).toBe('rlm');
  });

  test('prebuild を prepack で実行する', () => {
    const pkg = loadPackageJSON();
    expect(pkg.scripts?.build).toContain('tsdown');
    expect(pkg.scripts?.prepack).toBe('pnpm run build');
    expect(pkg.files).toContain('dist');
    expect(pkg.files?.includes('src')).toBe(false);
  });
});
