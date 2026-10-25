import { describe, expect, it, vi } from 'vitest';
import type { StructuredCaller } from '../agents/structured-caller.js';
import {
  JevStructuredCaller,
  contradictsVerdict,
  createStructuredCaller,
  type JevStructuredCallerOptions,
} from '../agents/structured-caller/jev-structured-caller.js';
import { ProviderNeutralStructuredCaller } from '../agents/structured-caller/provider-neutral-structured-caller.js';
import type { JudgeStageLogEntry, JudgeStatusOptions } from '../agents/judge-status-usecase.js';
import type { JevJudge, JevJudgment } from '../infra/jev/jev-client.js';
import { maskJudgeInstruction } from '../infra/jev/jev-mask.js';

const CANDIDATES = [{ label: 'AI特有の問題なし' }, { label: 'AI特有の問題あり' }];

function createInner(): StructuredCaller & { judgeStatus: ReturnType<typeof vi.fn> } {
  return {
    judgeStatus: vi.fn().mockResolvedValue({ candidateIndex: 1, method: 'structured_output' }),
    evaluateCondition: vi.fn().mockResolvedValue(0),
    decomposeTask: vi.fn(),
    requestMoreParts: vi.fn(),
  };
}

function judgment(overrides: Partial<JevJudgment> = {}): JevJudgment {
  return {
    candidateIndex: 0,
    confidence: 0.95,
    probabilities: { rule_1: 0.95, rule_2: 0.05, unsure: 0 },
    model: 'jev-1.13.0',
    latencyMs: 120,
    maskHits: {},
    ...overrides,
  };
}

function judgeReturning(result: JevJudgment | Error): JevJudge {
  return {
    judge: vi.fn(() => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result))),
  };
}

function setup(mode: JevStructuredCallerOptions['mode'], result: JevJudgment | Error) {
  const inner = createInner();
  const caller = new JevStructuredCaller(inner, { mode, threshold: 0.8, judge: judgeReturning(result) });
  const stages: JudgeStageLogEntry[] = [];
  const onStructuredPromptResolved = vi.fn();
  const options: JudgeStatusOptions = {
    judgmentInput: 'report',
    cwd: '/tmp/project',
    stepName: 'ai_review',
    onJudgeStage: (entry) => stages.push(entry),
    onStructuredPromptResolved,
  };
  return { inner, caller, stages, options, onStructuredPromptResolved };
}

const parseResponse = (entry: JudgeStageLogEntry | undefined): Record<string, unknown> =>
  JSON.parse(entry?.response ?? '{}') as Record<string, unknown>;

describe('JevStructuredCaller (enforce)', () => {
  it('信頼度がしきい値以上なら Jev の判定を採用し、provider の判定を呼ばない', async () => {
    const { inner, caller, stages, options, onStructuredPromptResolved } = setup('enforce', judgment());

    const result = await caller.judgeStatus('report', 'tag', CANDIDATES, options);

    expect(result).toEqual({ candidateIndex: 0, method: 'jev' });
    expect(inner.judgeStatus).not.toHaveBeenCalled();
    expect(onStructuredPromptResolved).toHaveBeenCalledWith({ systemPrompt: '', userInstruction: 'report' });
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({ stage: 1, method: 'jev', status: 'done' });
    expect(parseResponse(stages[0])).toMatchObject({ decision: 'jev', step: 1, confidence: 0.95 });
  });

  it.each([
    ['low_confidence', judgment({ confidence: 0.5 })],
    ['unsure', judgment({ candidateIndex: undefined })],
    ['jev_error', new Error('timeout')],
  ] as const)('%s のときは provider の判定に任せる', async (reason, result) => {
    const { inner, caller, stages, options } = setup('enforce', result);

    const decided = await caller.judgeStatus('report', 'tag', CANDIDATES, options);

    expect(decided).toEqual({ candidateIndex: 1, method: 'structured_output' });
    expect(inner.judgeStatus).toHaveBeenCalledWith('report', 'tag', CANDIDATES, expect.objectContaining({ cwd: options.cwd }));
    expect(stages[0]).toMatchObject({ method: 'jev', status: 'skipped' });
    expect(parseResponse(stages[0])).toMatchObject({ decision: 'fallback', fallbackReason: reason });
  });

  it('fallback の judge_stage は phase 開始（prompt 解決）の後に記録する', async () => {
    const { inner, caller, options } = setup('enforce', judgment({ confidence: 0.5 }));
    const order: string[] = [];
    options.onStructuredPromptResolved = () => order.push('start');
    options.onJudgeStage = () => order.push('stage');
    inner.judgeStatus.mockImplementation(async (_i, _t, _c, opts: JudgeStatusOptions) => {
      opts.onStructuredPromptResolved?.({ systemPrompt: 's', userInstruction: 'u' });
      return { candidateIndex: 1, method: 'structured_output' };
    });

    await caller.judgeStatus('report', 'tag', CANDIDATES, options);

    expect(order).toEqual(['start', 'stage']);
  });

  it('レポートの結論 REJECT と食い違う選択は採用しない', async () => {
    const { inner, caller, stages, options } = setup('enforce', judgment({ candidateIndex: 0, confidence: 0.99 }));

    await caller.judgeStatus('## 結果: REJECT\n指摘あり', 'tag', CANDIDATES, options);

    expect(inner.judgeStatus).toHaveBeenCalledTimes(1);
    expect(parseResponse(stages[0])).toMatchObject({ fallbackReason: 'verdict_conflict' });
  });

  it('judgeStatus 以外は内側の caller に委譲する', async () => {
    const { inner, caller } = setup('enforce', judgment());

    await caller.evaluateCondition('output', [{ index: 0, text: 'x' }], { cwd: '/tmp' });

    expect(inner.evaluateCondition).toHaveBeenCalledTimes(1);
  });
});

