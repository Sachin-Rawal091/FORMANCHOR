import { describe, it, expect, beforeEach } from "vitest";
import { InputNormalizer } from "../src/content/datepickers/InputNormalizer";
import { InputVerifier } from "../src/content/InputVerifier";

describe("InputNormalizer & InputVerifier Unit Tests (Audited)", () => {
  let numInput: HTMLInputElement;
  let textInput: HTMLInputElement;

  beforeEach(() => {
    numInput = document.createElement("input");
    numInput.type = "number";

    textInput = document.createElement("input");
    textInput.type = "text";
  });

  describe("InputNormalizer", () => {
    it("should sanitize global currency symbols and thousand commas", () => {
      expect(InputNormalizer.sanitizeNumber("$95,980")).toBe("95980");
      expect(InputNormalizer.sanitizeNumber("₹95,980")).toBe("95980");
      expect(InputNormalizer.sanitizeNumber("€95,980")).toBe("95980");
      expect(InputNormalizer.sanitizeNumber("£95 980")).toBe("95980");
      expect(InputNormalizer.sanitizeNumber("95\u00A0980")).toBe("95980");
    });

    it("should normalize value based on input element type", () => {
      expect(InputNormalizer.normalizeForInput(numInput, "$95,980")).toBe("95980");
      expect(InputNormalizer.normalizeForInput(textInput, " $95,980 ")).toBe("$95,980");
    });

    it("should perform EPSILON-safe, sign-preserving truncation (truncate2)", () => {
      expect(InputNormalizer.truncate2(438.615)).toBe(438.61);
      expect(InputNormalizer.truncate2(-438.615)).toBe(-438.61);
      expect(InputNormalizer.truncate2(438.619)).toBe(438.61);
      expect(InputNormalizer.truncate2(438.611)).toBe(438.61);
      expect(InputNormalizer.truncate2(438)).toBe(438);
    });

    it("should perform EPSILON-safe rounding (round2)", () => {
      expect(InputNormalizer.round2(438.615)).toBe(438.62);
      expect(InputNormalizer.round2(-438.615)).toBe(-438.62);
      expect(InputNormalizer.round2(438.611)).toBe(438.61);
      expect(InputNormalizer.round2(1.005)).toBe(1.01);
    });

    it("should compare monetary values accurately under policy modes", () => {
      // Truncation policy
      expect(InputNormalizer.compareMonetary(438.61, 438.615, "truncate")).toBe(true);
      expect(InputNormalizer.compareMonetary(438.62, 438.615, "truncate")).toBe(false);

      // Round policy
      expect(InputNormalizer.compareMonetary(438.62, 438.615, "round")).toBe(true);
      expect(InputNormalizer.compareMonetary(438.61, 438.615, "round")).toBe(false);

      // Auto policy (accepts Tier 1 exact, Tier 2 rounded, Tier 3 truncated, or Tier 4 1-cent fallback)
      expect(InputNormalizer.compareMonetary(438.615, 438.615, "auto")).toBe(true); // Tier 1: Exact
      expect(InputNormalizer.compareMonetary(438.62, 438.615, "auto")).toBe(true);  // Tier 2: Rounded
      expect(InputNormalizer.compareMonetary(438.61, 438.615, "auto")).toBe(true);  // Tier 3: Truncated
      expect(InputNormalizer.compareMonetary(438.61, 438.62, "auto")).toBe(true);   // Tier 4: 1-Cent Fallback
      expect(InputNormalizer.compareMonetary(438.99, 438.615, "auto")).toBe(false); // Fail
    });
  });

  describe("InputVerifier Matrix", () => {
    it("should verify 3-decimal raw Excel values against 2-decimal truncated portal inputs (438.615 vs 438.61)", () => {
      textInput.value = "438.61";
      const res = InputVerifier.verify(textInput, "438.615");
      expect(res.pass).toBe(true);
    });

    it("should verify 3-decimal raw Excel values against 2-decimal rounded portal inputs (438.615 vs 438.62)", () => {
      textInput.value = "438.62";
      const res = InputVerifier.verify(textInput, "438.615");
      expect(res.pass).toBe(true);
    });

    it("should verify negative truncated values (-438.615 vs -438.61)", () => {
      textInput.value = "-438.61";
      const res = InputVerifier.verify(textInput, "-438.615");
      expect(res.pass).toBe(true);
    });

    it("should verify exact integer values (438 vs 438)", () => {
      textInput.value = "438";
      const res = InputVerifier.verify(textInput, "438");
      expect(res.pass).toBe(true);
    });

    it("should verify currency prefixes with truncated decimals (₹438.615 vs 438.61)", () => {
      textInput.value = "438.61";
      const res = InputVerifier.verify(textInput, "₹438.615");
      expect(res.pass).toBe(true);
    });

    it("should verify exact decimals (438.615 vs 438.615)", () => {
      textInput.value = "438.615";
      const res = InputVerifier.verify(textInput, "438.615");
      expect(res.pass).toBe(true);
    });

    it("should fail verification for wrong numbers (438.615 vs 438.99)", () => {
      textInput.value = "438.99";
      const res = InputVerifier.verify(textInput, "438.615");
      expect(res.pass).toBe(false);
    });

    it("should strictly enforce leading zeros on PIN codes and Account IDs (062100 vs 62100 -> FAIL)", () => {
      textInput.value = "62100";
      const resID = InputVerifier.verify(textInput, "062100");
      expect(resID.pass).toBe(false);
    });

    it("should verify formatted numbers against type=number input values", () => {
      numInput.value = "95980";

      const resCurrency = InputVerifier.verify(numInput, "$95,980");
      expect(resCurrency.pass).toBe(true);
      expect(resCurrency.normalized).toBe("95980");
      expect(resCurrency.actual).toBe("95980");

      const resRupee = InputVerifier.verify(numInput, "₹95,980");
      expect(resRupee.pass).toBe(true);
    });

    it("should handle leading zeros semantically for numeric inputs", () => {
      numInput.value = "95980";

      const resLeadingZero = InputVerifier.verify(numInput, "095980");
      expect(resLeadingZero.pass).toBe(true);
      expect(resLeadingZero.actual).toBe("95980");
    });

    it("should handle decimal equivalence for numeric inputs", () => {
      numInput.value = "95980";

      const resDecimal = InputVerifier.verify(numInput, "95980.00");
      expect(resDecimal.pass).toBe(true);
    });

    it("should perform strict comparison for text inputs", () => {
      textInput.value = "Jane Doe";

      const resTextPass = InputVerifier.verify(textInput, "Jane Doe");
      expect(resTextPass.pass).toBe(true);

      const resTextFail = InputVerifier.verify(textInput, "John Doe");
      expect(resTextFail.pass).toBe(false);
    });

    it("should verify DOM thousand comma auto-formatting for type=text inputs", () => {
      textInput.value = "1,000";

      const resComma = InputVerifier.verify(textInput, "1000");
      expect(resComma.pass).toBe(true);
    });

    it("should fail verification if text input is left empty on DOM even if rawValue sanitizes to zero", () => {
      textInput.value = "";

      const resEmpty = InputVerifier.verify(textInput, "$0.00");
      expect(resEmpty.pass).toBe(false);
    });

    it("should verify date equivalence when Excel DD/MM/YYYY matches DOM ISO YYYY-MM-DD", () => {
      textInput.value = "1998-08-15";

      const resDate = InputVerifier.verify(textInput, "15/08/1998");
      expect(resDate.pass).toBe(true);
    });

    it("should verify ambiguous dates correctly using the provided formatHint", () => {
      textInput.value = "2026-08-04";

      const resAmbiguous = InputVerifier.verify(textInput, "08/04/2026", "MM/DD/YYYY");
      expect(resAmbiguous.pass).toBe(true);
    });

    it("should fail verification when dates represent different calendar days", () => {
      textInput.value = "2026-09-20";

      const resMismatch = InputVerifier.verify(textInput, "15/08/1998");
      expect(resMismatch.pass).toBe(false);
    });

    it("should safely ignore non-date strings without throwing or false positives", () => {
      textInput.value = "2025-2026";

      const resAcademic = InputVerifier.verify(textInput, "2025-2026");
      expect(resAcademic.pass).toBe(true);

      textInput.value = "2024-2025";
      const resDiff = InputVerifier.verify(textInput, "2025-2026");
      expect(resDiff.pass).toBe(false);
    });
  });
});
