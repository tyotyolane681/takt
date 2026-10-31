import { describe, expect, it } from 'vitest';
import { buildPhaseJudgeStageRecord } from '../features/tasks/execute/sessionLoggerRecordFactory.js';
import type { WorkflowStep } from '../core/models/index.js';
import type { JudgeStageEntry } from '../core/workflow/types.js';

const step = { name: 'implement', personaDisplayName: 'coder' } as WorkflowStep;

function build(entry: JudgeStageEntry) {
  return buildPhaseJudgeStageRecord(step, 3, 'judge', entry, undefined, 'implement:3:1', 1, (text) => text);
}

describe('buildPhaseJudgeStageRecord usage', () => {
  it('records provider token usage when the stage ran a provider call', () => {
    const record = build({
      stage: 1,
      method: 'structured_output',
      status: 'done',
      instruction: 'Judge it',
      response: '{"step":1}',
      providerUsage: {
        usageMissing: false,
        inputTokens: 16,
        outputTokens: 150,
        totalTokens: 166,
        cacheCreationInputTokens: 15000,
        cacheReadInputTokens: 7000,
      },
    });

    expect(record.usage).toEqual({
      usageMissing: false,
      inputTokens: 16,
      outputTokens: 150,
      totalTokens: 166,
      cacheCreationInputTokens: 15000,
      cacheReadInputTokens: 7000,
    });
  });

  it('keeps the missing-usage reason from the provider', () => {
    const record = build({
      stage: 2,
      method: 'phase3_tag',
      status: 'done',
      instruction: 'Judge it',
      response: '[STEP:1]',
      providerUsage: { usageMissing: true, reason: 'provider_did_not_return_usage' },
    });

    expect(record.usage).toEqual({ usageMissing: true, reason: 'provider_did_not_return_usage' });
  });

  it('omits usage when no provider ran (Jev decided)', () => {
    const record = build({
      stage: 1,
      method: 'jev',
      status: 'done',
      instruction: 'Judge it',
      response: '{"decision":"jev"}',
    });

    expect(record).not.toHaveProperty('usage');
  });
});
