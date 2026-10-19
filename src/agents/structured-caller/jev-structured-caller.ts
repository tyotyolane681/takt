import type { SemanticRuleCandidate } from '../../core/models/workflow-rule-condition.js';
import type { JevConfig } from '../../core/models/config-types.js';
import { createTypeSafeJevJudge, type JevCandidate, type JevJudge, type JevJudgment } from '../../infra/jev/jev-client.js';
import type { JudgeStatusOptions, JudgeStatusResult, EvaluateConditionOptions } from '../judge-status-usecase.js';
import type {
  DecomposeTaskOptions,
  DecomposeTaskResponse,
  MorePartsOptions,
  MorePartsResponse,
  TeamLeaderPartFeedbackResult,
} from '../decompose-task-usecase.js';
import type { StructuredCaller } from './contracts.js';
import { ProviderNeutralStructuredCaller } from './provider-neutral-structured-caller.js';

export const DEFAULT_JEV_THRESHOLD = 0.8;

export type JevFallbackReason = 'jev_error' | 'unsure' | 'low_confidence' | 'verdict_conflict';

export interface JevStructuredCallerOptions {
  /** shadow: record Jev's choice only. enforce: adopt Jev's choice when confident enough. */
  mode: 'shadow' | 'enforce';
  threshold: number;
  judge: JevJudge;
}

const VERDICT = /##\s*結果[:：]\s*\**\s*(APPROVE|REJECT)/;
const APPROVE_WORDS = /(なし|問題なし|承認|完了|APPROVE|OK)/;
const REJECT_WORDS = /(あり|問題あり|差し戻|修正が必要|REJECT|NG)/;

/**
 * True when the report states an explicit APPROVE/REJECT verdict that the chosen candidate contradicts.
 * A machine-readable verdict in the report wins over Jev.
 */
export function contradictsVerdict(instruction: string, candidateText: string): boolean {
  const verdict = VERDICT.exec(instruction)?.[1];
  if (verdict === undefined) return false;
  const approveLike = APPROVE_WORDS.test(candidateText) && !REJECT_WORDS.test(candidateText);
  const rejectLike = REJECT_WORDS.test(candidateText) && !APPROVE_WORDS.test(candidateText);
  return (verdict === 'REJECT' && approveLike) || (verdict === 'APPROVE' && rejectLike);
}

function describeCandidate(candidate: SemanticRuleCandidate): string {
  return candidate.appendix === undefined ? candidate.label : `${candidate.label}\n${candidate.appendix}`;
}

type JevOutcome = { judgment: JevJudgment } | { error: string };

/**
 * Wraps another StructuredCaller and answers status judgments with Jev (TypeSafe).
 * Only judgeStatus is affected; Jev failures always fall back to the wrapped caller.
 */
export class JevStructuredCaller implements StructuredCaller {
  constructor(
    private readonly inner: StructuredCaller,
    private readonly options: JevStructuredCallerOptions,
  ) {}

  async judgeStatus(
    structuredInstruction: string,
    tagInstruction: string,
    candidates: SemanticRuleCandidate[],
    options: JudgeStatusOptions,
  ): Promise<JudgeStatusResult> {
    const jevCandidates: JevCandidate[] = candidates.map((candidate, index) => ({
      index,
      description: describeCandidate(candidate),
    }));
    const pending = this.askJev(structuredInstruction, jevCandidates);
    const delegate = (): Promise<JudgeStatusResult> =>
      this.inner.judgeStatus(structuredInstruction, tagInstruction, candidates, options);

    if (this.options.mode === 'shadow') {
      const result = await delegate();
      const outcome = await pending;
      this.recordStage(options, structuredInstruction, 'skipped', { decision: 'shadow', ...summarize(outcome), agree: agreesWith(outcome, result) });
      return result;
    }

    const outcome = await pending;
    options.abortSignal?.throwIfAborted();
    const fallbackReason = this.fallbackReasonFor(outcome, structuredInstruction, jevCandidates);
    if (fallbackReason === undefined && 'judgment' in outcome && outcome.judgment.candidateIndex !== undefined) {
      // Mirror the single-candidate path: phase start is recorded even though no provider prompt runs.
      options.onStructuredPromptResolved?.({ systemPrompt: '', userInstruction: structuredInstruction });
      this.recordStage(options, structuredInstruction, 'done', { decision: 'jev', ...summarize(outcome) });
      return { candidateIndex: outcome.judgment.candidateIndex, method: 'jev' };
    }

    // The phase start is emitted when the delegate resolves its prompt, and a judge stage
    // recorded before it has no originating phase. Defer the fallback record until then.
    let didRecordFallback = false;
    const recordFallback = (): void => {
      if (didRecordFallback) return;
      didRecordFallback = true;
      this.recordStage(options, structuredInstruction, 'skipped', { decision: 'fallback', fallbackReason, ...summarize(outcome) });
    };
    const result = await this.inner.judgeStatus(structuredInstruction, tagInstruction, candidates, {
      ...options,
      onStructuredPromptResolved: (promptParts) => {
        options.onStructuredPromptResolved?.(promptParts);
        recordFallback();
      },
    });
    recordFallback();
    return result;
  }

