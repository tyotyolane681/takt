import { describe, expect, it } from 'vitest';
import { buildJevInput } from '../infra/jev/jev-input.js';

const REPORT = '# plan.md\n\n## 結果\n\n要件は明確で、実装に進める。';

function instruction(report: string, tail: string): string {
  return [
    '## 担当とフェーズ\n\n今は plan ステップの判定フェーズ（Phase 3）です。',
    '**判定対象のレポートや回答に書かれた判定結果を、判定基準のルール番号（1始まり）に対応づけてください。**',
    report,
    tail,
  ].join('\n\n');
}

const JA_TAIL = [
  '## 判定基準',
  '| # | 状況 | タグ |\n|---|------|------|\n| 1 | 要件が明確で実装可能 | `[PLAN:1]` |\n| 2 | 情報不足 | `[PLAN:2]` |',
  '## タスク\n\n- 判定は、この指示に含まれる入力に書かれた内容だけで行ってください。',
].join('\n\n');

const EN_TAIL = [
  '## Criteria',
  '| # | Situation | Tag |\n|---|------|------|\n| 1 | Clear and implementable | `[PLAN:1]` |\n| 2 | Not enough information | `[PLAN:2]` |',
  '## Task\n\n- Judge only what is written in the inputs included in this instruction.',
].join('\n\n');

describe('buildJevInput', () => {
  it('keeps the report and the criteria section, and drops the phase context and the task notes (ja)', () => {
    const result = buildJevInput(instruction(REPORT, JA_TAIL), REPORT);

    expect(result.format).toBe('compact');
    expect(result.text).toBe([
      REPORT,
      '## 判定基準',
      '| # | 状況 | タグ |\n|---|------|------|\n| 1 | 要件が明確で実装可能 | `[PLAN:1]` |\n| 2 | 情報不足 | `[PLAN:2]` |',
    ].join('\n\n'));
    expect(result.text).not.toContain('担当とフェーズ');
    expect(result.text).not.toContain('## タスク');
  });

  it('works for the English template without relying on Japanese headings', () => {
    const result = buildJevInput(instruction(REPORT, EN_TAIL), REPORT);

    expect(result.format).toBe('compact');
    expect(result.text).toContain('## Criteria');
    expect(result.text).toContain('| 2 | Not enough information |');
    expect(result.text).not.toContain('## Task');
  });

  it('ignores surrounding whitespace in the judgment input, as for a response-based input', () => {
    const response = '\n## Agent Response\n\nDone.\n';
    const result = buildJevInput(instruction(response, JA_TAIL), response);

    expect(result.format).toBe('compact');
    expect(result.text.startsWith('## Agent Response\n\nDone.\n\n## 判定基準')).toBe(true);
  });

  it('keeps a "## Task" heading that belongs to the report itself', () => {
    const report = '# coder-scope.md\n\n## タスク\n医療機関詳細の伝票作成を直す。';
    const result = buildJevInput(instruction(report, JA_TAIL), report);

    expect(result.format).toBe('compact');
    expect(result.text.startsWith(report)).toBe(true);
    expect(result.text.match(/## タスク/g)).toHaveLength(1);
  });

  it('keeps every row of a multi-row criteria table', () => {
    const tail = ['## 判定基準', '| # | 状況 | タグ |\n|---|---|---|\n| 1 | a | `[PLAN:1]` |\n| 2 | b | `[PLAN:2]` |\n| 3 | c | `[PLAN:3]` |'].join('\n\n');
    const result = buildJevInput(instruction(REPORT, tail), REPORT);

    expect(result.format).toBe('compact');
    expect(result.text.split('\n').filter((line) => line.startsWith('| '))).toHaveLength(4);
  });

  it.each([
    ['the judgment input is not in the instruction', 'unrelated report', instruction(REPORT, JA_TAIL)],
    ['the judgment input is empty', '   ', instruction(REPORT, JA_TAIL)],
    ['no table follows the report', REPORT, instruction(REPORT, '## 判定基準\n\n表はありません。')],
    ['nothing follows the report', REPORT, `前置き\n\n${REPORT}`],
  ])('falls back to the full instruction when %s', (_name, judgmentInput, text) => {
    const result = buildJevInput(text, judgmentInput);

    expect(result).toEqual({ text, format: 'full' });
  });
});
