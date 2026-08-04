import { FillStrategy } from "./FillStrategy";
import { FieldDetectionResult } from "../FieldDetector";
import { DatePickerEngine } from "../DatePickerEngine";
import { DateParser } from "../DateParser";
import { setInputValue, dispatchEvents } from "../../domUtils";
import { DefaultTextStrategy } from "./DefaultTextStrategy";
import { SmartWaitEngine } from "../../engines/SmartWaitEngine";
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
      // Detect target format dynamically from element placeholder / attributes
      const detectedFormat = DateParser.detectElementDateFormat(inputEl) || "DD/MM/YYYY";
      const formattedVal = parsed.iso ? DateParser.format(parsed, detectedFormat) : rawValue;

      // 1. Focus & open picker container so React/AntD/MUI/RMDP mounts component listeners
      inputEl.focus();
      const container = inputEl.closest('.ant-picker, .ant-picker-input, .MuiInputBase-root, .MuiFormControl-root, .rmdp-container, .datepicker, .date-picker, [class*="picker"]');
      if (container) {
        dispatchEvents(container as HTMLElement, ["mousedown", "mouseup", "click"]);
        await SmartWaitEngine.waitForCondition(() => {
          const popup = document.querySelector('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden), .MuiPickersPopper-root, .rmdp-ep, [class*="popper"], [class*="picker"]');
          return popup ? true : null;
        }, 1000).catch(() => null);
      }

      setInputValue(inputEl, formattedVal);

      // 2. Dispatch full Enter key sequence via centralized dispatchEvents
      dispatchEvents(inputEl, ["keydown", "keypress", "keyup"], {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        charCode: 13,
      });

      // 3. Post-blur intrinsic value persistence verification
      dispatchEvents(inputEl, ["blur", "focusout"]);
      inputEl.blur();

      const committed = await SmartWaitEngine.waitForCondition(() => {
        const valuePersisted = inputEl.value.trim() === formattedVal.trim();
        if (valuePersisted) {
          if (inputEl.closest('.ant-form-item-has-error')) {
            logger.warn("DatePickerStrategy", "[Stage 2] Value persisted post-blur, but ant-form-item-has-error class still present.");
          }
          return true;
        }
        return null;
      }, 1000).catch(() => null);

      if (committed) {
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
