import type { Bloom } from "./bloom";

// Match words consisting of Unicode letters with optional apostrophes or hyphens
export const WORD_REGEX = /[\p{L}\p{M}\p{N}_]+(?:['\u2019-][\p{L}\p{M}\p{N}_]+)*/gu;
const PLAIN_WORD_REGEX = /^[A-Za-z]+(?:['-][A-Za-z]+)*$/;

export function makeChecker(bloom: Bloom) {
  const memo = new Map<string, boolean>();

  return function isWordValid(raw: string): boolean {
    const normalized = raw.normalize("NFC").replace(/\u2019/g, "'");

    // Skip tokens with numbers, URLs, or non-alphabetic characters
    if (!PLAIN_WORD_REGEX.test(normalized)) {
      return true;
    }

    // Skip acronyms / all-caps words (e.g. "NASA", "API", "CPU")
    if (normalized.length > 1 && normalized === normalized.toUpperCase()) {
      return true;
    }

    const key = normalized.toLowerCase();
    let valid = memo.get(key);
    if (valid === undefined) {
      valid = bloom.has(key);
      if (memo.size > 50_000) {
        memo.clear();
      }
      memo.set(key, valid);
    }

    return valid;
  };
}
