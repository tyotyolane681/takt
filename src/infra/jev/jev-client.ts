/**
 * Jev (TypeSafe) adapter used by JevStructuredCaller to pick a status-judgment candidate.
 * The API key is read by the SDK from TYPESAFE_API_KEY.
 */
import { choice, TypeSafeClient } from '@typesafe-ai/sdk';
import { maskJudgeInstruction } from './jev-mask.js';

export const DEFAULT_JEV_MODEL = 'jev-1.13.0';
const DEFAULT_TIMEOUT_MS = 2000;
const UNSURE_LABEL = 'unsure';

const QUESTION =
  'The state is the output of one step in an AI coding workflow, followed by a table of judgment rules. ' +
  'Pick the rule whose condition matches the outcome stated in the report. ' +
  'If the report explicitly states a verdict (e.g. APPROVE or REJECT), follow that verdict. ' +
  `Choose "${UNSURE_LABEL}" if the report does not clearly support any single rule.`;

export interface JevCandidate {
  /** 0-based candidate index as passed to judgeStatus */
  index: number;
  description: string;
}

export interface JevJudgment {
  /** 0-based candidate index, or undefined when Jev answered "unsure" */
  candidateIndex: number | undefined;
  confidence: number;
  probabilities: Record<string, number>;
  model: string;
  latencyMs: number;
  maskHits: Record<string, number>;
}

export interface JevJudge {
  judge(instruction: string, candidates: JevCandidate[]): Promise<JevJudgment>;
}

export interface TypeSafeJevJudgeOptions {
  model?: string;
  timeoutMs?: number;
}

const labelOf = (index: number): string => `rule_${index + 1}`;

export function createTypeSafeJevJudge(options: TypeSafeJevJudgeOptions = {}): JevJudge {
  let client: TypeSafeClient | undefined;
  const model = options.model ?? DEFAULT_JEV_MODEL;

  return {
    async judge(instruction, candidates) {
      client ??= new TypeSafeClient({ timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, retry: { maxRetries: 0 } });
      const criteria: Record<string, string> = Object.fromEntries(
        candidates.map((c) => [labelOf(c.index), c.description]),
      );
      criteria[UNSURE_LABEL] = 'None of the rules is clearly supported by the report.';
      const { text, hits } = maskJudgeInstruction(instruction);

      const started = performance.now();
      const response = await client.systemOne({
        model,
        state: text,
        questions: { rule: choice(QUESTION, criteria) },
      });
      const answer = response.answers.rule;
      const chosen = candidates.find((c) => labelOf(c.index) === answer.choice);
      return {
        candidateIndex: chosen?.index,
        confidence: answer.confidence,
        probabilities: { ...answer.probabilities } as Record<string, number>,
        model: response.model,
        latencyMs: Math.round(performance.now() - started),
        maskHits: hits,
      };
    },
  };
}
