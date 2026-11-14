import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const repoRoot = join(import.meta.dirname, '..', '..');

interface WorkflowStep {
  run?: string;
  'timeout-minutes'?: number;
  env?: Record<string, string>;
}
interface WorkflowJob {
  'runs-on'?: string | string[];
  'timeout-minutes'?: number;
  steps?: WorkflowStep[];
}

function loadCiJobs(): Record<string, WorkflowJob> {
  const text = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  return (parse(text) as { jobs: Record<string, WorkflowJob> }).jobs;
}

function windowsJobs(): Array<[string, WorkflowJob]> {
  return Object.entries(loadCiJobs()).filter(([, job]) => job['runs-on'] === 'windows-latest');
}

function findFullWindowsJob(): WorkflowJob {
  const [, job] = windowsJobs().find(([name]) => name === 'windows-build-test') ?? [];
  expect(job).toBeDefined();
  return job as WorkflowJob;
}

const UNIT_SHARD_COMMAND = (n: number): string =>
  `npx vitest run --config vitest.config.unit.parallel.ts --shard=${n}/2 --maxWorkers=1`;

function runCommands(job: WorkflowJob): string[] {
  return (job.steps ?? []).flatMap((step) => (step.run ? [step.run.trim()] : []));
}

describe('Windows support: build scripts are cross-platform', () => {
  it('build script chain uses only node/tsc, not POSIX shell utilities', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const build = pkg.scripts.build ?? '';
    expect(build).not.toMatch(/(^|&&|\|\||;|\|)\s*(cp|rm|mkdir|mv|cat|sh|bash|find)\s/);
    expect(build).toContain('copy-build-assets.mjs');
  });
});

describe('Windows support: line endings', () => {
  it('.gitattributes pins .sh runtime presets to LF so CRLF checkout cannot break them', () => {
    const path = join(repoRoot, '.gitattributes');
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/));
    const shRule = lines.find(([pattern]) => pattern === '*.sh');
    expect(shRule).toBeDefined();
    expect(shRule).toContain('eol=lf');
  });
});

describe('Windows support: CI', () => {
  it('runs the unit suite on Windows as two direct vitest shards, bypassing the npm test wrapper', () => {
    const commands = runCommands(findFullWindowsJob());
    expect(commands).not.toContain('npm test');
    const first = commands.indexOf(UNIT_SHARD_COMMAND(1));
    const second = commands.indexOf(UNIT_SHARD_COMMAND(2));
    expect(first).toBeGreaterThan(commands.indexOf('npm run build'));
    expect(second).toBeGreaterThan(first);
  });

  it('bounds each Windows unit shard step with timeout-minutes: 20', () => {
    const steps = findFullWindowsJob().steps ?? [];
    for (const n of [1, 2]) {
      const step = steps.find((s) => s.run?.trim() === UNIT_SHARD_COMMAND(n));
      expect(step?.['timeout-minutes']).toBe(20);
    }
  });

  it('installs with npm ci before building in the full Windows job', () => {
    const commands = runCommands(findFullWindowsJob());
    expect(commands.indexOf('npm ci')).toBeGreaterThanOrEqual(0);
    expect(commands.indexOf('npm ci')).toBeLessThan(commands.indexOf('npm run build'));
    expect(commands.indexOf('npm run build')).toBeLessThan(commands.indexOf(UNIT_SHARD_COMMAND(1)));
  });

  it('verifies bin/takt --version and --help after build on Windows', () => {
    const commands = runCommands(findFullWindowsJob());
    const build = commands.indexOf('npm run build');
    const version = commands.findIndex((c) => /bin[\\/]takt\s+--version/.test(c));
    const help = commands.findIndex((c) => /bin[\\/]takt\s+--help/.test(c));
    expect(version).toBeGreaterThan(build);
    expect(help).toBeGreaterThan(build);
  });

  it('runs a mock-provider workflow to completion on Windows', () => {
    const steps = findFullWindowsJob().steps ?? [];
    const mockStep = steps.find(
      (step) =>
        /test:e2e:mock|vitest.config.e2e.mock|e2e\/specs\//.test(step.run ?? '') &&
        (/TAKT_E2E_PROVIDER=mock/.test(step.run ?? '') || step.env?.TAKT_E2E_PROVIDER === 'mock'
          || /test:e2e:mock/.test(step.run ?? '')),
    );
    expect(mockStep).toBeDefined();
  });

  it('bounds the Windows job runtime with timeout-minutes', () => {
    expect(findFullWindowsJob()['timeout-minutes']).toBeGreaterThan(0);
  });

  it('keeps the existing windows-private-artifacts focused job', () => {
    const jobs = loadCiJobs();
    const job = jobs['windows-private-artifacts'];
    expect(job?.['runs-on']).toBe('windows-latest');
    expect(runCommands(job as WorkflowJob).some((c) => c.includes('windows-executable-shadowing.test.ts'))).toBe(true);
  });
});

describe('Windows support: user-facing documentation', () => {
  function documentedWindowsSections(): string[] {
    const files = [
      join(repoRoot, 'README.md'),
      ...readdirSync(join(repoRoot, 'docs'))
        .filter((name) => name.endsWith('.md') && !/\.(ja|zh-CN)\.md$/.test(name))
        .map((name) => join(repoRoot, 'docs', name)),
    ];
    const sections: string[] = [];
    for (const file of files) {
      const parts = readFileSync(file, 'utf8').split(/^(?=#{1,4} )/m);
      for (const part of parts) {
        if (/^#{1,4} .*Windows/i.test(part)) sections.push(part);
      }
    }
    return sections;
  }

  it('README.md or docs/ has a Windows section covering prerequisites and limitations', () => {
    const sections = documentedWindowsSections();
    expect(sections.length).toBeGreaterThanOrEqual(1);
    const body = sections.join('\n');
    expect(body).toMatch(/Node/);
    expect(body).toMatch(/limitation|unverified|not (yet )?verified|not supported|制限/i);
  });
});
