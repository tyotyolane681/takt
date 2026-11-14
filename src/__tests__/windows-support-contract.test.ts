import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

const repoRoot = join(import.meta.dirname, '..', '..');

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
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
  it('has a windows-latest job that builds and runs the full npm test gate', () => {
    const matching = windowsJobs().filter(([, job]) => {
      const commands = runCommands(job);
      return commands.includes('npm run build') && commands.includes('npm test');
    });
    expect(matching.length).toBeGreaterThanOrEqual(1);
  });

  it('installs with npm ci before building in the full Windows job', () => {
    const [, job] = windowsJobs().find(([, j]) => runCommands(j).includes('npm test')) ?? [];
    expect(job).toBeDefined();
    const commands = runCommands(job as WorkflowJob);
    expect(commands.indexOf('npm ci')).toBeGreaterThanOrEqual(0);
    expect(commands.indexOf('npm ci')).toBeLessThan(commands.indexOf('npm run build'));
    expect(commands.indexOf('npm run build')).toBeLessThan(commands.indexOf('npm test'));
  });

  it('verifies bin/takt --version and --help after build on Windows', () => {
    const [, job] = windowsJobs().find(([, j]) => runCommands(j).includes('npm test')) ?? [];
    const commands = runCommands(job as WorkflowJob);
    const build = commands.indexOf('npm run build');
    const version = commands.findIndex((c) => /bin[\\/]takt\s+--version/.test(c));
    const help = commands.findIndex((c) => /bin[\\/]takt\s+--help/.test(c));
    expect(version).toBeGreaterThan(build);
    expect(help).toBeGreaterThan(build);
  });

  it('runs a mock-provider workflow to completion on Windows', () => {
    const [, job] = windowsJobs().find(([, j]) => runCommands(j).includes('npm test')) ?? [];
    const steps = (job as WorkflowJob).steps ?? [];
    const mockStep = steps.find(
      (step) =>
        /test:e2e:mock|vitest.config.e2e.mock|e2e\/specs\//.test(step.run ?? '') &&
        (/TAKT_E2E_PROVIDER=mock/.test(step.run ?? '') || step.env?.TAKT_E2E_PROVIDER === 'mock'
          || /test:e2e:mock/.test(step.run ?? '')),
    );
    expect(mockStep).toBeDefined();
  });

  it('bounds the Windows job runtime with timeout-minutes', () => {
    const [, job] = windowsJobs().find(([, j]) => runCommands(j).includes('npm test')) ?? [];
    expect((job as WorkflowJob)['timeout-minutes']).toBeGreaterThan(0);
  });

  it('keeps the existing windows-private-artifacts focused job', () => {
    const jobs = loadCiJobs();
    const job = jobs['windows-private-artifacts'];
    expect(job?.['runs-on']).toBe('windows-latest');
    expect(runCommands(job as WorkflowJob).some((c) => c.includes('windows-executable-shadowing.test.ts'))).toBe(true);
  });
});