describe('JevStructuredCaller (shadow)', () => {
  it('provider の判定結果を返し、Jev の判定と一致したかを記録する', async () => {
    const { inner, caller, stages, options } = setup('shadow', judgment({ candidateIndex: 1 }));

    const result = await caller.judgeStatus('report', 'tag', CANDIDATES, options);

    expect(result).toEqual({ candidateIndex: 1, method: 'structured_output' });
    expect(inner.judgeStatus).toHaveBeenCalledTimes(1);
    expect(stages[0]).toMatchObject({ method: 'jev', status: 'skipped' });
    expect(parseResponse(stages[0])).toMatchObject({ decision: 'shadow', step: 2, agree: true });
  });

  it('Jev が失敗しても provider の判定結果をそのまま返す', async () => {
    const { caller, stages, options } = setup('shadow', new Error('network'));

    const result = await caller.judgeStatus('report', 'tag', CANDIDATES, options);

    expect(result).toEqual({ candidateIndex: 1, method: 'structured_output' });
    expect(parseResponse(stages[0])).toMatchObject({ decision: 'shadow', agree: null, error: 'Error: network' });
  });
});

describe('createStructuredCaller', () => {
  it('jev 設定がない、または mode が off のときは従来の caller を返す', () => {
    expect(createStructuredCaller(undefined)).toBeInstanceOf(ProviderNeutralStructuredCaller);
    expect(createStructuredCaller({ mode: 'off' })).toBeInstanceOf(ProviderNeutralStructuredCaller);
  });

  it('mode が shadow / enforce のときは JevStructuredCaller を返す', () => {
    expect(createStructuredCaller({ mode: 'shadow' })).toBeInstanceOf(JevStructuredCaller);
    expect(createStructuredCaller({ mode: 'enforce', threshold: 0.9 })).toBeInstanceOf(JevStructuredCaller);
  });
});

describe('contradictsVerdict', () => {
  it.each([
    ['## 結果: REJECT', 'AI特有の問題なし', true],
    ['## 結果: REJECT', 'AI特有の問題あり', false],
    ['## 結果: APPROVE', 'AI特有の問題あり', true],
    ['## 結果: APPROVE', 'AI特有の問題なし', false],
    ['結論の記載なし', 'AI特有の問題なし', false],
    ['## 結果: REJECT', '要件が明確で実装可能', false],
  ])('%s / %s → %s', (instruction, candidate, expected) => {
    expect(contradictsVerdict(instruction, candidate)).toBe(expected);
  });
});

describe('maskJudgeInstruction', () => {
  it('個人・組織を特定できる情報を伏せ、一般語は残す', () => {
    const { text, hits } = maskJudgeInstruction(
      '佐藤先生と山田様へ連絡（a@b.co / 03-1234-5678）。東京中央病院の仕様と同様に対応。https://x.io/a?token=1',
    );

    expect(text).toBe('[PERSON]と[PERSON]へ連絡（[EMAIL] / [PHONE]）。[ORG]の仕様と同様に対応。https://x.io/a?[MASKED]');
    expect(hits).toEqual({ PERSON: 2, EMAIL: 1, PHONE: 1, ORG: 1, URL_QUERY: 1 });
  });
});