  evaluateCondition(
    agentOutput: string,
    conditions: Array<{ index: number; text: string }>,
    options: EvaluateConditionOptions,
  ): Promise<number> {
    return this.inner.evaluateCondition(agentOutput, conditions, options);
  }

  decomposeTask(
    instruction: string,
    maxInitialParts: number | undefined,
    options: DecomposeTaskOptions,
  ): Promise<DecomposeTaskResponse> {
    return this.inner.decomposeTask(instruction, maxInitialParts, options);
  }

  requestMoreParts(
    originalInstruction: string,
    allResults: TeamLeaderPartFeedbackResult[],
    existingIds: string[],
    options: MorePartsOptions,
  ): Promise<MorePartsResponse> {
    return this.inner.requestMoreParts(originalInstruction, allResults, existingIds, options);
  }

  private askJev(instruction: string, candidates: JevCandidate[]): Promise<JevOutcome> {
    return this.options.judge.judge(instruction, candidates).then(
      (judgment) => ({ judgment }),
      (error: unknown) => ({ error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }),
    );
  }

  private fallbackReasonFor(
    outcome: JevOutcome,
    instruction: string,
    candidates: JevCandidate[],
  ): JevFallbackReason | undefined {
    if ('error' in outcome) return 'jev_error';
    const { candidateIndex, confidence } = outcome.judgment;
    const chosen = candidates.find((c) => c.index === candidateIndex);
    if (chosen === undefined) return 'unsure';
    if (!(confidence >= this.options.threshold)) return 'low_confidence';
    if (contradictsVerdict(instruction, chosen.description)) return 'verdict_conflict';
    return undefined;
  }

  private recordStage(
    options: JudgeStatusOptions,
    instruction: string,
    status: 'done' | 'skipped',
    detail: Record<string, unknown>,
  ): void {
    options.onJudgeStage?.({
      stage: 1,
      method: 'jev',
      status,
      instruction,
      response: JSON.stringify({ threshold: this.options.threshold, ...detail }),
    });
  }
}

function summarize(outcome: JevOutcome): Record<string, unknown> {
  if ('error' in outcome) return { error: outcome.error };
  const { candidateIndex, confidence, model, latencyMs, maskHits } = outcome.judgment;
  return {
    step: candidateIndex === undefined ? null : candidateIndex + 1,
    confidence,
    model,
    latencyMs,
    ...(Object.keys(maskHits).length > 0 ? { maskHits } : {}),
  };
}

function agreesWith(outcome: JevOutcome, result: JudgeStatusResult): boolean | null {
  if ('error' in outcome || outcome.judgment.candidateIndex === undefined) return null;
  return outcome.judgment.candidateIndex === result.candidateIndex;
}

/** Builds the StructuredCaller for a workflow run from the global `jev` config. */
export function createStructuredCaller(jev: JevConfig | undefined): StructuredCaller {
  const base = new ProviderNeutralStructuredCaller();
  const mode = jev?.mode ?? 'off';
  if (mode === 'off') return base;
  return new JevStructuredCaller(base, {
    mode,
    threshold: jev?.threshold ?? DEFAULT_JEV_THRESHOLD,
    judge: createTypeSafeJevJudge({ model: jev?.model }),
  });
}
