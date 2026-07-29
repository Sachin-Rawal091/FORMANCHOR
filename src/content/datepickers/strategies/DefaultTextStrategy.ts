import { FillStrategy } from "./FillStrategy";
import { FieldDetectionResult } from "../FieldDetector";
import { setInputValue, setTextareaValue, dispatchEvents } from "../../domUtils";
import { InputVerifier } from "../../InputVerifier";
import { logger } from "../../../utils/logger";

export class DefaultTextStrategy implements FillStrategy {
  readonly name = "DefaultTextStrategy";

  async execute(el: HTMLElement, rawValue: string, _detection: FieldDetectionResult): Promise<boolean> {
    logger.info("DefaultTextStrategy", `Filling element with raw value "${rawValue}"`);

    if (el instanceof HTMLInputElement) {
      setInputValue(el, rawValue);
    } else if (el instanceof HTMLTextAreaElement) {
      setTextareaValue(el, rawValue);
    } else {
      const nestedInput = el.querySelector("input, textarea") as HTMLInputElement | HTMLTextAreaElement | null;
      if (nestedInput) {
        if (nestedInput instanceof HTMLInputElement) {
          setInputValue(nestedInput, rawValue);
        } else {
          setTextareaValue(nestedInput, rawValue);
        }
      } else {
        // Fallback for contenteditable or generic elements
        el.focus();
        el.textContent = rawValue;
        dispatchEvents(el, ["input", "change", "blur"]);
      }
    }

    const verification = InputVerifier.verify(el, rawValue);
    logger.info(
      "DefaultTextStrategy",
      `Verification -> Expected: "${verification.expected}" | Normalized: "${verification.normalized}" | Actual: "${verification.actual}" | Status: ${verification.pass ? "PASS" : "FAIL"}`
    );

    return verification.pass;
  }
}

