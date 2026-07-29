import { logger } from "../../utils/logger";

export interface MatchResult {
  option: HTMLOptionElement | null;
  strategy: "EXACT" | "PREFIX" | "WHOLE_WORD" | "NONE";
  confidence: number;
  matchedText: string;
}

interface NormalizedOption {
  option: HTMLOptionElement;
  normValue: string;
  normText: string;
}

export class DropdownMatcher {
  static normalize(str: string): string {
    return (str || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  static match(select: HTMLSelectElement, targetValue: string): MatchResult {
    const normalizedTarget = this.normalize(targetValue);
    
    if (!normalizedTarget) {
      return { option: null, strategy: "NONE", confidence: 0, matchedText: "" };
    }

    // Cache normalized options for performance O(N)
    const options: NormalizedOption[] = Array.from(select.options).map(opt => ({
      option: opt,
      normValue: this.normalize(opt.value),
      normText: this.normalize(opt.text)
    }));

    // Stage 1: Exact Match (100% confidence)
    const exactMatch = this.findExactMatch(options, normalizedTarget);
    if (exactMatch) {
      return { option: exactMatch.option, strategy: "EXACT", confidence: 100, matchedText: exactMatch.matchedText };
    }

    // Stage 2: Prefix Match (95% confidence)
    const prefixMatch = this.findPrefixMatch(options, normalizedTarget, targetValue);
    if (prefixMatch) {
      return { option: prefixMatch.option, strategy: "PREFIX", confidence: 95, matchedText: prefixMatch.matchedText };
    }

    // Stage 3: Whole Word Match (90% confidence)
    const wordMatch = this.findWholeWordMatch(options, normalizedTarget, targetValue);
    if (wordMatch) {
      return { option: wordMatch.option, strategy: "WHOLE_WORD", confidence: 90, matchedText: wordMatch.matchedText };
    }

    logger.warn('DropdownMatcher', `No dropdown option matched for "${targetValue}".`);
    return { option: null, strategy: "NONE", confidence: 0, matchedText: "" };
  }

  private static findExactMatch(options: NormalizedOption[], target: string) {
    for (const opt of options) {
      if (opt.normValue === target) return { option: opt.option, matchedText: opt.option.value };
      if (opt.normText === target) return { option: opt.option, matchedText: opt.option.text };
    }
    return null;
  }

  private static findPrefixMatch(options: NormalizedOption[], target: string, originalTarget: string) {
    const matches = options.filter(opt => 
      opt.normValue.startsWith(target) || opt.normText.startsWith(target)
    );
    
    // Exact match handling was done in pass 1.
    // If multiple options share the same prefix (e.g., "California" and "Canada" for "CA")
    if (matches.length === 1) {
      const match = matches[0];
      const matchedText = match.normValue.startsWith(target) ? match.option.value : match.option.text;
      return { option: match.option, matchedText };
    }
    
    if (matches.length > 1) {
      logger.warn('DropdownMatcher', `Ambiguous dropdown match for "${originalTarget}" at PREFIX stage (candidates: ${matches.map(m => m.option.text).join(", ")}).`);
    }
    return null;
  }

  private static findWholeWordMatch(options: NormalizedOption[], target: string, originalTarget: string) {
    const isTokenMatch = (text: string, tokenTarget: string) => {
      // Escape special regex characters
      const escapedTarget = tokenTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Match boundaries where surrounding characters are not letters/numbers
      const regex = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapedTarget}(?:[^\\p{L}\\p{N}]|$)`, 'iu');
      return regex.test(text);
    };

    const matches = options.filter(opt => 
      isTokenMatch(opt.normValue, target) || isTokenMatch(opt.normText, target)
    );

    if (matches.length === 1) {
      const match = matches[0];
      const matchedText = isTokenMatch(match.normValue, target) ? match.option.value : match.option.text;
      return { option: match.option, matchedText };
    }
    
    if (matches.length > 1) {
      logger.warn('DropdownMatcher', `Ambiguous dropdown match for "${originalTarget}" at WHOLE_WORD stage (candidates: ${matches.map(m => m.option.text).join(", ")}).`);
    }
    return null;
  }
}
