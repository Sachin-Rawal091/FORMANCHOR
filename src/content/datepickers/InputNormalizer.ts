/**
 * Cleans, sanitizes, and normalizes raw values before strategy execution & verification.
 */
export class InputNormalizer {
  /**
   * Basic sanitization: trims leading/trailing whitespace, replaces non-breaking spaces.
   */
  static normalize(value: unknown): string {
    if (value === null || value === undefined) {
      return "";
    }
    if (typeof value === "number") {
      return String(value);
    }
    if (typeof value === "boolean") {
      return value ? "true" : "false";
    }
    const str = String(value);
    return str.replace(/\u00A0/g, " ").trim();
  }

  /**
   * Cleans global currency symbols ($ € £ ₹ ¥ ₩), commas, and spaces from numeric strings.
   */
  static sanitizeNumber(val: string): string {
    if (!val) return "";
    let cleaned = val.replace(/\u00A0/g, "").replace(/\s/g, "");
    cleaned = cleaned.replace(/[$€£₹¥₩]/g, "");
    cleaned = cleaned.replace(/,/g, "");
    return cleaned.trim();
  }

  /**
   * Normalizes a raw value specifically for DOM input assignment based on element type.
   */
  static normalizeForInput(element: HTMLElement | null, value: unknown): string {
    const raw = this.normalize(value);
    if (!raw) return "";

    const isNumberInput =
      element instanceof HTMLInputElement &&
      (element.type === "number" || element.type === "range");

    if (isNumberInput) {
      return this.sanitizeNumber(raw);
    }

    return raw;
  }

  /**
   * Normalizes a value for DOM verification comparison.
   */
  static normalizeForComparison(element: HTMLElement | null, value: unknown): string {
    return this.normalizeForInput(element, value);
  }
}