describe('Windows support: temporary unit shard diagnostics', () => {
  function windowsFullJob(): WorkflowJob {
    const [, job] = windowsJobs().find(([, j]) => runCommands(j).includes('npm test')) ?? [];
    return job as WorkflowJob;
  }

  function shardSteps(job: WorkflowJob): WorkflowStep[] {
    return (job.steps ?? []).filter((step) => /vitest\s+run\b/.test(step.run ?? '') && /--shard=/.test(step.run ?? ''));
  }

  it('runs unit shards 1/2 then 2/2 sequentially as separate steps with the parallel unit config and one worker', () => {
    const job = windowsFullJob();
    const steps = job.steps ?? [];
    const shards = shardSteps(job);
    expect(shards).toHaveLength(2);
    const [first, second] = shards as [WorkflowStep, WorkflowStep];
    expect(first.run).toContain('--shard=1/2');
    expect(second.run).toContain('--shard=2/2');
    for (const step of shards) {
      expect(step.run).toContain('vitest.config.unit.parallel.ts');
      expect(step.run).toContain('--maxWorkers=1');
    }
    expect(steps.indexOf(first)).toBeLessThan(steps.indexOf(second));
  });

  it('writes each shard result as JSON to its own path while keeping the default reporter', () => {
    const outputs = shardSteps(windowsFullJob()).map((step) => {
      expect(step.run).toContain('--reporter=default');
      expect(step.run).toContain('--reporter=json');
      const match = /--outputFile\.json=(\S+)/.exec(step.run ?? '');
      expect(match).not.toBeNull();
      return match?.[1];
    });
    expect(outputs).toHaveLength(2);
    expect(new Set(outputs).size).toBe(2);
  });

  it('bounds every shard step with its own timeout-minutes below the job timeout', () => {
    const job = windowsFullJob();
    expect(shardSteps(job)).toHaveLength(2);
    for (const step of shardSteps(job)) {
      expect(step['timeout-minutes']).toBeGreaterThan(0);
      expect(step['timeout-minutes']).toBeLessThan(job['timeout-minutes'] as number);
    }
  });

  it('does not extend test timeouts in the diagnostic shard steps', () => {
    expect(shardSteps(windowsFullJob())).toHaveLength(2);
    for (const step of shardSteps(windowsFullJob())) {
      expect(step.run).not.toMatch(/--testTimeout/);
    }
  });

  it('summarizes with a node script in an if: always() step placed after both shards', () => {
    const job = windowsFullJob();
    const steps = job.steps ?? [];
    const shards = shardSteps(job);
    const lastShard = Math.max(...shards.map((step) => steps.indexOf(step)));
    const summary = steps.find((step) => /node\s+scripts[\\/][\w.-]+\.mjs/.test(step.run ?? ''));
    expect(summary).toBeDefined();
    expect(summary?.if).toMatch(/always\(\)/);
    expect(steps.indexOf(summary as WorkflowStep)).toBeGreaterThan(lastShard);
  });

  it('keeps the npm test gate and the mock-provider workflow step in the Windows job', () => {
    const commands = runCommands(windowsFullJob());
    expect(commands).toContain('npm test');
    expect(commands.some((c) => c.includes('vitest.config.e2e.mock.ts'))).toBe(true);
  });

  it('does not add shard diagnostics to non-Windows jobs', () => {
    const jobs = Object.entries(loadCiJobs()).filter(([, job]) => job['runs-on'] !== 'windows-latest');
    for (const [, job] of jobs) {
      for (const command of runCommands(job)) {
        expect(command).not.toMatch(/--outputFile\.json/);
      }
    }
  });
});

describe('Windows support: shard summary script', () => {
  const script = join(repoRoot, 'scripts', 'summarize-vitest-shards.mjs');

  function summarize(shards: string[], env: Record<string, string>): string {
    return execFileSync(process.execPath, [script, ...shards], {
      encoding: 'utf8',
      env: { ...process.env, VITEST_SHARD_1_EXIT: undefined, VITEST_SHARD_2_EXIT: undefined, ...env },
    });
  }

  function withTempDir(run: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'takt-shard-summary-'));
    try {
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('reports exit code and counts for a passing shard without listing failures', () => {
    withTempDir((dir) => {
      const json = join(dir, 'ok.json');
      writeFileSync(json, JSON.stringify({
        numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0,
        testResults: [{ name: '/a.test.ts', status: 'passed', message: '', assertionResults: [{ fullName: 'a works', status: 'passed' }] }],
      }));
      const out = summarize([`1=${json}`], { VITEST_SHARD_1_EXIT: '0' });
      expect(out).toContain('shard 1: exit code 0');
      expect(out).toContain('failed: 0');
      expect(out).not.toContain('FAILED');
    });
  });

  it('lists failed files and tests for a failing shard', () => {
    withTempDir((dir) => {
      const json = join(dir, 'ng.json');
      writeFileSync(json, JSON.stringify({
        numTotalTests: 2, numPassedTests: 1, numFailedTests: 1, numPendingTests: 0,
        testResults: [{
          name: '/b.test.ts', status: 'failed', message: 'boom',
          assertionResults: [{ fullName: 'b works', status: 'passed' }, { fullName: 'b breaks', status: 'failed' }],
        }],
      }));
      const out = summarize([`2=${json}`], { VITEST_SHARD_2_EXIT: '1' });
      expect(out).toContain('shard 2: exit code 1');
      expect(out).toContain('FAILED FILE: /b.test.ts');
      expect(out).toContain('FAILED TEST: b breaks');
      expect(out).not.toContain('FAILED TEST: b works');
    });
  });

  it('states that vitest ended without writing results when the JSON is missing', () => {
    withTempDir((dir) => {
      const out = summarize([`1=${join(dir, 'missing.json')}`], {});
      expect(out).toContain('JSON なし = vitest が結果を書けずに終了');
      expect(out).toContain('unknown');
    });
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
