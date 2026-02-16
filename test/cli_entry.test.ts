import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'vitest';
import { runCLI } from '../src/cli.ts';

const makeIO = () => {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    io: {
      log: (line: string) => logs.push(line),
      error: (line: string) => errors.push(line),
    },
  };
};

describe('rlm cli entry', () => {
  test('help を表示できる', async () => {
    const ctx = makeIO();
    const code = await runCLI(['--help'], ctx.io);
    expect(code).toBe(0);
    expect(ctx.logs.some((line) => line.includes('Usage: rlm'))).toBe(true);
  });

  test('eval(mock) を実行できる', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rlm-cli-'));
    const casesPath = join(dir, 'cases.jsonl');
    await writeFile(
      casesPath,
      '{"id":"c1","prompt":"alpha","query":"alpha を返せ","expected":"alpha"}\n',
      'utf8',
    );

    const ctx = makeIO();
    const code = await runCLI(
      ['eval', '--provider', 'mock', '--cases', casesPath, '--profile', 'pure'],
      ctx.io,
    );
    expect(code).toBe(0);
    expect(ctx.logs.some((line) => line.includes('=== Eval Summary ==='))).toBe(
      true,
    );
  });

  test('未知コマンドで失敗する', async () => {
    const ctx = makeIO();
    const code = await runCLI(['unknown-subcommand'], ctx.io);
    expect(code).toBe(1);
    expect(
      ctx.errors.some((line) => line.includes('unknown command: unknown-subcommand')),
    ).toBe(true);
  });
});
