import { FillStrategy } from "./FillStrategy";
import { FieldDetectionResult } from "../FieldDetector";
import { DatePickerEngine } from "../DatePickerEngine";
import { DateParser } from "../DateParser";
import { setInputValue, dispatchEvents } from "../../domUtils";
import { DefaultTextStrategy } from "./DefaultTextStrategy";
import { logger } from "../../../utils/logger";

export class DatePickerStrategy implements FillStrategy {
  readonly name = "DatePickerStrategy";

  async execute(el: HTMLElement, rawValue: string, detection: FieldDetectionResult): Promise<boolean> {
    logger.info("DatePickerStrategy", `Executing datepicker fill strategy for value "${rawValue}"`);

    // Parse date to validate calendar sanity upfront
    const parsed = DateParser.parse(rawValue);
    if (!parsed.valid) {
      logger.warn("DatePickerStrategy", `Value "${rawValue}" is not a valid date. Falling back to DefaultTextStrategy.`);
      const defaultTextStrategy = new DefaultTextStrategy();
      return defaultTextStrategy.execute(el, rawValue, detection);
    }

    // Stage 1: Dedicated Adapter Execution via DatePickerEngine
    if (detection.adapter) {
      logger.info("DatePickerStrategy", `[Stage 1] Using dedicated adapter "${detection.adapter.name}"`);
      const engineSuccess = await DatePickerEngine.fill(el, rawValue);
      if (engineSuccess) {
        logger.info("DatePickerStrategy", `[Stage 1] Adapter "${detection.adapter.name}" succeeded.`);
        return true;
      }
      logger.warn("DatePickerStrategy", `[Stage 1] Adapter "${detection.adapter.name}" did not complete fill. Escalating to Stage 2.`);
    }

    // Stage 2: Keyboard Direct Commit Sequence (Native Setter -> Enter -> Blur)
    logger.info("DatePickerStrategy", `[Stage 2] Attempting direct Keyboard Commit sequence.`);
    const inputEl = el instanceof HTMLInputElement ? el : el.querySelector("input");
    if (inputEl instanceof HTMLInputElement) {
      // Format value according to target format or default DD/MM/YYYY
      const formattedVal = parsed.iso ? DateParser.format(parsed, "DD/MM/YYYY") : rawValue;
      setInputValue(inputEl, formattedVal);

      // Dispatch Enter key events
      dispatchEvents(inputEl, ["keydown", "keypress", "keyup"]);
      inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      inputEl.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));

      // Dispatch blur to trigger React/Vue field commit
      dispatchEvents(inputEl, ["blur"]);
      inputEl.blur();

      await new Promise(r => setTimeout(r, 100));

      if (inputEl.value && inputEl.value.trim().length > 0) {
        logger.info("DatePickerStrategy", `[Stage 2] Direct Keyboard Commit sequence succeeded with value "${inputEl.value}"`);
        return true;
      }
    }

    // Stage 3: Calendar Click Fallback via DatePickerEngine
    logger.info("DatePickerStrategy", `[Stage 3] Escalating to Calendar Click fallback.`);
    const fallbackSuccess = await DatePickerEngine.fill(el, rawValue);
    if (fallbackSuccess) {
      logger.info("DatePickerStrategy", `[Stage 3] Calendar Click fallback succeeded.`);
      return true;
    }

    logger.error("DatePickerStrategy", `All fill stages failed for DatePicker element.`);
    return false;
  }
}
