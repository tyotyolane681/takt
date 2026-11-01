/**
 * Builds the text Jev receives as its `state` from a status-judgment instruction.
 *
 * The full instruction is "phase context + report + criteria heading and table + task notes".
 * Jev already gets the rules as its choices, and the phase context and task notes are written for an
 * agent that reads and answers in prose. Measured on the labelled judgments, handing Jev only the
 * report followed by the criteria table is more confident on correct picks and less confident on
 * wrong ones than handing it the full instruction.
 */

export type JevInputFormat = 'compact' | 'full';

export interface JevInput {
  text: string;
  format: JevInputFormat;
}

/** A heading line, a blank line, then the contiguous rows of a markdown table. */
const CRITERIA_SECTION = /^\s*\n(#{1,6}[^\n]*)\n\s*\n((?:\|[^\n]*(?:\n|$))+)/;

/**
 * Returns the report followed by the criteria section (heading and table), without the phase
 * context before the report or the task notes after the table.
 * Falls back to the full instruction when the report cannot be located or no table follows it,
 * so a changed prompt template degrades to the previous behaviour instead of breaking.
 */
export function buildJevInput(instruction: string, judgmentInput: string): JevInput {
  const full: JevInput = { text: instruction, format: 'full' };
  const report = judgmentInput.trim();
  if (report.length === 0) return full;

  const start = instruction.indexOf(report);
  if (start < 0) return full;

  const section = CRITERIA_SECTION.exec(instruction.slice(start + report.length));
  if (section === null) return full;

  const [, heading = '', table = ''] = section;
  return { text: `${report}\n\n${heading.trim()}\n\n${table.trim()}`, format: 'compact' };
}
