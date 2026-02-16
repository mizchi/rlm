#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateCases } from './eval/evaluate.ts';
import { parseEvalJSONL } from './eval/jsonl.ts';
import {
  buildProfileRLMOptions,
  parseRLMProfile,
  type RLMProfile,
} from './eval/profile.ts';
import type { EvalCase, EvalReport } from './eval/types.ts';
import { MockLLMProvider } from './llm/MockLLMProvider.ts';
import { OpenAIProvider } from './llm/OpenAIProvider.ts';
import { parseCLIKeyValues } from './util/cli.ts';

type ProviderName = 'mock' | 'openai';
type EvalMode = 'baseline' | 'rlm';

interface CLIIO {
  log(line: string): void;
  error(line: string): void;
}

interface EvalArgs {
  provider: ProviderName;
  casesPath: string;
  model: string;
  profile: RLMProfile;
  outPath?: string;
}

interface AblationArgs {
  provider: ProviderName;
  casesPath: string;
  model: string;
  profiles: RLMProfile[];
  runs: number;
}

const defaultIO: CLIIO = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

export const runCLI = async (
  argv: string[],
  io: CLIIO = defaultIO,
): Promise<number> => {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    printHelp(io);
    return 0;
  }

  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    io.log('@mizchi/rlm');
    return 0;
  }

  try {
    if (cmd === 'eval') {
      return await runEval(rest, io);
    }
    if (cmd === 'ablation') {
      return await runAblation(rest, io);
    }

    io.error(`unknown command: ${cmd}`);
    printHelp(io);
    return 1;
  } catch (cause) {
    io.error(formatError(cause));
    return 1;
  }
};

export const main = async (): Promise<void> => {
  const code = await runCLI(process.argv.slice(2), defaultIO);
  if (code !== 0) {
    process.exitCode = code;
  }
};

const runEval = async (argv: string[], io: CLIIO): Promise<number> => {
  const args = parseEvalArgs(argv);
  const cases = await loadCases(args.casesPath);

  const report = await evaluateCases(cases, {
    providerFactory: (mode, evalCase) => makeProvider(args, mode, evalCase),
    baselineLLMOptions: { temperature: 0 },
    rlmOptions: buildProfileRLMOptions(args.profile),
  });

  printEvalSummary(report, io);
  if (args.outPath !== undefined) {
    const outPath = resolve(args.outPath);
    await writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
    io.log(`saved: ${outPath}`);
  }
  return 0;
};

const runAblation = async (argv: string[], io: CLIIO): Promise<number> => {
  const args = parseAblationArgs(argv);
  const cases = await loadCases(args.casesPath);
  const reportsByProfile = new Map<RLMProfile, EvalReport[]>();
  for (const profile of args.profiles) {
    reportsByProfile.set(profile, []);
  }

  for (let run = 1; run <= args.runs; run += 1) {
    for (const profile of args.profiles) {
      const report = await evaluateCases(cases, {
        providerFactory: (mode, evalCase) =>
          makeProvider(
            {
              provider: args.provider,
              model: args.model,
              casesPath: args.casesPath,
              profile,
            },
            mode,
            evalCase,
          ),
        baselineLLMOptions: { temperature: 0 },
        rlmOptions: buildProfileRLMOptions(profile),
      });
      reportsByProfile.get(profile)?.push(report);
      io.log(
        `[run=${run}] profile=${profile} baseline=${pct(report.summary.baseline.accuracy)} rlm=${pct(report.summary.rlm.accuracy)} calls=${report.summary.rlm.usage.calls} avgMs=${report.summary.rlm.avgLatencyMs.toFixed(1)}`,
      );
    }
  }

  io.log('=== Ablation Summary ===');
  for (const [profile, reports] of reportsByProfile) {
    const rlmAcc = mean(reports.map((r) => r.summary.rlm.accuracy));
    const rlmCalls = mean(reports.map((r) => r.summary.rlm.usage.calls));
    const rlmMs = mean(reports.map((r) => r.summary.rlm.avgLatencyMs));
    const baseAcc = mean(reports.map((r) => r.summary.baseline.accuracy));
    const delta = rlmAcc - baseAcc;
    io.log(
      `${profile}: runs=${args.runs} acc=${pct(rlmAcc)} delta=${(delta * 100).toFixed(1)}pt calls=${rlmCalls.toFixed(1)} avgMs=${rlmMs.toFixed(1)}`,
    );
  }

  return 0;
};

