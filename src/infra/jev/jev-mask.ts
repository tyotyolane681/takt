/**
 * Masks personal and organization identifiers before a judge instruction is sent to Jev.
 * Judge instructions carry review reports, which can quote seeded/demo data from the target project.
 */

interface MaskPattern {
  name: string;
  pattern: RegExp;
  replace?: (match: string, ...groups: string[]) => string;
  skip?: (match: string) => boolean;
}

const COMMON_WORDS_ENDING_WITH_SAMA = /(仕|同|多|模|有|一|異|態|左|斯)様$/;

const MASK_PATTERNS: MaskPattern[] = [
  { name: 'EMAIL', pattern: /[\w.+-]+@[\w-]+\.[\w.]+/g },
  { name: 'PHONE', pattern: /0\d{1,3}-\d{2,4}-\d{3,4}/g },
  { name: 'URL_QUERY', pattern: /(https?:\/\/[^\s?#|)]+)\?[^\s|)]*/g, replace: (_m, base = '') => `${base}?[MASKED]` },
  { name: 'URL_CRED', pattern: /(https?:\/\/)[^\s/@|]+:[^\s/@|]+@/g, replace: (_m, scheme = '') => `${scheme}[MASKED]@` },
  { name: 'TOKEN', pattern: /\b(sk-[\w-]{10,}|ghp_\w{20,}|gho_\w{20,}|xox[abp]-[\w-]{10,}|[0-9a-f]{32,})\b/g },
  { name: 'ORG', pattern: /[^\s|`'"「」（）()、。:：]{1,15}(病院|医院|クリニック|診療所)/g },
  { name: 'ORG', pattern: /(株式会社|有限会社)[^\s|`'"「」（）()、。]{1,15}|[^\s|`'"「」（）()、。]{1,15}(株式会社|有限会社)/g },
  { name: 'PERSON', pattern: /[一-龥]{1,4}\s?(先生|医師)(?![一-龥])/g },
  { name: 'PERSON', pattern: /[一-龥]{1,4}様(?![一-龥])/g, skip: (m) => COMMON_WORDS_ENDING_WITH_SAMA.test(m) },
];

export interface MaskResult {
  text: string;
  hits: Record<string, number>;
}

export function maskJudgeInstruction(text: string): MaskResult {
  const hits: Record<string, number> = {};
  let masked = text;
  for (const { name, pattern, replace, skip } of MASK_PATTERNS) {
    masked = masked.replace(pattern, (match: string, ...groups: string[]) => {
      if (skip?.(match)) return match;
      hits[name] = (hits[name] ?? 0) + 1;
      return replace ? replace(match, ...groups) : `[${name}]`;
    });
  }
  return { text: masked, hits };
}
