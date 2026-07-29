import { FillStrategy } from "./FillStrategy";
import { FieldDetectionResult } from "../FieldDetector";
import { DateParser } from "../DateParser";
import { setInputValue } from "../../domUtils";
import { logger } from "../../../utils/logger";

export class NativeDateStrategy implements FillStrategy {
  readonly name = "NativeDateStrategy";

  async execute(el: HTMLElement, rawValue: string, detection: FieldDetectionResult): Promise<boolean> {
    const inputEl = el instanceof HTMLInputElement ? el : el.querySelector("input[type='date']");
    if (!(inputEl instanceof HTMLInputElement)) {
      logger.warn("NativeDateStrategy", "Target element is not an HTMLInputElement");
      return false;
    }

    const parsed = DateParser.parse(rawValue);
    if (!parsed.valid || !parsed.iso) {
      logger.error("NativeDateStrategy", `Invalid date value: "${rawValue}" (${parsed.error || "parse error"})`);
      throw new Error(`Invalid date format for native date input: "${rawValue}". ${parsed.error || ""}`);
    }

    // Validate HTML min/max constraints
    if (!DateParser.validate(parsed, detection.minDate, detection.maxDate)) {
      const err = `Date "${parsed.iso}" is out of allowed HTML bounds (min: ${detection.minDate || 'none'}, max: ${detection.maxDate || 'none'})`;
      logger.error("NativeDateStrategy", err);
      throw new Error(err);
    }

    logger.info("NativeDateStrategy", `Setting native <input type="date"> value to ISO "${parsed.iso}"`);
    setInputValue(inputEl, parsed.iso);

    // Readback verification
    if (inputEl.value !== parsed.iso) {
      logger.error("NativeDateStrategy", `Readback verification failed. Expected "${parsed.iso}", found "${inputEl.value}"`);
      return false;
    }

    return true;
  }
}