const parseEvalArgs = (argv: string[]): EvalArgs => {
  const kv = parseCLIKeyValues(argv);
  const provider = parseProvider(kv.get('provider'));
  const outPath = kv.get('out');
  return {
    provider,
    casesPath: kv.get('cases') ?? 'eval/cases.sample.jsonl',
    model: kv.get('model') ?? 'gpt-4.1-mini',
    profile: parseRLMProfile(kv.get('profile')),
    ...(outPath !== undefined ? { outPath } : {}),
  };
};

const parseAblationArgs = (argv: string[]): AblationArgs => {
  const kv = parseCLIKeyValues(argv);
  const provider = parseProvider(kv.get('provider'));
  const runs = Number(kv.get('runs') ?? '1');
  if (!Number.isInteger(runs) || runs <= 0) {
    throw new Error(`--runs must be positive integer, got: ${runs}`);
  }
  const profilesRaw = kv.get('profiles') ?? 'pure,hybrid';
  const profiles = profilesRaw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '')
    .map((v) => parseRLMProfile(v));
  if (profiles.length === 0) {
    throw new Error('--profiles must include at least one profile');
  }
  return {
    provider,
    casesPath: kv.get('cases') ?? 'eval/cases.sample.jsonl',
    model: kv.get('model') ?? 'gpt-4.1-mini',
    profiles,
    runs,
  };
};

const parseProvider = (raw: string | undefined): ProviderName => {
  const provider = raw ?? 'mock';
  if (provider !== 'mock' && provider !== 'openai') {
    throw new Error(`--provider must be mock|openai, got: ${provider}`);
  }
  return provider;
};

const loadCases = async (casesPath: string): Promise<EvalCase[]> => {
  const text = await readFile(resolve(casesPath), 'utf8');
  const cases = parseEvalJSONL(text);
  if (cases.length === 0) {
    throw new Error(`no cases found: ${casesPath}`);
  }
  return cases;
};

const makeProvider = (
  args: EvalArgs,
  mode: EvalMode,
  evalCase: EvalCase,
) => {
  if (args.provider === 'mock') {
    if (mode === 'baseline') {
      return new MockLLMProvider({
        scriptsByDepth: { 0: [evalCase.expected] },
      });
    }
    return new MockLLMProvider({
      scriptsByDepth: {
        0:
          args.profile === 'hybrid'
            ? [
                JSON.stringify({
                  op: 'slice_prompt',
                  start: 0,
                  end: 1,
                  out: 'probe',
                }),
                JSON.stringify({
                  op: 'set',
                  path: 'scratch.answer',
                  value: evalCase.expected,
                }),
                JSON.stringify({ op: 'finalize', from: 'answer' }),
              ]
            : [
                JSON.stringify({
                  op: 'set',
                  path: 'scratch.answer',
                  value: evalCase.expected,
                }),
                JSON.stringify({ op: 'finalize', from: 'answer' }),
              ],
      },
    });
  }
  return new OpenAIProvider({ model: args.model });
};

const printEvalSummary = (report: EvalReport, io: CLIIO): void => {
  const s = report.summary;
  io.log('=== Eval Summary ===');
  io.log(`cases: ${s.totalCases}`);
  io.log(
    `baseline: ${s.baseline.correct}/${s.totalCases} (${pct(s.baseline.accuracy)}), calls=${s.baseline.usage.calls}, avgLatencyMs=${s.baseline.avgLatencyMs.toFixed(1)}`,
  );
  io.log(
    `rlm:      ${s.rlm.correct}/${s.totalCases} (${pct(s.rlm.accuracy)}), calls=${s.rlm.usage.calls}, avgLatencyMs=${s.rlm.avgLatencyMs.toFixed(1)}`,
  );
  io.log(`delta(rlm-baseline): ${(s.accuracyDelta * 100).toFixed(1)}pt`);
  for (const row of report.results) {
    io.log(
      `- ${row.caseId}: base=${row.baseline.correct ? 'ok' : 'ng'} rlm=${row.rlm.correct ? 'ok' : 'ng'}`,
    );
  }
};

const printHelp = (io: CLIIO): void => {
  io.log('Usage: rlm <command> [options]');
  io.log('');
  io.log('Commands:');
  io.log('  eval       run baseline vs rlm evaluation');
  io.log('  ablation   compare pure/hybrid profiles');
  io.log('  help       show this help');
  io.log('');
  io.log('Examples:');
  io.log('  rlm eval --provider mock --cases eval/cases.sample.jsonl --profile hybrid');
  io.log('  rlm ablation --provider mock --profiles pure,hybrid --runs 3');
};

const formatError = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const mean = (values: number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, v) => sum + v, 0) / values.length;
};

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main();
}
