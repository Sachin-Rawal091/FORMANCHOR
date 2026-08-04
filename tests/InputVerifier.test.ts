import { describe, it, expect, beforeEach } from "vitest";
import { InputNormalizer } from "../src/content/datepickers/InputNormalizer";
import { InputVerifier } from "../src/content/InputVerifier";

describe("InputNormalizer & InputVerifier Unit Tests", () => {
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
  });

  describe("InputVerifier", () => {
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

    it("should verify formatted currency and numeric values for type=text inputs", () => {
      textInput.value = "284.45";

      // Currency symbol in rawValue
      const resCurrency = InputVerifier.verify(textInput, "₹284.45");
      expect(resCurrency.pass).toBe(true);

      // Trailing decimal in rawValue
      const resDecimal = InputVerifier.verify(textInput, "284.450");
      expect(resDecimal.pass).toBe(true);
    });

    it("should verify DOM thousand comma auto-formatting for type=text inputs", () => {
      textInput.value = "1,000";

      // Plain number in Excel vs thousand comma in DOM
      const resComma = InputVerifier.verify(textInput, "1000");
      expect(resComma.pass).toBe(true);
    });

    it("should strictly enforce leading zeros on plain digit IDs and PIN codes for type=text inputs", () => {
      textInput.value = "62100";

      // Account number / PIN code with leading zero dropped in Excel
      const resID = InputVerifier.verify(textInput, "062100");
      expect(resID.pass).toBe(false);
    });

    it("should fail verification if text input is left empty on DOM even if rawValue sanitizes to zero", () => {
      textInput.value = "";

      const resEmpty = InputVerifier.verify(textInput, "$0.00");
      expect(resEmpty.pass).toBe(false);
    });
  });
});
