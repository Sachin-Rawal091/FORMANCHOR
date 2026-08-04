import { InputNormalizer } from "./datepickers/InputNormalizer";

export interface VerificationResult {
  pass: boolean;
  expected: string;
  normalized: string;
  actual: string;
}

/**
 * Single authority for verifying DOM element field values post-execution.
 */
export class InputVerifier {
  static verify(element: HTMLElement, rawValue: string): VerificationResult {
    const normalized = InputNormalizer.normalizeForComparison(element, rawValue);
    
    let actual = "";
    let targetEl: HTMLElement = element;

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      actual = element.value || "";
      targetEl = element;
    } else {
      const nested = element.querySelector("input, textarea, select") as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
      if (nested) {
        actual = nested.value || "";
        targetEl = nested;
      } else {
        actual = element.textContent?.trim() || "";
      }
    }

    const isNumberInput =
      targetEl instanceof HTMLInputElement &&
      (targetEl.type === "number" || targetEl.type === "range");

    let pass = false;

    if (isNumberInput) {
      const numActual = Number(InputNormalizer.sanitizeNumber(actual));
      const numNormalized = Number(normalized);
      if (!isNaN(numActual) && !isNaN(numNormalized)) {
        pass = numActual === numNormalized;
      } else {
        pass = actual === normalized;
      }
    } else {
      pass = actual === normalized;

      // Smart fallback for <input type="text"> with formatted numbers or currency symbols
      if (!pass && targetEl instanceof HTMLInputElement && targetEl.type === "text") {
        const formatRegex = /[$€£₹¥₩]|,|\.\d/;
        const looksFormattedNumeric = formatRegex.test(rawValue) || formatRegex.test(actual);

        if (looksFormattedNumeric && actual.trim() !== "") {
          const sanitizedActual = InputNormalizer.sanitizeNumber(actual);
          const sanitizedNormalized = InputNormalizer.sanitizeNumber(normalized);
          if (sanitizedActual && sanitizedNormalized) {
            const numActual = Number(sanitizedActual);
            const numNormalized = Number(sanitizedNormalized);
            if (!isNaN(numActual) && !isNaN(numNormalized)) {
              pass = Math.abs(numActual - numNormalized) < 0.001;
            }
          }
        }
      }
    }

    return {
      pass,
      expected: rawValue,
      normalized,
      actual
    };
  }
}
